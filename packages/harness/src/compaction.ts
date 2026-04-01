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
 * Find the safe split index so that everything before it can be compacted
 * and everything from it onward is preserved. The split always lands just
 * before a `user` message to avoid breaking assistant+tool pairs.
 *
 * Returns -1 if no valid split point is found.
 */
export const findSafeSplitPoint = (
  messages: Message[],
  keepRecentMessages: number,
): number => {
  const candidateIdx = messages.length - keepRecentMessages;
  if (candidateIdx < MIN_COMPACTABLE_MESSAGES) return -1;

  // Walk backwards from candidate to find a user message boundary
  for (let i = candidateIdx; i >= MIN_COMPACTABLE_MESSAGES; i--) {
    if (messages[i]!.role === "user") {
      return i;
    }
  }

  // Walk forwards from candidate as fallback
  for (let i = candidateIdx + 1; i < messages.length - 1; i++) {
    if (messages[i]!.role === "user") {
      if (i < MIN_COMPACTABLE_MESSAGES) return -1;
      return i;
    }
  }

  return -1;
};

/**
 * Build the summarization messages for the generateText call.
 */
const buildSummarizationMessages = (
  messagesToCompact: Message[],
  instructions?: string,
): Array<{ role: "user"; content: string }> => {
  const conversationLines: string[] = [];
  for (const msg of messagesToCompact) {
    const text = getTextContent(msg);
    const truncated = text.length > SUMMARIZATION_MESSAGE_TRUNCATION_CHARS
      ? text.slice(0, SUMMARIZATION_MESSAGE_TRUNCATION_CHARS) + "\n...[truncated]"
      : text;
    conversationLines.push(`[${msg.role}]: ${truncated}`);
  }

  const prompt = instructions
    ? `${SUMMARIZATION_PROMPT}\n\nAdditional focus: ${instructions}`
    : SUMMARIZATION_PROMPT;

  return [
    {
      role: "user" as const,
      content: `${prompt}\n\n---\n\n${conversationLines.join("\n\n")}`,
    },
  ];
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

    const continuationMessage = buildContinuationMessage(summary);
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
