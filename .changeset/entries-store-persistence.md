---
"@poncho-ai/harness": minor
---

Add append-only conversation entry persistence (Phase 3 substrate).

Introduces `appendEntries` / `readEntries` on the `ConversationStore` and
`StorageEngine.conversations` interfaces, implemented for SQLite, PostgreSQL
(via `SqlStorageEngine`), and the in-memory stores. A new `conversation_entries`
table (migration v8) stores each entry with an app-assigned per-conversation
monotonic `seq`, a unique `id`, a JSON `payload`, and a `UNIQUE
(conversation_id, seq)` constraint.

Purely additive: no existing table, behavior, or read path changes — this is
the foundation for a later dual-write phase.
