// ---------------------------------------------------------------------------
// Phase 3b — dual-write + parity checker (instrumentation only)
//
// At each conversation WRITE site we ALSO append the corresponding
// append-only `ConversationEntry`s alongside the existing mutable-blob write.
// READ paths are untouched: nothing consumes these entries yet, so a bug here
// can only mislog — it cannot corrupt behavior. The blob remains the source of
// truth until the read-cutover PR (3c).
//
// Two public surfaces:
//   - `appendEntriesSafe(...)` — fire-and-forget wrapper that swallows every
//     error (so a dual-write failure never breaks a live turn) and stamps a
//     uuid `id` on each entry (the engine inserts `entry.id` as a column).
//   - `verifyEntriesParity(...)` — gated on `PONCHO_VERIFY_ENTRIES === "1"`,
//     rebuilds LLM context + display snapshot from the entry log and diffs
//     them against the blob's `_harnessMessages` / `messages`. Logs mismatches
//     under `[entries-parity]`. Never throws.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { getTextContent, type Message } from "@poncho-ai/sdk";
import type { Logger } from "@poncho-ai/sdk";
import type { Conversation, ConversationStore, PendingSubagentResult } from "../state.js";
import {
  buildDisplaySnapshot,
  buildLlmContext,
  type ConversationEntry,
  type NewConversationEntry,
} from "../storage/entries.js";

/** True when dual-write parity verification is opted in via env. */
export const entriesParityEnabled = (): boolean =>
  process.env.PONCHO_VERIFY_ENTRIES === "1";

// DISTRIBUTIVE omit (same reasoning as NewConversationEntry in entries.ts): a
// plain Omit<NewConversationEntry, "id"> over a union collapses to the keys
// common to every member, dropping `message`/`result`/etc. Distribute over the
// union so each member keeps its own discriminant fields.
type NewEntryNoId = NewConversationEntry extends infer T
  ? T extends NewConversationEntry
    ? Omit<T, "id">
    : never
  : never;

/**
 * Append entries to the conversation's append-only log, mirroring an existing
 * blob write. Best-effort and non-blocking by contract:
 *   - stamps a fresh uuid `id` on each entry (required input column),
 *   - never throws (logs and returns [] on failure),
 *   - is safe to `void` (callers needn't await).
 *
 * Returns the stored entries (with seq/createdAt) for callers that want them
 * (e.g. to learn the assistant entry's id for a later amendment), or [] on
 * empty input / failure.
 */
export const appendEntriesSafe = async (
  store: ConversationStore,
  conversation: Pick<Conversation, "conversationId" | "ownerId" | "tenantId">,
  entries: NewEntryNoId[],
  log: Logger,
): Promise<ConversationEntry[]> => {
  if (entries.length === 0) return [];
  try {
    const withIds = entries.map(
      (e) => ({ id: randomUUID(), ...e }) as NewConversationEntry,
    );
    return await store.appendEntries(
      conversation.conversationId,
      conversation.ownerId,
      conversation.tenantId ?? null,
      withIds,
    );
  } catch (err) {
    log.error(
      `[entries-dual-write] append failed for ${conversation.conversationId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }
};

// --- entry builders (pure; centralize the best-effort derivation) ----------

export const userMessageEntry = (
  message: Message,
  turnId: string,
  opts?: { hidden?: boolean },
): NewEntryNoId => ({
  type: "user_message",
  message,
  turnId,
  ...(opts?.hidden ? { hidden: true } : {}),
});

export const assistantMessageEntry = (
  message: Message,
  turnId: string,
  runId: string,
): NewEntryNoId => ({
  type: "assistant_message",
  message,
  turnId,
  runId,
});

export const harnessMessageEntries = (
  messages: Message[],
  turnId: string,
): NewEntryNoId[] =>
  messages.map((message) => ({ type: "harness_message", message, turnId }));

export const compactionEntry = (
  summaryMessage: Message,
  firstKeptSeq: number,
  opts?: { tokensBefore?: number; tokensAfter?: number },
): NewEntryNoId => ({
  type: "compaction",
  summaryMessage,
  firstKeptSeq,
  ...(opts?.tokensBefore !== undefined ? { tokensBefore: opts.tokensBefore } : {}),
  ...(opts?.tokensAfter !== undefined ? { tokensAfter: opts.tokensAfter } : {}),
});

export const subagentResultEntry = (
  result: PendingSubagentResult,
): NewEntryNoId => ({ type: "subagent_result", result });

export const callbackStartedEntry = (consumedSeqs: number[]): NewEntryNoId => ({
  type: "callback_started",
  consumedSeqs,
});

export const assistantAmendmentEntry = (
  targetEntryId: string,
  appendText: string,
): NewEntryNoId => ({
  type: "assistant_amendment",
  targetEntryId,
  ...(appendText ? { appendText } : {}),
});

// --- "new harness messages this turn" diff ---------------------------------

/**
 * The harness messages added during the just-finished turn — i.e. the suffix
 * of the new `_harnessMessages` array beyond what was there before the turn.
 *
 * BEST-EFFORT: the blob replaces `_harnessMessages` wholesale (it's not an
 * append log), so we recover "what's new" by length-diffing prev vs next.
 * When a compaction collapsed history this turn, `next` can be SHORTER than
 * `prev`; in that case there's no clean suffix and we return the whole `next`
 * so the entry log still ends up with the model-visible context (parity will
 * flag the over-count for review). The compaction entry (appended separately)
 * is what makes rebuild correct in that case.
 */
export const newHarnessMessagesThisTurn = (
  prev: Message[] | undefined,
  next: Message[] | undefined,
): { messages: Message[]; approximate: boolean } => {
  const prevArr = prev ?? [];
  const nextArr = next ?? [];
  if (nextArr.length === 0) return { messages: [], approximate: false };
  if (prevArr.length === 0) return { messages: nextArr, approximate: false };
  if (nextArr.length >= prevArr.length) {
    // Assume the new array is prev + appended suffix (the common case).
    return { messages: nextArr.slice(prevArr.length), approximate: false };
  }
  // next shorter than prev — compaction or a rebuild reshaped the array.
  return { messages: nextArr, approximate: true };
};

// --- parity checker ---------------------------------------------------------

/** Normalized text projection for length-insensitive content comparison. */
const projectText = (m: Message): string => {
  const role = m.role;
  const text = getTextContent(m).replace(/\s+/g, " ").trim();
  return `${role}:${text}`;
};

const projectAll = (msgs: Message[]): string[] => msgs.map(projectText);

const countMismatch = (label: string, a: number, b: number): string | null =>
  a === b ? null : `${label} length ${a} (entries) vs ${b} (blob)`;

/**
 * Rebuild LLM context + display snapshot from the entry log and diff against
 * the blob. Logs under `[entries-parity]` with the conversationId. Never
 * throws. No-op unless PONCHO_VERIFY_ENTRIES === "1".
 */
export const verifyEntriesParity = async (
  store: ConversationStore,
  conversationId: string,
  blob: { harnessMessages?: Message[]; displayMessages?: Message[] },
  log: Logger,
): Promise<void> => {
  if (!entriesParityEnabled()) return;
  try {
    const entries = await store.readEntries(conversationId);
    const mismatches: string[] = [];

    if (blob.harnessMessages) {
      const llm = buildLlmContext(entries);
      const lenMismatch = countMismatch(
        "llmContext",
        llm.length,
        blob.harnessMessages.length,
      );
      if (lenMismatch) mismatches.push(lenMismatch);
      // Compare a trailing normalized text projection. We don't require
      // byte-equality — metadata, tool-call framing, and exact whitespace
      // differ by construction between the two representations.
      const entriesProj = projectAll(llm);
      const blobProj = projectAll(blob.harnessMessages);
      const tail = Math.min(entriesProj.length, blobProj.length, 5);
      for (let i = 1; i <= tail; i++) {
        const ep = entriesProj[entriesProj.length - i];
        const bp = blobProj[blobProj.length - i];
        if (ep !== bp) {
          mismatches.push(
            `llmContext tail[-${i}] differs: entries=${JSON.stringify(ep).slice(0, 120)} blob=${JSON.stringify(bp).slice(0, 120)}`,
          );
        }
      }
    }

    if (blob.displayMessages) {
      // tailN large enough to cover the whole transcript for the diff.
      const snap = buildDisplaySnapshot(entries, Number.MAX_SAFE_INTEGER);
      const lenMismatch = countMismatch(
        "display",
        snap.totalMessages,
        blob.displayMessages.length,
      );
      if (lenMismatch) mismatches.push(lenMismatch);
      const entriesProj = projectAll(snap.messages);
      const blobProj = projectAll(blob.displayMessages);
      const tail = Math.min(entriesProj.length, blobProj.length, 5);
      for (let i = 1; i <= tail; i++) {
        const ep = entriesProj[entriesProj.length - i];
        const bp = blobProj[blobProj.length - i];
        if (ep !== bp) {
          mismatches.push(
            `display tail[-${i}] differs: entries=${JSON.stringify(ep).slice(0, 120)} blob=${JSON.stringify(bp).slice(0, 120)}`,
          );
        }
      }
    }

    if (mismatches.length > 0) {
      log.warn(
        `[entries-parity] ${conversationId} MISMATCH (${mismatches.length}): ${mismatches.join(" | ")}`,
      );
    } else {
      log.info(`[entries-parity] ${conversationId} OK`);
    }
  } catch (err) {
    log.error(
      `[entries-parity] ${conversationId} checker threw (ignored): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
};
