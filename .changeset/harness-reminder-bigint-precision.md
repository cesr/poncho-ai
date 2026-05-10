---
"@poncho-ai/harness": patch
---

fix(harness): reminders.scheduledAt no longer rounds on Postgres

Two related Postgres-only bugs in reminder storage:

1. **Schema precision**: the `reminders.scheduled_at` column was declared
   `REAL` so SQLite would get its 8-byte double. Postgres maps `REAL` to
   `float4` (4 bytes, ~7 digit precision), which silently rounds
   millisecond epoch values (13 digits). Every reminder write+read on
   Postgres returned a different value than it stored — and recurring
   reminders would fire at wrong times. New migration v7 alters the
   column to `BIGINT` (Postgres only; SQLite's `REAL` is already
   double-precision and stays).

2. **Wire-format coercion**: `rowToReminder` declared `scheduledAt: row.scheduled_at as number`
   but didn't actually coerce. With BIGINT, postgres-js returns the
   value as a string (deliberate, to avoid JS-side precision loss).
   The `as` cast is type-only; the runtime value stayed a string,
   making strict equality and arithmetic fail. Now coerces with
   `Number(...)`, which is safe — ms epochs max at ~10^16 in year 2286,
   well under `Number.MAX_SAFE_INTEGER` (2^53).

Same coercion applied to `occurrenceCount` for consistency.

Discovered while wiring `/me/reminders` in PonchOS — every PATCH-back
returned a different scheduledAt than was sent.
