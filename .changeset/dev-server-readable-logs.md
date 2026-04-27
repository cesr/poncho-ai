---
"@poncho-ai/sdk": minor
"@poncho-ai/harness": patch
"@poncho-ai/cli": patch
---

feat(logging): readable, scoped, level-aware dev server logs

`poncho dev` output is now formatted consistently across the CLI and
harness:

```
20:23:45 ✓ poncho     dev server ready at http://localhost:3000
20:23:45 • slack      enabled at /api/messaging/slack
20:23:45 • cron       scheduled 2 jobs: hourly_check, nightly_summary
20:24:15 → cron:hourly_check  started
20:24:17 ✓ cron:hourly_check  completed in 1.2s (3 chats)
20:25:00 ⚠ telegram   approval not found: req-7f42a
20:25:01 ✗ poncho     internal error: ECONNREFUSED
```

Format: `HH:mm:ss <symbol> <scope> <message>`. Scopes (`poncho`, `cron`,
`reminder`, `messaging`, `slack`, `telegram`, `resend`, `subagent`,
`approval`, `browser`, `csrf`, `upload`, `serverless`, `self-fetch`,
`mcp`, `telemetry`, `cost`, `model`, `harness`, `event`, `tools`)
replace the previous mix of `[poncho]`, `[poncho][cost]`, `[cron]`,
`[messaging-runner]`, `[event] ...`, etc.

- New `createLogger(scope)` exported from `@poncho-ai/sdk` with
  `.debug/.info/.warn/.error/.success/.ready/.item/.child(sub)` and
  helpers `formatError`, `url`, `muted`, `num`.
- Honors `NO_COLOR` / `FORCE_COLOR` and `LOG_LEVEL=debug|info|warn|error|silent`.
  Verbose telemetry/cost/event lines now log at `debug` and are silent
  by default.
- `poncho dev` gains `-v`/`--verbose` (debug), `-q`/`--quiet` (warn+),
  and `--log-level <level>` flags.
- Each scope tag is colored with a stable pastel hue (truecolor), with
  256-color and 16-color fallbacks. Children (`cron:hourly_check`)
  inherit their parent's color.
- TTY-aware: ANSI color is stripped when stdout is piped.
- Conversation-egress logging (`[poncho][egress] read: …`) is now opt-in
  via `PONCHO_LOG_EGRESS=1` (matching the documented behavior; it had
  been logging unconditionally).
- No behavior changes to which events are emitted — only formatting.
