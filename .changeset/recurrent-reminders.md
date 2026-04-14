---
"@poncho-ai/harness": minor
"@poncho-ai/cli": minor
---

feat: add recurrent reminders (daily, weekly, monthly, cron)

The `set_reminder` tool now accepts an optional `recurrence` parameter that makes reminders repeat on a schedule instead of firing once. Supports daily, weekly (with specific days-of-week), monthly, and cron expressions. Recurring reminders are rescheduled after each firing and can be bounded by `maxOccurrences` or `endsAt`. Cancel a recurring reminder to stop all future occurrences.
