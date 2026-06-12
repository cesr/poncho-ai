// ---------------------------------------------------------------------------
// Subagent delivery-queue writers.
//
// `conversation_entries` is the append-only queue that carries a finished
// subagent's result to its parent conversation (see storage/entries.ts for
// the full rationale — short version: subagent results are the one
// conversation field with concurrent writers, so they're delivered by
// INSERT instead of blob read-modify-write). This module owns the write
// side: a safe append wrapper + the two entry builders.
//
// (This file once held a full transcript dual-write + parity checker — the
// Phase 3 groundwork for replacing the conversation blob. That migration
// was deliberately abandoned after the 0.58.0 cutover incident; the unread
// entry types and their writers were deleted rather than maintained as
// drift-prone dead weight.)
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import type { Logger } from "@poncho-ai/sdk";
import type { Conversation, ConversationStore, PendingSubagentResult } from "../state.js";
import type { ConversationEntry, NewConversationEntry } from "../storage/entries.js";

// DISTRIBUTIVE omit (same reasoning as NewConversationEntry in entries.ts): a
// plain Omit<NewConversationEntry, "id"> over a union collapses to the keys
// common to every member, dropping `result`/`consumedSeqs`. Distribute over
// the union so each member keeps its own discriminant fields.
type NewEntryNoId = NewConversationEntry extends infer T
  ? T extends NewConversationEntry
    ? Omit<T, "id">
    : never
  : never;

/**
 * Append entries to the conversation's queue. Best-effort by contract:
 *   - stamps a fresh uuid `id` on each entry (required input column),
 *   - never throws (logs and returns [] on failure),
 *   - safe to `void` when the caller doesn't need the stored rows.
 *
 * Returns the stored entries (with seq/createdAt) — the callback path needs
 * the seqs to record consumption.
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
      `[entries-queue] append failed for ${conversation.conversationId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }
};

export const subagentResultEntry = (
  result: PendingSubagentResult,
): NewEntryNoId => ({ type: "subagent_result", result });

export const callbackStartedEntry = (consumedSeqs: number[]): NewEntryNoId => ({
  type: "callback_started",
  consumedSeqs,
});
