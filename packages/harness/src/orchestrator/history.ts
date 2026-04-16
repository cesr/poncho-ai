import type { Message } from "@poncho-ai/sdk";
import type { Conversation } from "../state.js";

export type HistorySource = "harness" | "continuation" | "messages";

export type RunRequest = {
  conversationId: string;
  messages: Message[];
  preferContinuation?: boolean;
};

export type RunOutcome = {
  source: HistorySource;
  shouldRebuildCanonical: boolean;
  messages: Message[];
};

export const isMessageArray = (value: unknown): value is Message[] =>
  Array.isArray(value) &&
  value.every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const row = entry as Record<string, unknown>;
    const role = row.role;
    const content = row.content;
    const roleOk = role === "system" || role === "user" || role === "assistant" || role === "tool";
    const contentOk = typeof content === "string" || Array.isArray(content);
    return roleOk && contentOk;
  });

export const loadCanonicalHistory = (
  conversation: Conversation,
): { messages: Message[]; source: HistorySource } => {
  if (isMessageArray(conversation._harnessMessages) && conversation._harnessMessages.length > 0) {
    return { messages: [...conversation._harnessMessages], source: "harness" };
  }
  return { messages: [...conversation.messages], source: "messages" };
};

export const loadRunHistory = (
  conversation: Conversation,
  options?: { preferContinuation?: boolean },
): { messages: Message[]; source: HistorySource; shouldRebuildCanonical: boolean } => {
  if (options?.preferContinuation && isMessageArray(conversation._continuationMessages) && conversation._continuationMessages.length > 0) {
    return {
      messages: [...conversation._continuationMessages],
      source: "continuation",
      shouldRebuildCanonical: !isMessageArray(conversation._harnessMessages) || conversation._harnessMessages.length === 0,
    };
  }
  const canonical = loadCanonicalHistory(conversation);
  return {
    ...canonical,
    shouldRebuildCanonical: canonical.source !== "harness",
  };
};

export const resolveRunRequest = (
  conversation: Conversation,
  request: RunRequest,
): RunOutcome => {
  const resolved = loadRunHistory(conversation, {
    preferContinuation: request.preferContinuation,
  });
  return {
    source: resolved.source,
    shouldRebuildCanonical: resolved.shouldRebuildCanonical,
    messages: resolved.messages.length > 0 ? resolved.messages : request.messages,
  };
};
