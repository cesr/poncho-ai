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

  return text;
};

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
): Message["metadata"] | undefined => {
  const sections = sectionsOverride ?? cloneSections(draft.sections);
  if (draft.toolTimeline.length === 0 && sections.length === 0) return undefined;
  return {
    toolActivity: [...draft.toolTimeline],
    sections: sections.length > 0 ? sections : undefined,
  } as Message["metadata"];
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
}: {
  approvals: ApprovalEventItem[];
  runId: string;
  checkpointMessages: Message[];
  baseMessageCount: number;
  pendingToolCalls: PendingToolCall[];
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
  }));

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
