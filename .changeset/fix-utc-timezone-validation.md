---
"@poncho-ai/harness": patch
---

fix(harness): accept "UTC" (and "GMT") as valid cron timezones

`AGENT.md` cron jobs with `timezone: "UTC"` were rejected at parse time
with `Invalid timezone at AGENT.md frontmatter cron.<job>: "UTC"`. The
validator was matching against `Intl.supportedValuesOf("timeZone")`,
which returns canonical IANA names only (`"Etc/UTC"`) and excludes
common aliases like `"UTC"` and `"GMT"`, even though `Intl.DateTimeFormat`
accepts them everywhere. The error message ironically cited `"UTC"`
itself as a valid example.

Now delegates to `Intl.DateTimeFormat` directly, which accepts `"UTC"`,
`"GMT"`, every IANA name, and any platform alias the runtime knows about.
