---
"@poncho-ai/harness": patch
---

harness: subagents survive the wall-clock timeout, and can be given a longer budget than the foreground turn.

Previously a subagent that hit its hard `timeout` (vs. `maxSteps`) emitted `run:error` with no `runResult`, so the orchestrator dropped everything it had gathered: the parent received a bare `(no result)`, the subagent was falsely marked `completed`, and the work — often dozens of completed searches, just short of the write step — was lost.

- **Graceful timeout/error delivery.** When a subagent run ends abnormally (timeout or model error) with no `runResult`, the orchestrator now recovers its real output (run response → streamed draft → transcript walk-back, discarding the synthetic `[Error: …]` placeholder), and delivers it tagged so the parent knows it didn't finish — it may not have written its files — with a concrete recovery hint (use the partial work, send a write-only `message_subagent` follow-up, or `read_subagent(…, mode:"full")`). The subagent is marked `status: "error"` (not a fake `completed`) and carries the failure in its `error` field. Applied to both the spawn and continuation paths.
- **`runTimeoutSecOverride` (HarnessOptions).** A constructor-level override for the per-run hard wall-clock timeout, taking precedence over the agent definition's `limits.timeout`. Lets a platform give background subagents a longer budget (e.g. 1h) than a foreground turn (5 min) without forking the agent definition. `0` disables the hard timeout.
