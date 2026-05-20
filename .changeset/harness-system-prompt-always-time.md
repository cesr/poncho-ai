---
"@poncho-ai/harness": minor
---

harness: always inject the current hour into the system prompt

The dynamic system-prompt builder now emits
`Current UTC time (hour precision): Mon 2026-05-20T09Z` on every run,
not just when a `reminderStore` is configured. Knowing "what day is it"
is universally useful — drafting messages, computing relative dates,
deciding whether a stale memory still applies — and isn't specific to
reminder-firing logic.

Format also drops the zeroed-out minutes/seconds tail (`T09:00:00.000Z`
→ `T09Z`) so the hour quantization is visible to the model rather than
hidden behind noise. The prompt-cache properties are unchanged: the
string is still hour-stable and lives in the dynamic prompt section, so
hourly rollovers don't bust the static cache breakpoint.
