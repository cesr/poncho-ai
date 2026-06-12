import { createLogger } from "@poncho-ai/sdk";
import type { Conversation, PendingSubagentResult } from "../state.js";

const entriesReadLog = createLogger("entries-read");

/**
 * The subagent delivery queue: append-only `conversation_entries` rows that
 * carry a finished subagent's result to its parent conversation.
 *
 * Why this exists: subagent results are the ONE conversation field with
 * concurrent writers. A subagent finishes whenever it finishes — possibly
 * while the parent turn is mid-stream doing whole-blob writes — so a
 * read-modify-write on the mutable conversation row could serialize a stale
 * snapshot over the result (the historical "lost subagent result" clobber).
 * An append-only INSERT can't express that race. Everything single-writer
 * (message history, metadata) stays on the conversation row, where the
 * orchestrator's per-conversation turn serialization already makes mutation
 * safe.
 *
 * Two entry types:
 *   - `subagent_result`: a finished subagent's result, appended by the
 *     orchestrator's result-delivery path.
 *   - `callback_started`: marks which result entries a callback turn
 *     consumed (by seq). Consumption is an append, never a delete — a
 *     result is "pending" until a later callback_started lists its seq.
 *
 * Historical note: this module once defined a full transcript's worth of
 * entry types (user/assistant/harness messages, compaction overlays) as
 * groundwork for replacing the conversation blob entirely. The full read
 * cutover shipped briefly (harness 0.58.0), proved unfaithful for callback
 * turns, and was reverted; the unread types + dual-writes were then deleted
 * rather than maintained as drift-prone dead weight. If a future feature
 * needs real history semantics (editing, branching, audit), design that
 * migration fresh — and remember the 0.58.0 lesson: an append-only log is
 * only as good as the completeness of its writers.
 *
 * Ordering: every entry carries a monotonic per-conversation `seq`,
 * assigned by the engine at append time. Entries are sorted by `seq`
 * ascending when passed to the rebuild fn.
 */

interface BaseEntry {
  /** Stable cross-reference id (uuid). */
  id: string;
  /** Monotonic per-conversation order. */
  seq: number;
  createdAt: number;
}

/** A finished subagent's result arriving for the parent. Pending = a
 *  subagent_result whose seq is not listed in any later callback_started. */
export interface SubagentResultEntry extends BaseEntry {
  type: "subagent_result";
  result: PendingSubagentResult;
}

/** Marks which subagent_result entries a callback turn consumed (by seq).
 *  Consumption is an append, never a delete. */
export interface CallbackStartedEntry extends BaseEntry {
  type: "callback_started";
  consumedSeqs: number[];
}

export type ConversationEntry = SubagentResultEntry | CallbackStartedEntry;

/**
 * An entry to append, before the engine assigns `seq` and `createdAt`. This
 * is a DISTRIBUTIVE omit — `Omit<ConversationEntry, K>` over a union would
 * collapse to only the keys common to every member, so we distribute over
 * the union with a conditional type to omit those fields from each member
 * individually.
 */
export type NewConversationEntry = ConversationEntry extends infer T
  ? T extends ConversationEntry
    ? Omit<T, "seq" | "createdAt">
    : never
  : never;

/**
 * Subagent results that have arrived but not yet been consumed by a
 * callback turn — the append-only replacement for the mutable
 * `pendingSubagentResults` array. A result is pending unless a later
 * callback_started lists its seq in `consumedSeqs`.
 */
export function getPendingSubagentResults(
  entries: ConversationEntry[],
): PendingSubagentResult[] {
  const consumed = new Set<number>();
  for (const e of entries) {
    if (e.type === "callback_started") {
      for (const s of e.consumedSeqs) consumed.add(s);
    }
  }
  return entries
    .filter((e): e is SubagentResultEntry => e.type === "subagent_result")
    .filter((e) => !consumed.has(e.seq))
    .map((e) => e.result);
}

/**
 * Read-path override: rebuild `pendingSubagentResults` from the queue.
 *
 * Called in every conversation `get`/`getWithArchive` path AFTER the
 * Conversation has been constructed from the stored row/blob. Only
 * `pendingSubagentResults` is overridden — it's the only field with a write
 * race; message history is written solely by the serialized turn finalize
 * and stays on the blob. If the queue is EMPTY (conversation predates it,
 * or simply has no subagent traffic recorded) the blob-derived value is
 * left untouched; on ANY error this logs and falls back to the blob (hot
 * read path — never throws).
 *
 * Kill-switch: set `PONCHO_READ_ENTRIES=0` to instantly revert to pure blob
 * reads without a deploy (queue reads are ON by default). The blob field is
 * still dual-written for exactly this reason.
 *
 * NOTE: mutates `conversation` in place and returns it. Callers that hand
 * back a shared/mutable Conversation reference (the in-memory stores) MUST
 * pass a clone, or the override will corrupt their stored object.
 */
export async function rebuildConversationFromEntries(
  conversation: Conversation,
  readEntries: (conversationId: string) => Promise<ConversationEntry[]>,
): Promise<Conversation> {
  if (process.env.PONCHO_READ_ENTRIES === "0") return conversation;

  try {
    const entries = await readEntries(conversation.conversationId);
    if (entries.length === 0) return conversation; // fallback: pre-queue conversations
    conversation.pendingSubagentResults = getPendingSubagentResults(entries);
    return conversation;
  } catch (err) {
    entriesReadLog.warn(
      `[entries-read] ${conversation.conversationId} pendingSubagentResults rebuild failed, using blob: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return conversation;
  }
}
