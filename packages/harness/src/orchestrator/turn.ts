import { randomUUID } from "node:crypto";
import type { AgentEvent, Message } from "@poncho-ai/sdk";
import type { Conversation } from "../state.js";
import type { AgentHarness } from "../harness.js";
import { isMessageArray } from "./history.js";

// ── Types ──

export type StoredApproval = NonNullable<Conversation["pendingApprovals"]>[number];
export type PendingToolCall = { id: string; name: string; input: Record<string, unknown> };
export type ApprovalEventItem = {
  approvalId: string;
  tool: string;
  toolCallId?: string;
  input: Record<string, unknown>;
};

export type TurnSection = { type: "text" | "tools"; content: string | string[] };

export type TurnDraftState = {
  assistantResponse: string;
  toolTimeline: string[];
  sections: TurnSection[];
  currentTools: string[];
  currentText: string;
};

export type ExecuteTurnResult = {
  latestRunId: string;
  runCancelled: boolean;
  runContinuation: boolean;
  runContinuationMessages?: Message[];
  runHarnessMessages?: Message[];
  runContextTokens: number;
  runContextWindow: number;
  runSteps: number;
  runMaxSteps?: number;
  draft: TurnDraftState;
};

export type TurnResultMetadata = {
  latestRunId: string;
  contextTokens: number;
  contextWindow: number;
  continuation?: boolean;
  continuationMessages?: Message[];
  harnessMessages?: Message[];
  toolResultArchive?: Conversation["_toolResultArchive"];
};

// ── Draft helpers ──

export const createTurnDraftState = (): TurnDraftState => ({
  assistantResponse: "",
  toolTimeline: [],
  sections: [],
  currentTools: [],
  currentText: "",
});

export const cloneSections = (sections: TurnSection[]): TurnSection[] =>
  sections.map((section) => ({
    type: section.type,
    content: Array.isArray(section.content) ? [...section.content] : section.content,
  }));

export const flushTurnDraft = (draft: TurnDraftState): void => {
  if (draft.currentTools.length > 0) {
    draft.sections.push({ type: "tools", content: draft.currentTools });
    draft.currentTools = [];
  }
  if (draft.currentText.length > 0) {
    draft.sections.push({ type: "text", content: draft.currentText });
    draft.currentText = "";
  }
};

// ── Event processing ──

/** Build enriched tool:completed text with input details (bash command, URL, etc.) */
export const buildToolCompletedText = (event: AgentEvent & { type: "tool:completed" }): string => {
  const input = event.input as Record<string, unknown> | undefined;
  const output = event.output as Record<string, unknown> | undefined;

  const meta: string[] = [`${event.duration}ms`];
  let detail = "";

  if (event.tool === "bash" && input && typeof input.command === "string") {
    detail = input.command;
  } else if (event.tool === "web_search") {
    const q = (input?.query as string) || (output?.query as string) || "";
    if (q) detail = `"${q.length > 60 ? q.slice(0, 57) + "..." : q}"`;
  } else if (event.tool === "web_fetch") {
    const u = (input?.url as string) || (output?.url as string) || "";
    if (u) detail = u;
  } else if (event.tool === "spawn_subagent") {
    if (input && typeof input.task === "string") detail = input.task;
  } else if (input) {
    // Generic: pick the first short string value from input
    for (const [, v] of Object.entries(input)) {
      if (typeof v === "string" && v.length > 0) {
        detail = v.length > 80 ? v.slice(0, 77) + "..." : v;
        break;
      }
    }
  }
  if (detail) {
    detail = detail.replace(/\n/g, " ");
    meta.push(detail);
  }

  let text = `- done \`${event.tool}\`` + (meta.length > 0 ? ` (${meta.join(", ")})` : "");

  if (event.tool === "spawn_subagent" && output?.subagentId) {
    text += ` [subagent:${output.subagentId}]`;
  }
  if (event.tool === "bash" && typeof output?.exitCode === "number" && output.exitCode !== 0) {
    text += ` \u2014 exit ${output.exitCode}`;
  }
  if (event.tool === "web_search" && Array.isArray(output?.results)) {
    text += ` \u2014 ${(output.results as unknown[]).length} result${(output.results as unknown[]).length !== 1 ? "s" : ""}`;
  }

  // Trailing machine token: the tool-call id this pill corresponds to. Lets a
  // display client join the pill to its full input/output by id rather than
  // by tool-name+position (which misaligns whenever parallel tool calls in a
  // turn complete out of declaration order, and can't reach a subagent's
  // inner-tool results at all). Appended AFTER any human detail/parens so
  // older clients \u2014 which only read inside the first `(...)` \u2014 ignore it.
  // Stripped from model-visible interruption text via stripPillMetaTokens.
  if (event.toolCallId) text += ` {tcid:${event.toolCallId}}`;

  return text;
};

// Remove machine tokens (e.g. `{tcid:\u2026}`) that buildToolCompletedText appends
// to activity lines for the display client. Use anywhere a tool-timeline line
// is folded into MODEL-visible text (e.g. interruption reconstruction) so the
// internal id never leaks into the prompt.
export const stripPillMetaTokens = (line: string): string =>
  line.replace(/\s*\{tcid:[^}]+\}/g, "");

export const recordStandardTurnEvent = (draft: TurnDraftState, event: AgentEvent): void => {
  if (event.type === "model:chunk") {
    if (draft.currentTools.length > 0) {
      draft.sections.push({ type: "tools", content: draft.currentTools });
      draft.currentTools = [];
      if (draft.assistantResponse.length > 0 && !/\s$/.test(draft.assistantResponse)) {
        draft.assistantResponse += " ";
      }
    }
    draft.assistantResponse += event.content;
    draft.currentText += event.content;
    return;
  }
  if (event.type === "tool:started") {
    if (draft.currentText.length > 0) {
      draft.sections.push({ type: "text", content: draft.currentText });
      draft.currentText = "";
    }
    const input = event.input as Record<string, unknown> | undefined;
    let startDetail = "";
    if (event.tool === "bash" && input && typeof input.command === "string") {
      startDetail = input.command;
    } else if (event.tool === "web_fetch" && input && typeof input.url === "string") {
      startDetail = input.url;
    } else if (event.tool === "web_search" && input && typeof input.query === "string") {
      startDetail = `"${input.query}"`;
    } else if (input) {
      for (const [, v] of Object.entries(input)) {
        if (typeof v === "string" && v.length > 0) {
          startDetail = v.length > 80 ? v.slice(0, 77) + "..." : v;
          break;
        }
      }
    }
    if (startDetail) startDetail = startDetail.replace(/\n/g, " ");
    const toolText = `- start \`${event.tool}\`` + (startDetail ? ` (${startDetail})` : "");
    draft.toolTimeline.push(toolText);
    draft.currentTools.push(toolText);
    return;
  }
  if (event.type === "tool:completed") {
    const toolText = buildToolCompletedText(event);
    draft.toolTimeline.push(toolText);
    draft.currentTools.push(toolText);
    return;
  }
  if (event.type === "tool:error") {
    const toolText = `- error \`${event.tool}\`: ${event.error}`;
    draft.toolTimeline.push(toolText);
    draft.currentTools.push(toolText);
  }
};

export const buildAssistantMetadata = (
  draft: TurnDraftState,
  sectionsOverride?: TurnSection[],
  opts?: { id?: string; timestamp?: number },
): Message["metadata"] | undefined => {
  const sections = sectionsOverride ?? cloneSections(draft.sections);
  const hasContent = draft.toolTimeline.length > 0 || sections.length > 0;
  if (!hasContent && !opts?.id) return undefined;
  const meta: Message["metadata"] = {};
  if (opts?.id) meta.id = opts.id;
  if (opts?.timestamp) meta.timestamp = opts.timestamp;
  if (draft.toolTimeline.length > 0) meta.toolActivity = [...draft.toolTimeline];
  if (sections.length > 0) meta.sections = sections;
  return meta;
};

// ── Turn executor ──

export const executeConversationTurn = async ({
  harness,
  runInput,
  events,
  initialContextTokens = 0,
  initialContextWindow = 0,
  onEvent,
}: {
  harness: AgentHarness;
  runInput?: Parameters<AgentHarness["runWithTelemetry"]>[0];
  events?: AsyncIterable<AgentEvent>;
  initialContextTokens?: number;
  initialContextWindow?: number;
  onEvent?: (event: AgentEvent, draft: TurnDraftState) => void | Promise<void>;
}): Promise<ExecuteTurnResult> => {
  const draft = createTurnDraftState();
  let latestRunId = "";
  let runCancelled = false;
  let runContinuation = false;
  let runContinuationMessages: Message[] | undefined;
  let runHarnessMessages: Message[] | undefined;
  let runContextTokens = initialContextTokens;
  let runContextWindow = initialContextWindow;
  let runSteps = 0;
  let runMaxSteps: number | undefined;

  const source = events ?? harness.runWithTelemetry(runInput!);
  for await (const event of source) {
    recordStandardTurnEvent(draft, event);
    if (event.type === "run:started") {
      latestRunId = event.runId;
    }
    if (event.type === "run:cancelled") {
      runCancelled = true;
      if (event.messages) {
        runHarnessMessages = event.messages;
      }
    }
    if (event.type === "run:completed") {
      runContinuation = event.result.continuation === true;
      runContinuationMessages = event.result.continuationMessages;
      runHarnessMessages = event.result.continuationMessages;
      runContextTokens = event.result.contextTokens ?? runContextTokens;
      runContextWindow = event.result.contextWindow ?? runContextWindow;
      runSteps = event.result.steps;
      if (typeof event.result.maxSteps === "number") {
        runMaxSteps = event.result.maxSteps;
      }
      if (draft.assistantResponse.length === 0 && event.result.response) {
        draft.assistantResponse = event.result.response;
      }
    }
    if (event.type === "run:error") {
      draft.assistantResponse = draft.assistantResponse || `[Error: ${event.error.message}]`;
    }
    if (onEvent) {
      await onEvent(event, draft);
    }
  }

  return {
    latestRunId,
    runCancelled,
    runContinuation,
    runContinuationMessages,
    runHarnessMessages,
    runContextTokens,
    runContextWindow,
    runSteps,
    runMaxSteps,
    draft,
  };
};

// ── Approval checkpoint helpers ──

const normalizePendingToolCalls = (value: unknown): PendingToolCall[] => {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is PendingToolCall => {
      if (!entry || typeof entry !== "object") return false;
      const row = entry as Record<string, unknown>;
      return (
        typeof row.id === "string" &&
        typeof row.name === "string" &&
        typeof row.input === "object" &&
        row.input !== null
      );
    })
    .map((entry) => ({ id: entry.id, name: entry.name, input: entry.input }));
};

export const normalizeApprovalCheckpoint = (
  approval: StoredApproval,
  fallbackMessages: Message[],
): StoredApproval => ({
  ...approval,
  checkpointMessages: isMessageArray(approval.checkpointMessages) ? approval.checkpointMessages : [...fallbackMessages],
  baseMessageCount: typeof approval.baseMessageCount === "number" && approval.baseMessageCount >= 0
    ? approval.baseMessageCount
    : 0,
  pendingToolCalls: normalizePendingToolCalls(approval.pendingToolCalls),
});

export const buildApprovalCheckpoints = ({
  approvals,
  runId,
  checkpointMessages,
  baseMessageCount,
  pendingToolCalls,
  kind = "approval",
}: {
  approvals: ApprovalEventItem[];
  runId: string;
  checkpointMessages: Message[];
  baseMessageCount: number;
  pendingToolCalls: PendingToolCall[];
  kind?: "approval" | "device";
}): NonNullable<Conversation["pendingApprovals"]> =>
  approvals.map((approval) => ({
    approvalId: approval.approvalId,
    runId,
    tool: approval.tool,
    toolCallId: approval.toolCallId,
    input: approval.input,
    checkpointMessages,
    baseMessageCount,
    pendingToolCalls,
    kind,
  }));

// ── Checkpoint transcript reconstruction (single source of truth) ──
//
// Resuming a checkpointed turn requires rebuilding the FULL canonical model
// transcript from what was stored at the pause. Getting this right — in the
// canonical message space, not the display one — is subtle, and re-deriving
// it by hand in each embedder is exactly how the model-facing transcript
// drifted from the display transcript and silently dropped a turn's user
// message after an approval. These helpers are that logic, exported so the
// orchestrator's own resume AND external embedders (e.g. PonchOS, which
// executes gated tools itself) share one implementation that can't drift.

/** Reconstruct the full canonical transcript a checkpoint resumes from: the
 *  prior history (before the checkpointed turn) + the checkpoint delta.
 *  Handles both storage conventions via `normalizeApprovalCheckpoint` — the
 *  initial checkpoint (base = prior length, delta) and a resume-created one
 *  (base 0, full canonical). */
export const assembleCheckpointMessages = (
  conversation: Conversation,
  checkpoint: StoredApproval,
): Message[] => {
  const n = normalizeApprovalCheckpoint(checkpoint, conversation.messages);
  const base = n.baseMessageCount != null ? conversation.messages.slice(0, n.baseMessageCount) : [];
  return [...base, ...(n.checkpointMessages ?? [])];
};

/** Pair an assistant tool-call message's `tool_calls` with externally-computed
 *  results into the single `role:"tool"` message a continuation reads.
 *  Returns undefined when `assistantMsg` isn't an assistant message with
 *  parseable tool calls. Used to persist the resume's canonical history so it
 *  matches what `continueFromToolResult` fed the model. Missing results
 *  default to the deferred-error marker (same text the run uses). */
export const buildToolResultMessage = (
  assistantMsg: Message | undefined,
  toolResults: Array<{ callId: string; toolName: string; result?: unknown; error?: string }>,
): Message | undefined => {
  if (assistantMsg?.role !== "assistant") return undefined;
  let toolCalls: Array<{ id: string; name: string }> = [];
  try {
    const parsed = JSON.parse(typeof assistantMsg.content === "string" ? assistantMsg.content : "");
    toolCalls = parsed.tool_calls ?? [];
  } catch {
    return undefined;
  }
  if (toolCalls.length === 0) return undefined;
  const provided = new Map(toolResults.map((r) => [r.callId, r]));
  return {
    role: "tool",
    content: JSON.stringify(
      toolCalls.map((tc) => {
        const r = provided.get(tc.id);
        return {
          type: "tool_result",
          tool_use_id: tc.id,
          tool_name: r?.toolName ?? tc.name,
          content: r
            ? (r.error ? `Tool error: ${r.error}` : JSON.stringify(r.result ?? null))
            : "Tool error: Tool execution deferred (pending approval checkpoint)",
        };
      }),
    ),
    metadata: { timestamp: Date.now(), id: randomUUID() },
  };
};

/** Build the `pendingApprovals` rows for a checkpoint reached DURING a resume
 *  continuation. Stores the WHOLE canonical history the continuation ran with
 *  (`priorMessages` = prior + tool result + new delta) with
 *  `baseMessageCount: 0`. Keeping the full history here — rather than a delta
 *  + a base count into a different message array — is what lets the next
 *  resume reconstruct with no index arithmetic. */
export const buildResumeCheckpoints = ({
  priorMessages,
  checkpointEvent,
  runId,
  kind = "approval",
}: {
  priorMessages: Message[];
  checkpointEvent: {
    approvals: ApprovalEventItem[];
    checkpointMessages: Message[];
    pendingToolCalls: PendingToolCall[];
  };
  runId: string;
  kind?: "approval" | "device";
}): NonNullable<Conversation["pendingApprovals"]> =>
  buildApprovalCheckpoints({
    approvals: checkpointEvent.approvals,
    runId,
    checkpointMessages: [...priorMessages, ...checkpointEvent.checkpointMessages],
    baseMessageCount: 0,
    pendingToolCalls: checkpointEvent.pendingToolCalls,
    kind,
  });

/** Text of a message for the transcript-integrity guard — flattens the two
 *  content shapes so a user message can be matched across the display and
 *  canonical transcripts regardless of how each stored it. */
const messageText = (m: Message): string =>
  typeof m.content === "string"
    ? m.content
    : Array.isArray(m.content)
      ? m.content.map((p) => (p as { text?: string }).text ?? "").join("")
      : "";

// ── Turn metadata persistence ──

export const applyTurnMetadata = (
  conv: Conversation,
  meta: TurnResultMetadata,
  opts: {
    clearContinuation?: boolean;
    clearApprovals?: boolean;
    setIdle?: boolean;
    shouldRebuildCanonical?: boolean;
  } = {},
): void => {
  const {
    clearContinuation = true,
    clearApprovals = true,
    setIdle = true,
    shouldRebuildCanonical = false,
  } = opts;

  if (meta.continuation && meta.continuationMessages) {
    conv._continuationMessages = meta.continuationMessages;
  } else if (clearContinuation) {
    conv._continuationMessages = undefined;
    conv._continuationCount = undefined;
  }

  if (meta.harnessMessages) {
    conv._harnessMessages = meta.harnessMessages;
  } else if (shouldRebuildCanonical) {
    conv._harnessMessages = conv.messages;
  }

  // Invariant guard: the model-facing transcript must not drop the current
  // turn's user message. A resume that reconstructed `_harnessMessages`
  // incorrectly silently lost it (the display transcript kept it, the model
  // didn't), so the agent second-guessed an approval it never saw. This is the
  // one choke point every finalize flows through — assert the latest user
  // message survived into canonical, and log loudly if not. Matched by content
  // (robust across the display/canonical shapes) and skipped when compaction
  // has legitimately summarized history. Log-only; never throws.
  if (isMessageArray(conv._harnessMessages) && conv._harnessMessages.length > 0) {
    const canonical = conv._harnessMessages;
    const summarized = canonical.some((m) => m.metadata?.isCompactionSummary);
    const lastUser = [...conv.messages].reverse().find((m) => m.role === "user");
    const lastUserText = lastUser ? messageText(lastUser).trim() : "";
    if (!summarized && lastUserText) {
      const present = canonical.some((m) => m.role === "user" && messageText(m).trim() === lastUserText);
      if (!present) {
        console.error(
          `[transcript-guard] conversation ${conv.conversationId}: model-facing transcript ` +
            `is missing the latest user message — it diverged from the display transcript. ` +
            `This is a resume/finalize message-assembly bug; the model will not see that turn's input.`,
        );
      }
    }
  }

  if (meta.toolResultArchive !== undefined) {
    conv._toolResultArchive = meta.toolResultArchive;
  }

  conv.runtimeRunId = meta.latestRunId || conv.runtimeRunId;

  if (clearApprovals) conv.pendingApprovals = [];
  if (setIdle) conv.runStatus = "idle";

  if (meta.contextTokens > 0) conv.contextTokens = meta.contextTokens;
  if (meta.contextWindow > 0) conv.contextWindow = meta.contextWindow;

  conv.updatedAt = Date.now();
};
