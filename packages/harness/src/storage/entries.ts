import { createLogger, type Message } from "@poncho-ai/sdk";
import type { Conversation, PendingSubagentResult } from "../state.js";

const entriesReadLog = createLogger("entries-read");

/**
 * Append-only conversation entries (Phase 3 substrate).
 *
 * The eventual replacement for the mutable per-conversation JSON blob: a
 * conversation becomes an ordered, append-only list of entries, and the
 * mutable-blob clobber race (two writers serializing a stale whole-blob
 * snapshot over each other — the root cause behind lost subagent results)
 * stops being expressible.
 *
 * This module is intentionally PURE: it defines the entry shapes and the
 * functions that rebuild a conversation's LLM context / display transcript
 * / pending-subagent-results from an entry list. No storage engine, no DB,
 * no wiring into the live run loop yet — so it deploys nothing and is
 * fully unit-testable. The engine implementations (append/read on
 * postgres/sqlite/memory) and the write-site conversions come in later PRs
 * once this rebuild logic is proven.
 *
 * Ordering: every entry carries a monotonic per-conversation `seq`. Entries
 * are assumed sorted by `seq` ascending when passed to the rebuild fns.
 */

interface BaseEntry {
  /** Stable cross-reference id (uuid). */
  id: string;
  /** Monotonic per-conversation order. */
  seq: number;
  createdAt: number;
}

/** A user-role display message (incl. typed subagent-callback messages). */
export interface UserMessageEntry extends BaseEntry {
  type: "user_message";
  message: Message;
  turnId: string;
  /** Hidden from the display transcript (e.g. a framed job prompt, an
   *  onboarding seed, or an injected subagent-result message). Still part
   *  of the record; just not rendered as a chat bubble. */
  hidden?: boolean;
}

/** The final assistant bubble for a completed/cancelled/errored turn. */
export interface AssistantMessageEntry extends BaseEntry {
  type: "assistant_message";
  message: Message;
  turnId: string;
  runId: string;
}

/** A post-hoc edit to an already-emitted assistant message — replaces the
 *  orchestrator/resume "mutate the last assistant message in place" writes
 *  with an append. Applied at rebuild time. */
export interface AssistantAmendmentEntry extends BaseEntry {
  type: "assistant_amendment";
  targetEntryId: string;
  appendText?: string;
}

/** One LLM-transcript message (the model-visible form). Appended from the
 *  run loop per step — never diffed from an array. */
export interface HarnessMessageEntry extends BaseEntry {
  type: "harness_message";
  message: Message;
  turnId: string;
}

/** Compaction overlay: nothing is deleted. At rebuild, the LLM context is
 *  the latest compaction's `summaryMessage` followed by the harness
 *  messages from `firstKeptSeq` onward. */
export interface CompactionEntry extends BaseEntry {
  type: "compaction";
  summaryMessage: Message;
  firstKeptSeq: number;
  tokensBefore?: number;
  tokensAfter?: number;
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

export type ConversationEntry =
  | UserMessageEntry
  | AssistantMessageEntry
  | AssistantAmendmentEntry
  | HarnessMessageEntry
  | CompactionEntry
  | SubagentResultEntry
  | CallbackStartedEntry;

/**
 * An entry to append, before the engine assigns `seq` and `createdAt`. This
 * is a DISTRIBUTIVE omit — `Omit<ConversationEntry, K>` over a union would
 * collapse to only the keys common to every member (dropping `message`,
 * `summaryMessage`, etc.), so we distribute over the union with a
 * conditional type to omit those fields from each member individually.
 */
export type NewConversationEntry = ConversationEntry extends infer T
  ? T extends ConversationEntry
    ? Omit<T, "seq" | "createdAt">
    : never
  : never;

/**
 * Rebuild the LLM-visible message context from the entry log.
 *
 * If a compaction overlay exists, the context is its summary message
 * followed by every harness message with seq >= firstKeptSeq (a later
 * compaction's firstKeptSeq can point at an earlier summary that was
 * itself appended as a harness message, so layered compactions just work).
 * With no compaction, it's every harness message in order.
 */
export function buildLlmContext(entries: ConversationEntry[]): Message[] {
  let latestCompaction: CompactionEntry | undefined;
  for (const e of entries) {
    if (e.type === "compaction" && (!latestCompaction || e.seq > latestCompaction.seq)) {
      latestCompaction = e;
    }
  }

  const harnessMsgs = entries.filter(
    (e): e is HarnessMessageEntry => e.type === "harness_message",
  );

  if (latestCompaction) {
    const kept = harnessMsgs
      .filter((e) => e.seq >= latestCompaction!.firstKeptSeq)
      .map((e) => e.message);
    return [latestCompaction.summaryMessage, ...kept];
  }
  return harnessMsgs.map((e) => e.message);
}

export interface DisplaySnapshot {
  messages: Message[];
  /** Total display messages available (for pagination UIs). */
  totalMessages: number;
  /** seq of the first message returned (a `beforeSeq` pagination cursor). */
  headSeq: number | null;
}

/**
 * Rebuild the display transcript (the user-visible chat) from the entry
 * log, returning the trailing `tailN` messages. Amendments are folded into
 * their target assistant message; hidden user messages are dropped.
 */
export function buildDisplaySnapshot(
  entries: ConversationEntry[],
  tailN: number,
): DisplaySnapshot {
  const amendmentsByTarget = new Map<string, AssistantAmendmentEntry[]>();
  for (const e of entries) {
    if (e.type === "assistant_amendment") {
      const list = amendmentsByTarget.get(e.targetEntryId) ?? [];
      list.push(e);
      amendmentsByTarget.set(e.targetEntryId, list);
    }
  }

  const built: { seq: number; message: Message }[] = [];
  for (const e of entries) {
    if (e.type === "user_message") {
      if (e.hidden) continue;
      built.push({ seq: e.seq, message: e.message });
    } else if (e.type === "assistant_message") {
      let content = typeof e.message.content === "string" ? e.message.content : "";
      const amendments = amendmentsByTarget.get(e.id);
      if (amendments) {
        for (const a of amendments.sort((x, y) => x.seq - y.seq)) {
          if (a.appendText) content += a.appendText;
        }
      }
      built.push({ seq: e.seq, message: { ...e.message, content } });
    }
  }

  const total = built.length;
  const tail = tailN >= total ? built : built.slice(total - tailN);
  return {
    messages: tail.map((b) => b.message),
    totalMessages: total,
    headSeq: tail.length > 0 ? tail[0]!.seq : null,
  };
}

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
 * Phase 3c read cutover: rebuild a conversation's reader-facing fields from
 * the append-only entry log, with a blob fallback for conversations that
 * predate dual-write.
 *
 * Call this in every conversation `get`/`getWithArchive` path AFTER the
 * Conversation has been constructed from the stored row/blob. It:
 *   - reads the entry log via `readEntries`,
 *   - if NON-EMPTY, overrides `_harnessMessages`, `messages`, and
 *     `pendingSubagentResults` with entry-derived values,
 *   - if EMPTY (un-migrated conversation), leaves the blob-derived fields
 *     untouched (fallback),
 *   - on ANY error, logs and falls back to the blob (never throws — this is
 *     a hot read path).
 *
 * `_continuationMessages` and `pendingApprovals` are NOT modeled as entries
 * yet and are intentionally left as blob fields.
 *
 * Kill-switch: set `PONCHO_READ_ENTRIES=0` to instantly revert to pure blob
 * reads without a deploy (rebuild is ON by default).
 *
 * NOTE: mutates `conversation` in place and returns it. Callers that hand
 * back a shared/mutable Conversation reference (the in-memory stores) MUST
 * pass a clone, or the override will corrupt their stored object.
 */
export async function rebuildConversationFromEntries(
  conversation: Conversation,
  readEntries: (conversationId: string) => Promise<ConversationEntry[]>,
): Promise<Conversation> {
  // Targeted append-only: only `pendingSubagentResults` is read from the
  // entry log, because it's the ONLY conversation field with a write race
  // (a subagent finishing mid-turn vs. the parent turn's whole-blob write).
  // The message history (`messages` / `_harnessMessages`) is written solely
  // by the turn finalize, which the orchestrator serializes per
  // conversation — never raced — so it stays on the blob (known-good, and
  // far simpler than faithfully rebuilding the LLM transcript from entries).
  //
  // Kill-switch: ON by default; PONCHO_READ_ENTRIES="0" reverts to the blob.
  if (process.env.PONCHO_READ_ENTRIES === "0") return conversation;

  try {
    const entries = await readEntries(conversation.conversationId);
    if (entries.length === 0) return conversation; // fallback: pre-dual-write
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
