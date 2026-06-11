import { generateText, type LanguageModel } from "ai";
import type { Message } from "@poncho-ai/sdk";
import { getTextContent } from "@poncho-ai/sdk";
import type { CompactionConfig } from "./agent-parser.js";

const OVERHEAD_MULTIPLIER = 1.15;
const MIN_COMPACTABLE_MESSAGES = 4;

const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  enabled: true,
  trigger: 0.75,
  keepRecentMessages: 4,
};
const SUMMARIZATION_MESSAGE_TRUNCATION_CHARS = 1200;
const SUMMARIZATION_MAX_OUTPUT_TOKENS = 768;

const SUMMARIZATION_PROMPT = `Summarize the following conversation into a structured working state that allows continuation without re-asking questions. Include:

1. **User intent**: What the user originally asked for and any refinements
2. **Completed work**: What has been accomplished so far
3. **Key decisions**: Technical decisions made and their rationale
4. **Errors & fixes**: Errors encountered and how they were resolved
5. **Referenced resources**: Files, URLs, tools, or data referenced
6. **Pending next steps**: What remains to be done

Be concise but preserve all information needed to continue the task.
Omit any section that has no relevant content.`;

/**
 * Extra instruction appended when the first compacted message is itself a
 * prior compaction summary. The model must treat that block as the existing
 * working state and produce an updated, merged version rather than
 * re-summarizing the (already lossy) summary from scratch.
 */
const CUMULATIVE_SUMMARY_PROMPT = `The FIRST message below (tagged [prior-summary]) is an existing working-state summary produced by an earlier compaction. Treat it as the authoritative prior working state: MERGE AND UPDATE it with the newer messages that follow it, carrying forward all still-relevant detail. Do NOT discard or re-compress information from the prior summary just because it is older — only drop it if the newer messages explicitly supersede it.`;

/** Max chars of a subagent result text kept verbatim in the ledger digest. */
const SUBAGENT_DIGEST_CHARS = 500;

/** Heading used for the verbatim, model-proof subagent ledger block. */
const SUBAGENT_LEDGER_HEADING = "## Subagents";

export const resolveCompactionConfig = (
  explicit?: Partial<CompactionConfig>,
): CompactionConfig => {
  if (!explicit) return { ...DEFAULT_COMPACTION_CONFIG };
  return {
    enabled: explicit.enabled ?? DEFAULT_COMPACTION_CONFIG.enabled,
    trigger: explicit.trigger ?? DEFAULT_COMPACTION_CONFIG.trigger,
    keepRecentMessages:
      explicit.keepRecentMessages ??
      DEFAULT_COMPACTION_CONFIG.keepRecentMessages,
    instructions: explicit.instructions,
  };
};

/**
 * Estimate the token count of a string using the chars/4 heuristic
 * with a conservative overhead multiplier.
 */
export const estimateTokens = (text: string): number =>
  Math.ceil((text.length / 4) * OVERHEAD_MULTIPLIER);

/**
 * Estimate the total token count of a system prompt + messages + tool defs.
 *
 * Tool definitions are structured JSON (property names, braces, enum values)
 * which tokenizes more efficiently than natural language — roughly 5-6
 * chars/token vs ~4 chars/token for prose.  We estimate them separately to
 * avoid inflating the count when there are many MCP tools (100+).
 */
export const estimateTotalTokens = (
  systemPrompt: string,
  messages: Message[],
  toolDefinitionsJson?: string,
): number => {
  let chars = systemPrompt.length;
  for (const msg of messages) {
    chars += typeof msg.content === "string"
      ? msg.content.length
      : msg.content.reduce((sum, part) => {
          if (part.type === "text") return sum + part.text.length;
          return sum + 200; // rough estimate for file/image references
        }, 0);
  }
  let tokens = Math.ceil((chars / 4) * OVERHEAD_MULTIPLIER);
  if (toolDefinitionsJson) {
    // JSON-specific ratio — no overhead multiplier (structural tokens are
    // already accounted for by the higher chars-per-token ratio).
    tokens += Math.ceil(toolDefinitionsJson.length / 6);
  }
  return tokens;
};

/**
 * Whether an assistant message carries serialized tool_calls. Assistant
 * tool-call turns serialize their content as a JSON string of the shape
 * `{"text":...,"tool_calls":[...]}` (see the harness run loop). A plain-text
 * assistant message returns false.
 */
const assistantHasToolCalls = (msg: Message): boolean => {
  if (msg.role !== "assistant") return false;
  if (typeof msg.content !== "string") return false;
  if (!msg.content.includes('"tool_calls"')) return false;
  try {
    const parsed = JSON.parse(msg.content) as { tool_calls?: unknown };
    return Array.isArray(parsed.tool_calls) && parsed.tool_calls.length > 0;
  } catch {
    return false;
  }
};

/**
 * Whether splitting at `idx` would orphan a tool-call relationship on the
 * COMPACTED side — i.e. the last compacted message (`messages[idx-1]`) is an
 * assistant message with tool_calls whose answering `role:"tool"` result
 * lives on the PRESERVED side (`messages[idx]`). Folding only the assistant
 * call into the summary strands the tool_calls with no matching result.
 */
const splitOrphansToolCalls = (messages: Message[], idx: number): boolean => {
  if (idx <= 0 || idx >= messages.length) return false;
  const lastCompacted = messages[idx - 1]!;
  return assistantHasToolCalls(lastCompacted);
};

/**
 * Find the safe split index so that everything before it can be compacted
 * and everything from it onward is preserved. The split always lands just
 * before a `user` message to avoid breaking assistant+tool pairs.
 *
 * Defensive guard: even at a `user` boundary, refuse a split whose compacted
 * side would END on an assistant message with unanswered tool_calls (its
 * `tool` result having moved to the preserved side). Such a split would
 * orphan the tool_calls inside the summary boundary. When that happens we
 * walk earlier to the next safe `user` boundary.
 *
 * Returns -1 if no valid split point is found.
 */
export const findSafeSplitPoint = (
  messages: Message[],
  keepRecentMessages: number,
): number => {
  const candidateIdx = messages.length - keepRecentMessages;
  if (candidateIdx < MIN_COMPACTABLE_MESSAGES) return -1;

  // Walk backwards from candidate to find a user message boundary that does
  // not orphan a tool-call relationship on the compacted side.
  for (let i = candidateIdx; i >= MIN_COMPACTABLE_MESSAGES; i--) {
    if (messages[i]!.role === "user" && !splitOrphansToolCalls(messages, i)) {
      return i;
    }
  }

  // Walk forwards from candidate as fallback.
  for (let i = candidateIdx + 1; i < messages.length - 1; i++) {
    if (messages[i]!.role === "user" && !splitOrphansToolCalls(messages, i)) {
      if (i < MIN_COMPACTABLE_MESSAGES) return -1;
      return i;
    }
  }

  return -1;
};

/**
 * Whether a message is itself a prior compaction summary.
 */
const isCompactionSummary = (msg: Message): boolean =>
  msg.metadata?.isCompactionSummary === true;

/**
 * Build the summarization messages for the generateText call.
 *
 * Cumulative behavior: when the FIRST compacted message is itself a prior
 * compaction summary, it is passed in FULL (not truncated to
 * SUMMARIZATION_MESSAGE_TRUNCATION_CHARS) and tagged `[prior-summary]`, and
 * the prompt instructs the model to merge-and-update rather than
 * re-summarize. All other messages keep the 1200-char truncation.
 */
const buildSummarizationMessages = (
  messagesToCompact: Message[],
  instructions?: string,
): Array<{ role: "user"; content: string }> => {
  const hasPriorSummary =
    messagesToCompact.length > 0 && isCompactionSummary(messagesToCompact[0]!);

  const conversationLines: string[] = [];
  for (let i = 0; i < messagesToCompact.length; i++) {
    const msg = messagesToCompact[i]!;
    const text = getTextContent(msg);
    const isPrior = i === 0 && hasPriorSummary;
    // The prior summary is the working state we must not lose — pass it whole.
    const rendered =
      isPrior || text.length <= SUMMARIZATION_MESSAGE_TRUNCATION_CHARS
        ? text
        : text.slice(0, SUMMARIZATION_MESSAGE_TRUNCATION_CHARS) +
          "\n...[truncated]";
    const tag = isPrior ? "prior-summary" : msg.role;
    conversationLines.push(`[${tag}]: ${rendered}`);
  }

  let prompt = SUMMARIZATION_PROMPT;
  if (hasPriorSummary) prompt = `${prompt}\n\n${CUMULATIVE_SUMMARY_PROMPT}`;
  if (instructions) prompt = `${prompt}\n\nAdditional focus: ${instructions}`;

  return [
    {
      role: "user" as const,
      content: `${prompt}\n\n---\n\n${conversationLines.join("\n\n")}`,
    },
  ];
};

interface SubagentLedgerEntry {
  subagentId: string;
  task: string;
  status: string;
  digest: string;
}

/** Match the header line of an injected subagent callback message. */
const SUBAGENT_RESULT_HEADER =
  /^\[Subagent Result\] Subagent "([^"]*)" \(([^)]*)\) (\S+):/;

/**
 * Parse the metadata + text of a subagent-callback user message into a ledger
 * entry. Returns null when the message is not a subagent callback.
 */
const parseSubagentCallback = (msg: Message): SubagentLedgerEntry | null => {
  if (msg.role !== "user") return null;
  const meta = (msg.metadata ?? {}) as Record<string, unknown>;
  const text = getTextContent(msg);
  const hasMetaFlag =
    meta._subagentCallback === true || meta.subagentCallback === true;
  const hasTextMarker = text.startsWith("[Subagent Result]");
  if (!hasMetaFlag && !hasTextMarker) return null;

  // Prefer structured metadata, fall back to parsing the header line.
  const headerMatch = text.match(SUBAGENT_RESULT_HEADER);
  const subagentId =
    typeof meta.subagentId === "string" && meta.subagentId
      ? meta.subagentId
      : headerMatch?.[2] ?? "";
  if (!subagentId) return null;
  const task =
    typeof meta.task === "string" && meta.task
      ? meta.task
      : headerMatch?.[1] ?? "";
  const status = headerMatch?.[3] ?? "completed";

  // Digest = the body after the header line (the result text), capped.
  const bodyStart = text.indexOf("\n\n");
  const body = bodyStart >= 0 ? text.slice(bodyStart + 2) : text;
  const digest =
    body.length > SUBAGENT_DIGEST_CHARS
      ? body.slice(0, SUBAGENT_DIGEST_CHARS) + "…"
      : body;

  return { subagentId, task, status, digest };
};

/**
 * Parse a prior `## Subagents` ledger block out of an existing compaction
 * summary's content so it can be carried forward cumulatively. The block is
 * rendered by `renderSubagentLedger`, so we parse that same shape.
 */
const parsePriorLedger = (summaryText: string): SubagentLedgerEntry[] => {
  const headingIdx = summaryText.indexOf(SUBAGENT_LEDGER_HEADING);
  if (headingIdx < 0) return [];
  const block = summaryText.slice(headingIdx + SUBAGENT_LEDGER_HEADING.length);
  const entries: SubagentLedgerEntry[] = [];
  // Each entry: a bullet line "- **<task>** (<id>) — <status>" then a digest
  // line. We tolerate missing digest lines.
  const entryRe =
    /^- \*\*(.*?)\*\* \((.+?)\) — (\S+)\n {2}(.*)$/gm;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(block)) !== null) {
    entries.push({
      task: m[1]!,
      subagentId: m[2]!,
      status: m[3]!,
      digest: m[4]!,
    });
  }
  return entries;
};

/**
 * Scan the messages being compacted for subagent-callback records and any
 * prior ledger embedded in a compaction summary, returning a combined,
 * deduped (by subagentId, last-write-wins) list in first-seen order.
 */
const collectSubagentLedger = (
  messagesToCompact: Message[],
): SubagentLedgerEntry[] => {
  const byId = new Map<string, SubagentLedgerEntry>();
  const order: string[] = [];
  const upsert = (entry: SubagentLedgerEntry) => {
    if (!byId.has(entry.subagentId)) order.push(entry.subagentId);
    byId.set(entry.subagentId, entry);
  };

  for (const msg of messagesToCompact) {
    if (isCompactionSummary(msg)) {
      for (const prior of parsePriorLedger(getTextContent(msg))) upsert(prior);
      continue;
    }
    const entry = parseSubagentCallback(msg);
    if (entry) upsert(entry);
  }

  return order.map((id) => byId.get(id)!);
};

/**
 * Render the subagent ledger as a verbatim markdown block appended to the
 * summary AFTER the LLM text, so the model can never paraphrase it away.
 * Returns "" when there are no subagents.
 */
const renderSubagentLedger = (entries: SubagentLedgerEntry[]): string => {
  if (entries.length === 0) return "";
  const lines = entries.map(
    (e) =>
      `- **${e.task}** (${e.subagentId}) — ${e.status}\n  ${e.digest.replace(/\n/g, " ")}`,
  );
  return `${SUBAGENT_LEDGER_HEADING}\n${lines.join("\n")}`;
};

/**
 * Build the continuation message that replaces compacted messages.
 */
const buildContinuationMessage = (summary: string): Message => ({
  role: "user",
  content:
    `[CONTEXT COMPACTION] This conversation was automatically compacted. The summary below covers earlier messages.\n\n<summary>\n${summary}\n</summary>\n\nContinue from where the conversation left off without re-asking questions.`,
  metadata: { isCompactionSummary: true, timestamp: Date.now() },
});

export interface CompactMessagesOptions {
  instructions?: string;
}

export interface CompactResult {
  compacted: boolean;
  messages: Message[];
  messagesBefore?: number;
  messagesAfter?: number;
  warning?: string;
}

/**
 * Compact a message array by summarizing older messages via an LLM call.
 *
 * @param model        The language model instance to use for summarization
 * @param messages     The full message array
 * @param config       Compaction configuration
 * @param options      Optional instructions override
 * @returns            The compacted result
 */
export const compactMessages = async (
  model: LanguageModel,
  messages: Message[],
  config: CompactionConfig,
  options?: CompactMessagesOptions,
): Promise<CompactResult> => {
  const splitIdx = findSafeSplitPoint(messages, config.keepRecentMessages);
  if (splitIdx === -1) {
    return {
      compacted: false,
      messages,
      warning: "Not enough messages to compact",
    };
  }

  const toCompact = messages.slice(0, splitIdx);
  const toPreserve = messages.slice(splitIdx);

  if (toCompact.length < MIN_COMPACTABLE_MESSAGES) {
    return {
      compacted: false,
      messages,
      warning: "Not enough messages to compact",
    };
  }

  const instructions = options?.instructions ?? config.instructions;
  const summarizationMessages = buildSummarizationMessages(
    toCompact,
    instructions,
  );

  try {
    const result = await generateText({
      model,
      messages: summarizationMessages,
      maxOutputTokens: SUMMARIZATION_MAX_OUTPUT_TOKENS,
    });

    const summary = result.text.trim();
    if (!summary) {
      return {
        compacted: false,
        messages,
        warning: "Summarization returned empty result",
      };
    }

    // Append the subagent ledger AFTER the LLM summary, verbatim, so the
    // model's paraphrasing can never drop or truncate subagent results.
    const ledger = renderSubagentLedger(collectSubagentLedger(toCompact));
    const summaryWithLedger = ledger ? `${summary}\n\n${ledger}` : summary;

    const continuationMessage = buildContinuationMessage(summaryWithLedger);
    const compactedMessages = [continuationMessage, ...toPreserve];

    return {
      compacted: true,
      messages: compactedMessages,
      messagesBefore: messages.length,
      messagesAfter: compactedMessages.length,
    };
  } catch (err) {
    const reason =
      err instanceof Error ? err.message : "Unknown summarization error";
    return {
      compacted: false,
      messages,
      warning: `Summarization failed: ${reason}`,
    };
  }
};
