---
"@poncho-ai/harness": patch
---

fix(harness): conversations.search now works on Postgres

The SQL for `engine.conversations.search()` matched `data LIKE $3`, but
`data` is a `jsonb` column in Postgres — `jsonb LIKE text` raises
`operator does not exist: jsonb ~~ unknown` (Postgres error 42883), so
every search call against a Postgres-backed engine 500'd at runtime.

Cast `data` to text in the Postgres branch (`data::text LIKE $3`).
SQLite stores `data` as TEXT-of-JSON, so no cast there.

Discovered while wiring `GET /me/conversations/search` in PonchOS.
