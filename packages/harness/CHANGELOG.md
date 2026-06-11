# @poncho-ai/harness

## 0.59.0

### Minor Changes

- [#157](https://github.com/cesr/poncho-ai/pull/157) [`3f65382`](https://github.com/cesr/poncho-ai/commit/3f653820c9e0c66a12b544842c1ad3ddefdfd4a6) Thanks [@cesr](https://github.com/cesr)! - storage: scope the entry read-cutover to pendingSubagentResults only

  The append-only read rebuild now overrides ONLY `pendingSubagentResults`
  from the entry log — the single conversation field with a write race (a
  subagent finishing mid-turn vs. the parent turn's whole-blob write). Each
  result is a race-free INSERT (subagent_result entry) and consumption is a
  callback_started entry, so reading it from entries means the parent
  clobbering the blob copy is harmless — that's the clobber-race kill.

  Message history (`messages` / `_harnessMessages`) is written solely by the
  serialized turn finalize and is never raced, so it stays on the blob
  (known-good; far simpler than faithfully rebuilding the LLM transcript
  from entries, which the callback path did not capture correctly).

## 0.58.0

### Minor Changes

- [#155](https://github.com/cesr/poncho-ai/pull/155) [`9939955`](https://github.com/cesr/poncho-ai/commit/9939955585f0ea204e070192827f0b213e84d283) Thanks [@cesr](https://github.com/cesr)! - Phase 3c read cutover: conversation reads rebuild from the append-only
  `conversation_entries` log. Both engines' `get`/`getWithArchive` paths now
  call `rebuildConversationFromEntries`, which overrides `_harnessMessages`
  (via `buildLlmContext`), `messages` (via `buildDisplaySnapshot`, full
  transcript), and `pendingSubagentResults` (via `getPendingSubagentResults`)
  when the entry log is non-empty. Conversations that predate dual-write have
  no entries and fall back to the mutable blob untouched — no migration
  script needed. The rebuild is wrapped in try/catch and never throws on the
  read path. A kill-switch (`PONCHO_READ_ENTRIES=0`) instantly reverts to
  blob reads without a deploy. `_continuationMessages` and `pendingApprovals`
  remain blob fields (not yet modeled as entries).

## 0.57.0

### Minor Changes

- [#153](https://github.com/cesr/poncho-ai/pull/153) [`d39d8fe`](https://github.com/cesr/poncho-ai/commit/d39d8fe0b178c102c728dbb4c000786f0a50a83b) Thanks [@cesr](https://github.com/cesr)! - Dual-write conversation entries + opt-in parity checker (Phase 3b).

  At each conversation write site the orchestrator now ALSO appends the matching
  append-only `ConversationEntry`s (`user_message`, `assistant_message`,
  `assistant_amendment`, `harness_message`, `compaction`, `subagent_result`,
  `callback_started`) alongside the existing mutable-blob write. This is purely
  additive instrumentation: read paths still use the blob, so the dual-write is
  fire-and-forget and can never corrupt behavior.

  An opt-in parity checker (gated on `PONCHO_VERIFY_ENTRIES=1`) rebuilds the LLM
  context and display snapshot from the entry log after each turn finalizes and
  logs any divergence from the blob under a `[entries-parity]` prefix. It never
  throws.

  Re-exports the entry types and rebuild functions (`buildLlmContext`,
  `buildDisplaySnapshot`, `getPendingSubagentResults`) from the package root so
  downstream consumers can build on the substrate.

## 0.56.0

### Minor Changes

- [#151](https://github.com/cesr/poncho-ai/pull/151) [`4c116d8`](https://github.com/cesr/poncho-ai/commit/4c116d8f883c1d486b86b6c254334602326d7713) Thanks [@cesr](https://github.com/cesr)! - Add append-only conversation entry persistence (Phase 3 substrate).

  Introduces `appendEntries` / `readEntries` on the `ConversationStore` and
  `StorageEngine.conversations` interfaces, implemented for SQLite, PostgreSQL
  (via `SqlStorageEngine`), and the in-memory stores. A new `conversation_entries`
  table (migration v8) stores each entry with an app-assigned per-conversation
  monotonic `seq`, a unique `id`, a JSON `payload`, and a `UNIQUE
(conversation_id, seq)` constraint.

  Purely additive: no existing table, behavior, or read path changes — this is
  the foundation for a later dual-write phase.

## 0.55.0

### Minor Changes

- [#149](https://github.com/cesr/poncho-ai/pull/149) [`f5a8260`](https://github.com/cesr/poncho-ai/commit/f5a8260d0515038afc1797d00507908c334115ff) Thanks [@cesr](https://github.com/cesr)! - compaction: preserve subagent context and prior summaries, harden the split

  Three improvements to context compaction (fires at ~75% context):
  - **Split safety**: `findSafeSplitPoint` now refuses a split whose compacted
    side would end on an assistant message with unanswered `tool_calls` (its
    answering `role:"tool"` result having moved to the preserved side), walking
    earlier to the next clean `user` boundary. Prevents orphaning a tool-call
    relationship inside the summary boundary. Still returns `-1` when no safe
    point exists.
  - **Subagent ledger**: while compacting, scans for subagent-callback records
    (metadata `_subagentCallback`/`subagentCallback`, or text starting with
    `[Subagent Result]`) and any `## Subagents` block embedded in a prior
    compaction summary, then renders a combined, deduped (by `subagentId`)
    ledger that is appended VERBATIM after the LLM summary text — so the model
    can never paraphrase or truncate subagent results away. Cumulative across
    successive compactions.
  - **Cumulative summary**: when the first compacted message is itself a prior
    compaction summary, it is passed to the summarizer in full (not truncated
    to 1200 chars) and the prompt instructs the model to merge-and-update the
    prior working state rather than re-summarize it from scratch. All other
    messages keep the 1200-char truncation.

## 0.54.0

### Minor Changes

- [#147](https://github.com/cesr/poncho-ai/pull/147) [`a3eed14`](https://github.com/cesr/poncho-ai/commit/a3eed142832318b6397cd73819d3296c79d6eff0) Thanks [@cesr](https://github.com/cesr)! - storage: add append-only conversation-entry substrate (unused groundwork)

  Pure entry types + rebuild functions (`buildLlmContext`,
  `buildDisplaySnapshot`, `getPendingSubagentResults`) for the eventual
  append-only conversation model that removes the mutable-blob clobber race
  (the root cause behind lost subagent results). No storage-engine wiring
  and no live callers yet — additive, deploys nothing behavioral. The
  rebuild logic (compaction overlay, amendment folding, callback-consumption)
  is covered by unit tests so the design is proven before the bigger
  dual-write / migration / cutover PRs.

## 0.53.0

### Minor Changes

- [#145](https://github.com/cesr/poncho-ai/pull/145) [`bfa4976`](https://github.com/cesr/poncho-ai/commit/bfa4976ac8b05a300e22271e23c3bae4aadae2a8) Thanks [@cesr](https://github.com/cesr)! - events: add stable identity so streaming clients match instead of guess

  Additive fields that let a streaming client reconstruct view-state by
  identity rather than inferring structure from event order (the source of a
  class of reconnect/subagent rendering bugs):
  - `tool:started` / `tool:completed` / `tool:error` now carry `toolCallId`
    (already in scope as `call.id` / `result.callId`). Clients match tool
    pills by id instead of by tool name.
  - `subagent:spawned|completed|error|stopped` now carry `parentToolCallId`
    (the `spawn_subagent` tool call's id) and `task`; `completed`/`error`
    also carry `resultText`. Clients attach subagent state to the spawning
    tool's pill and render the result inline — no header-regex or
    sequential-cursor pairing needed.
  - `ToolContext` gains `toolCallId` so the `spawn_subagent` handler can
    record which call produced the subagent (plumbed: tool-dispatcher →
    spawn handler → `SubagentSpawnOptions.parentToolCallId` →
    `subagentMeta.parentToolCallId` → the events above).
  - `run:started` gains an optional `cause` field in the type
    (`user|continuation|subagent_callback|approval_resume`); emission is
    deferred to a later pass.

  All fields are additive; older clients ignore them.

### Patch Changes

- Updated dependencies [[`bfa4976`](https://github.com/cesr/poncho-ai/commit/bfa4976ac8b05a300e22271e23c3bae4aadae2a8)]:
  - @poncho-ai/sdk@1.15.0

## 0.52.2

### Patch Changes

- [#124](https://github.com/cesr/poncho-ai/pull/124) [`4ae26e0`](https://github.com/cesr/poncho-ai/commit/4ae26e0d8d2788f57411f9c17e10766769514f9b) Thanks [@cesr](https://github.com/cesr)! - harness: postgres retry covers exec/transaction + 3 attempts + tighter idle

  Follow-up to the previous `idle_timeout`/`max_lifetime`/retry patch.
  Live testing on Railway showed the previous values weren't tight
  enough — `write CONNECTION_ENDED postgres.railway.internal:5432`
  still surfaced both during user-facing chat turns and during
  subagent auto-callback reruns, despite the new config and the
  one-shot retry.

  Two failure modes the previous version didn't cover:
  1. The retry only wrapped `private query()` (executor.run/get/all),
     but `executor.exec` (`sql.unsafe`) and `executor.transaction`
     (`sql.begin`) called the postgres.js client directly. A pg drop
     inside a transaction or migration write threw straight through.
  2. After an idle period the pool can have multiple stale sockets;
     a single retry can checkout a second stale socket from the pool
     and fail again. One-shot retry exhausted into an error visible
     to the caller.

  Fixes:
  - All three executor paths (`run/get/all`, `exec`, `transaction`)
    now go through the same `runWithRetry` wrapper. Transactions
    only retry the connection-level `CONNECTION_ENDED` reject from
    the postgres.js client — actual SQL errors mid-transaction
    surface as a different error class and bypass the retry,
    preserving atomic semantics.
  - Three attempts with light exponential backoff (0, 50ms, 200ms).
    Enough to ride out a typical staleness wave; if all three fail
    the network is genuinely broken.
  - `CONNECT_TIMEOUT` and `ECONNRESET` added to the retry-eligible
    error codes.

  Config knobs tightened:
  - `idle_timeout: 5` (was 20). Empirically Railway's pg drops
    sockets well before 20s; 5s wins the race in practice while
    staying long enough for bursty workloads to reuse connections.
  - `max_lifetime: 300` (was 600). Same reasoning — recycle more
    aggressively.
  - `connect_timeout: 10` (was 30 default). Faster failure during
    incidents lets callers shed load instead of stacking up.

- [#144](https://github.com/cesr/poncho-ai/pull/144) [`28d640b`](https://github.com/cesr/poncho-ai/commit/28d640b2f82ea780f8e0be90965972d9903c01d7) Thanks [@cesr](https://github.com/cesr)! - orchestrator: make subagent result delivery reliable

  Subagent results could silently never reach the parent agent. Several
  plumbing bugs in `runSubagent` / `runSubagentContinuation`:
  - **Emit-before-persist race.** `subagent:completed` / `subagent:error`
    were emitted to the parent's event stream _before_ the result was
    written to the store, so a consumer reacting to the event (the parent
    callback, the streaming client) could race the write. Now the result
    is persisted first, then the event is emitted.
  - **Silently swallowed writes.** Two `appendSubagentResult(...).catch(() => {})`
    call sites (the error path and the continuation-error path) dropped the
    result with no trace on a transient store failure. Replaced with a
    shared `appendSubagentResultReliable` helper that retries once and then
    logs loudly — a dropped result is the worst failure mode (the parent
    waits forever on a subagent it thinks is still running).
  - **Un-awaited eventSink.** The subagent-callback run path was the lone
    `this.eventSink(...)` call site that didn't `await` (every other site
    does), so callback-turn events could interleave out of order. Now awaited.
  - **Spawn rejections went to a bare `console.error`.** A background
    `runSubagent` that rejected outside its own try/catch left the parent
    hanging. Both fire-and-forget spawn paths now route to a
    `handleSpawnFailure` that marks the child errored and hands the parent
    an error result so the turn can resume.
  - **`recoverStaleSubagents` now also drains undelivered results.** It
    previously only rescued children stuck in `running`; it now also
    re-triggers the parent callback for any parent that has results sitting
    in the store with no active run (e.g. a result persisted just before a
    process restart, whose in-memory callback trigger was lost).

## 0.52.1

### Patch Changes

- [`0e8fff1`](https://github.com/cesr/poncho-ai/commit/0e8fff12aed9d5efe1821ed3560ead48a16113c1) Thanks [@cesr](https://github.com/cesr)! - Only send `temperature` to the model when the agent explicitly sets one. The harness previously defaulted to `temperature: 0.2` and always passed it to `streamText`, which returns a 400 ("`temperature` is deprecated for this model") on models that removed sampling params (Fable 5, Opus 4.7+). `temperature` is now omitted from the request when undefined — the same treatment `maxTokens` already had — and `defaultAgentDefinition` no longer hard-codes a `temperature` line into the generated frontmatter (pass `temperature` explicitly to set one).

## 0.52.0

### Minor Changes

- [`d8453b4`](https://github.com/cesr/poncho-ai/commit/d8453b4f2360a1734e448960fe52f6c450cdf842) Thanks [@cesr](https://github.com/cesr)! - harness: propagate `suppressTelemetry` to subagents.

  A telemetry-off run (e.g. incognito) now suppresses telemetry for the subagents it spawns too, not just the parent turn. The parent run's `suppressTelemetry` is exposed on `ToolContext`, captured by `spawn_subagent` into the new `SubagentManager.spawn({ suppressTelemetry })` option, stored on the subagent conversation's `subagentMeta`, and read back by the orchestrator's `runSubagent` / continuation so the child run (and its re-runs) emit no `invoke_agent` / `execute_tool` / AI-SDK spans.

### Patch Changes

- Updated dependencies [[`d8453b4`](https://github.com/cesr/poncho-ai/commit/d8453b4f2360a1734e448960fe52f6c450cdf842)]:
  - @poncho-ai/sdk@1.14.0

## 0.51.1

### Patch Changes

- [`3c72a7f`](https://github.com/cesr/poncho-ai/commit/3c72a7f0861dbe2c623931e3a08e1a89a14554b1) Thanks [@cesr](https://github.com/cesr)! - harness: forward `suppressTelemetry` through `runConversationTurn` and `continueFromToolResult`.

  `RunConversationTurnOpts` and `continueFromToolResult`'s input now carry `suppressTelemetry`, passed into the run input (alongside the existing `disablePromptCache` passthrough). Hosts driving turns through these helpers (rather than calling `runWithTelemetry` directly) can now suppress telemetry per turn and per approval-resume — the missing piece for serving telemetry-off (incognito) turns and their continuations from a single shared harness.

## 0.51.0

### Minor Changes

- [`773f113`](https://github.com/cesr/poncho-ai/commit/773f11309e2410d6c5e17af0fde17425953105f2) Thanks [@cesr](https://github.com/cesr)! - harness: add a per-run `suppressTelemetry` flag so one harness can serve both telemetry-on and telemetry-off runs.

  Telemetry was effectively an instance-level property: whether the OTLP exporter is attached is decided at construction, so a host that wants telemetry-off runs (e.g. incognito) had to build and maintain a _second_ harness instance with no exporter — duplicating all per-harness provisioning (tool registration, subagent manager, etc.) and risking drift between the two.

  `RunInput.suppressTelemetry` lets a single harness — built once, with the exporter attached — emit nothing for a given run: the `invoke_agent` root span, the `execute_tool` spans, and the AI-SDK spans are all gated on `!input.suppressTelemetry`. Hosts can now keep one harness per user and pass `suppressTelemetry: true` per run instead of routing to a parallel exporter-less instance.

### Patch Changes

- Updated dependencies [[`773f113`](https://github.com/cesr/poncho-ai/commit/773f11309e2410d6c5e17af0fde17425953105f2)]:
  - @poncho-ai/sdk@1.13.0

## 0.50.5

### Patch Changes

- [`991a4b9`](https://github.com/cesr/poncho-ai/commit/991a4b98d6683c105c7aae50551d30b16080d618) Thanks [@cesr](https://github.com/cesr)! - harness: subagents survive the wall-clock timeout, and can be given a longer budget than the foreground turn.

  Previously a subagent that hit its hard `timeout` (vs. `maxSteps`) emitted `run:error` with no `runResult`, so the orchestrator dropped everything it had gathered: the parent received a bare `(no result)`, the subagent was falsely marked `completed`, and the work — often dozens of completed searches, just short of the write step — was lost.
  - **Graceful timeout/error delivery.** When a subagent run ends abnormally (timeout or model error) with no `runResult`, the orchestrator now recovers its real output (run response → streamed draft → transcript walk-back, discarding the synthetic `[Error: …]` placeholder), and delivers it tagged so the parent knows it didn't finish — it may not have written its files — with a concrete recovery hint (use the partial work, send a write-only `message_subagent` follow-up, or `read_subagent(…, mode:"full")`). The subagent is marked `status: "error"` (not a fake `completed`) and carries the failure in its `error` field. Applied to both the spawn and continuation paths.
  - **`runTimeoutSecOverride` (HarnessOptions).** A constructor-level override for the per-run hard wall-clock timeout, taking precedence over the agent definition's `limits.timeout`. Lets a platform give background subagents a longer budget (e.g. 1h) than a foreground turn (5 min) without forking the agent definition. `0` disables the hard timeout.

## 0.50.4

### Patch Changes

- [`9a39327`](https://github.com/cesr/poncho-ai/commit/9a393274d8a8061371d268fa81db3501cb0a8308) Thanks [@cesr](https://github.com/cesr)! - harness: fix three `run_code` / cancellation bugs.
  - **Timers polyfill never fired delayed callbacks.** `setTimeout(fn, ms)` only ran the callback when `ms === 0`; any non-zero delay was stored and never invoked, so `await new Promise(r => setTimeout(r, 50))` (the standard sleep) hung forever. The polyfill now drains pending timers on the microtask queue in delay order against a virtual clock, so sleeps resolve and `setInterval`/`clearInterval` work.
  - **No wall-clock bound on `run_code`.** isolated-vm's `timeout` only bounds synchronous execution; a script that returns a never-settling promise hung the whole turn indefinitely. `runtime.execute` now races the eval against a host timer that disposes the isolate, so `isolate.timeLimit` bounds total execution and returns a `TimeoutError`.
  - **Stopping a turn mid-tool-call dropped the assistant turn from canonical history.** On cancellation the in-flight assistant message (its text + tool calls) lives only in step-local state — it's pushed to `messages` together with the tool results, which never arrive when stopped. The cancellation snapshot now re-attaches that turn with a synthesized "cancelled by user" tool result for each pending tool call, so the next request keeps a valid record instead of showing the model back-to-back user messages.

- [`c604fd6`](https://github.com/cesr/poncho-ai/commit/c604fd6b41dfd06600af85daa892ab4fd3852bad) Thanks [@cesr](https://github.com/cesr)! - harness: harden subagent → parent result delivery so a step-exhausted subagent stops surfacing as `(no response)`.
  - **Force a closing text turn on the final step.** On the last permitted step (`step === maxSteps`) the run loop now strips the tools and appends a one-shot "summarize now, no tools" nudge to that model request, so a run that hits its step ceiling produces a real text summary instead of terminating on a dangling tool call. Previously such a run ended on a tool-call turn with no final text — common in subagents doing many tool calls — and the parent received an empty result. `maxSteps` itself is unchanged; the nudge is request-only and never written to history.
  - **Content-shape-robust result extraction.** Pulling a subagent's response no longer requires the last assistant message to be a plain `string`. The new `lastAssistantText` helper handles `string`, `ContentPart[]`, and the run loop's `{"text":...,"tool_calls":[...]}` envelope, and walks backwards to the last non-empty assistant text — so a transcript that ends on a text-less tool turn still yields the prose produced just before it.
  - **Actionable empty-result sentinel.** When a subagent genuinely produced no summary, the injected parent message now says how many steps ran and points at `read_subagent(<id>, mode:"assistant")` to recover the work, instead of a dead-end `(no response)`.

## 0.50.3

### Patch Changes

- [`a67fb45`](https://github.com/cesr/poncho-ai/commit/a67fb45162823d832296ae9af137eb566d9f2f97) Thanks [@cesr](https://github.com/cesr)! - harness: forward `tenantId` through `continueFromToolResult`. Resumed runs (after an approval checkpoint) ran tools with `ctx.tenantId` undefined, so tenant-scoped stores (memory, VFS, todos) resolved the default `"__default__"` tenant instead of the caller's — surfacing as `memory_main_get` returning empty after an approval resume.

## 0.50.2

### Patch Changes

- [#133](https://github.com/cesr/poncho-ai/pull/133) [`60e21c8`](https://github.com/cesr/poncho-ai/commit/60e21c8c18054d2824cf7364b71dabfd07574b48) Thanks [@cesr](https://github.com/cesr)! - harness: don't inject the "interrupted by a time limit" bridge when resuming from tool results

  A taskless `run()` (continuation checkpoint, or `continueFromToolResult` —
  e.g. resuming after an approval gate) injected a synthetic user message
  telling the model its turn was "interrupted by a time limit ... continue
  EXACTLY from where you left off, do not re-summarize." That bridge is only
  appropriate when the model was actually cut off mid-response (the last
  message is an `assistant` turn, which some providers also reject as a
  conversation-ending message).

  When the last message is a `tool` result — which is the case for every
  `continueFromToolResult` resume — the conversation already ends in a
  provider-valid user `tool_result` block and the model continues from the
  results naturally. Injecting the bridge there was a bug: after a normal
  approval resolution the model was told its turn had been killed by a time
  limit, causing it to distrust and re-derive context (re-reading the VFS,
  concluding it had "hallucinated" data it had legitimately loaded). The
  bridge is now only added when the last message is an `assistant` turn, and
  its wording no longer hard-codes "time limit" (max-steps checkpoints use
  the same path).

## 0.50.1

### Patch Changes

- [#131](https://github.com/cesr/poncho-ai/pull/131) [`9e0ccd8`](https://github.com/cesr/poncho-ai/commit/9e0ccd8307ab056f94b7efc3e25a0cb71ee75625) Thanks [@cesr](https://github.com/cesr)! - harness: strip `poncho-upload://` scheme in `S3UploadStore.get` / `.delete`

  `createUploadStore({ provider: "s3" })` wraps `S3UploadStore` in
  `CachedUploadStore`, whose `put` returns a `poncho-upload://<key>` ref
  and stores the underlying S3 object at the bare `<key>`. On read,
  `CachedUploadStore.get` checks an in-memory cache (10-minute TTL); on
  miss it falls through to `S3UploadStore.get(<ref>)`. Pre-fix, the S3
  store treated the scheme-prefixed ref as a literal S3 key and hit the
  backend with `poncho-upload://<key>` — guaranteed `NoSuchKey`.

  In practice this meant a chat message with an attached image worked on
  the turn it was uploaded (cache hit) and then started showing as
  "[Attached file: … — file is no longer available]" on every follow-up
  turn ~10 minutes later (cache miss → S3 NoSuchKey → outer catch in the
  harness resolver). The same path worked for the local-fs store, which
  strips the scheme in both `get` and `delete`.

  `S3UploadStore.get` now strips the scheme before issuing
  `GetObjectCommand`. `S3UploadStore.delete` already stripped `https://`
  and now strips `poncho-upload://` too.

## 0.50.0

### Minor Changes

- [#129](https://github.com/cesr/poncho-ai/pull/129) [`85b8eec`](https://github.com/cesr/poncho-ai/commit/85b8eeca593b1043e2f7da01d681db6d32b1a969) Thanks [@cesr](https://github.com/cesr)! - harness: provider-backed VFS mounts + binary fetch bodies

  Two additive isolate/VFS changes.

  **`MountProvider` for `VirtualMount`.** A virtual mount can now be backed
  by a custom data source instead of a local-disk directory. Set
  `provider: { readdir, stat, readFileBuffer }` instead of `source` on a
  `VirtualMount`. The adapter routes read operations through the provider
  and rejects writes the same way it does for disk-backed mounts. Lets a
  host expose database rows / object-store keys as a VFS subtree without
  materialising them on disk (e.g. PonchOS exposing user uploads at
  `/uploads`). `getAllPaths` advertises only the mount root for provider
  mounts (deep listing would require sync IO over a remote backend);
  shallow listing is sufficient for bash glob/find at the mount root.

  **Binary `fetch()` bodies in `run_code`.** The isolate fetch polyfill
  used to coerce `init.body` to a string before sending it to the
  `__poncho_fetch` binding, so passing a `Uint8Array`, `ArrayBuffer`, or
  `Blob` arrived server-side as `"1,2,3,..."` — every binary upload
  (image-edit APIs, file uploads) was corrupted. The polyfill now
  base64-encodes binary bodies with a new `bodyEncoding: "base64"` field
  on the binding input; the built-in `createFetchBinding` decodes back to
  raw bytes before fetching. Custom bindings that replace `__poncho_fetch`
  should add the same decoding (cf. PonchOS `createSecretAwareFetchBinding`).
  String bodies are unchanged.

## 0.49.0

### Minor Changes

- [#127](https://github.com/cesr/poncho-ai/pull/127) [`87b40d9`](https://github.com/cesr/poncho-ai/commit/87b40d9d6cebba4ac646598d154a767a1d2f3551) Thanks [@cesr](https://github.com/cesr)! - harness: stop truncating main memory by default

  Main memory injected into the system prompt was hard-truncated at 4000
  characters with a `...[truncated]` marker. Silently dropping the tail of
  a user's memory every turn is a footgun, so the **default is now no
  truncation** — the full memory is injected.

  New `MemoryConfig.maxPromptChars` (also settable via
  `storage.memory.maxPromptChars`) lets a consumer opt back _into_ a cap
  for prompt-cost control: set a positive number and content beyond it is
  sliced with the `...[truncated]` marker as before.

  Behavior change: consumers that relied on the implicit 4000-char cap
  will now see full memory in the prompt. To restore the old behavior set
  `maxPromptChars: 4000`.

## 0.48.0

### Minor Changes

- [#125](https://github.com/cesr/poncho-ai/pull/125) [`ff66aae`](https://github.com/cesr/poncho-ai/commit/ff66aaeebe6017ca9e1ee4b31ffe0d89bdf5ef28) Thanks [@cesr](https://github.com/cesr)! - harness: add `systemSkillPaths` for platform-shipped system skills

  New optional `HarnessOptions.systemSkillPaths` (absolute directories,
  each scanned for `<name>/SKILL.md` at init). System skills are surfaced
  in `<available_skills>` like any other skill, with their bodies read
  from local disk on activation — letting a platform ship default skills
  with the deploy instead of writing them into every tenant's VFS.

  Precedence is purely additive: per tenant the skill set resolves as
  repo skills > the tenant's own VFS skills > system skills. So a tenant's
  `/skills/<same-name>/` overrides a same-named system skill (mirroring
  the VFS override behavior platforms already rely on for system jobs),
  and the existing repo-vs-VFS precedence is unchanged. Empty by default —
  no behavior change for existing consumers.

  Also exports `loadSkillMetadataFromDirs(dirs)` (extracted from
  `loadSkillMetadata`) for scanning an explicit list of absolute skill
  directories.

## 0.47.1

### Patch Changes

- [#122](https://github.com/cesr/poncho-ai/pull/122) [`661536b`](https://github.com/cesr/poncho-ai/commit/661536b8d24691d91dc01e345b828ef6c9884beb) Thanks [@cesr](https://github.com/cesr)! - harness: postgres connection-pool resilience for managed-postgres hosts

  Managed Postgres providers (Railway, Neon, Heroku, etc.) drop idle
  TCP connections server-side after a few minutes. The previous
  postgres-engine config left `idle_timeout` at the porsager/postgres
  default (0 = never close client-side), so the pool accumulated stale
  sockets; the first query on one rejected with `write CONNECTION_ENDED
<host>:5432` at `durMs=0` and bubbled up as a hard failure to the
  caller — including user-facing chat turns and the orchestrator's
  subagent callback rerun.

  Two complementary settings, plus one belt-and-suspenders retry:
  - `idle_timeout: 20` — close idle client-side connections before
    any reasonable provider-side timer fires. Fresh connection on
    next checkout, no stale-socket race.
  - `max_lifetime: 60 * 10` (10 min) — recycle long-lived
    connections defensively, sidestepping provider-side
    "max connection age" limits.
  - `private query()` now retries once on `CONNECTION_ENDED` /
    `CONNECTION_CLOSED` / `CONNECTION_DESTROYED`. Covers the
    narrow race where a query lands on a connection at the exact
    instant the provider drops it.

  Defaults unchanged: `max: 10`, `connect_timeout: 30`. Migration DDL
  (`sql.unsafe(sql)` inside `executeRaw`) and transactions
  (`sql.begin(...)`) deliberately don't go through the retry — DDL
  is `IF NOT EXISTS` idempotent and transactions need atomic scoping.

  Observed in production: the PonchOS api running on Railway hit this
  during a subagent test, the orchestrator's auto-callback rerun
  threw the connection-ended error, a concurrent unhandled async
  rejection killed the node process, and Railway restarted the
  replica (~50s). User-facing chat turns started seeing the same
  error after that. Patch eliminates the source.

## 0.47.0

### Minor Changes

- [#120](https://github.com/cesr/poncho-ai/pull/120) [`6cda4ab`](https://github.com/cesr/poncho-ai/commit/6cda4ab39865d89590f42927e281c5fb58cc99f4) Thanks [@cesr](https://github.com/cesr)! - harness: always inject the current hour into the system prompt

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

## 0.46.0

### Minor Changes

- [#118](https://github.com/cesr/poncho-ai/pull/118) [`e8df464`](https://github.com/cesr/poncho-ai/commit/e8df4649618cba0b408a6c143f923f0dcb2046c8) Thanks [@cesr](https://github.com/cesr)! - harness: 1h static system-prompt cache breakpoint + per-run cache kill-switch

  Two related changes to Anthropic prompt caching:

  **1-hour static system-prompt breakpoint.** The harness now splits the
  assembled system prompt into a static portion (agent body + skill
  context + browser/fs/isolate context — stable across many turns and
  jobs within an hour) and a dynamic tail (memory, todos, time). On
  Anthropic models, these are sent as two `role: "system"` messages with
  `cacheControl: { ttl: "1h" }` on the static block. The existing 5-min
  tail breakpoint on the last user/assistant/tool message is retained.

  This lets later turns and job runs read ~95% of the system prompt at
  0.1× (cache read) instead of paying 1× whenever the 5-min tail cache
  has expired — the previous setup only cached for 5 minutes via the
  tail breakpoint. Within-user cross-conversation and interactive-vs-job
  all share the static cache.

  **Per-run cache kill-switch.** Added `RunInput.disablePromptCache?:
boolean` (also exposed on `RunConversationTurnOpts.disablePromptCache`,
  forwarded into `runInput`). When set, the harness skips the 5-min tail
  breakpoint for that run. The 1-hour static breakpoint is still
  applied — the run still benefits from reading the shared static cache,
  just doesn't write a new tail entry that won't be read before TTL.

  Intended for one-shot programmatic invocations (cron-fired jobs,
  subagent dispatch) where no follow-up turn is coming within the 5-min
  TTL window, so the 1.25× write surcharge would be pure waste.

  Non-Anthropic providers fall through to the previous single concatenated
  `system:` string with no cache control — those providers auto-cache.

  Internal: `isAnthropicModel` is now exported from `prompt-cache.ts`
  for reuse at the streamText site.

### Patch Changes

- Updated dependencies [[`e8df464`](https://github.com/cesr/poncho-ai/commit/e8df4649618cba0b408a6c143f923f0dcb2046c8)]:
  - @poncho-ai/sdk@1.12.0

## 0.45.0

### Minor Changes

- [`1adaae2`](https://github.com/cesr/poncho-ai/commit/1adaae2d4cc55800f01d602f2a7d6ecc65031443) Thanks [@cesr](https://github.com/cesr)! - harness: device-dispatch mode for tools that execute on a connected client

  Tools can now be marked `dispatch: "device"` on `loadedConfig.tools`. When
  the model calls such a tool the dispatcher pauses the run, emits a new
  `tool:device:required` event, and checkpoints with the new
  `kind: "device"` discriminator on `pendingApprovals` — same plumbing as
  the approval flow, different trigger and different resume payload.
  Consumers (e.g. PonchOS for iOS device tools) drive the external
  execution and feed the result back via `continueFromToolResult`.

  Approval can be combined: `{access: "approval", dispatch: "device"}`
  yields the approval card first, then on resume falls through to the
  device-required event. The wire vocabulary for approvals
  (`approvalId` etc.) is unchanged; the `pendingApprovals` column /
  field name stays.

  `ToolAccess` is broadened to accept both the legacy string `"approval"`
  and the new `{access?, dispatch?}` object form. Existing configs keep
  working unchanged.

- [`6132601`](https://github.com/cesr/poncho-ai/commit/613260159cdd80fcc02d68aa58ad52d4465bcede) Thanks [@cesr](https://github.com/cesr)! - harness: add `read_subagent` tool for fetching subagent transcripts

  Parent agents can now read a spawned subagent's conversation directly
  instead of using `message_subagent` to ask it to repeat its work. The
  new tool accepts a `mode` parameter — `"final"` (last assistant message,
  default), `"assistant"` (assistant messages only), or `"full"` (every
  message including tool calls and results) — plus optional `since_index`
  and `max_messages` for paging long transcripts.

  Access is restricted to direct children: a parent can only read
  transcripts of subagents whose `parentConversationId` matches its own
  conversation. The `SubagentManager` interface gains a corresponding
  `getTranscript` method.

### Patch Changes

- Updated dependencies [[`1adaae2`](https://github.com/cesr/poncho-ai/commit/1adaae2d4cc55800f01d602f2a7d6ecc65031443)]:
  - @poncho-ai/sdk@1.11.0

## 0.44.0

### Minor Changes

- [`e6f5c14`](https://github.com/cesr/poncho-ai/commit/e6f5c142a368389b3eb62e80731612048d9198b5) Thanks [@cesr](https://github.com/cesr)! - VFS adapter now supports read-only virtual mounts. `HarnessOptions.virtualMounts` accepts entries like `{ prefix: "/system/", source: "/path/on/disk" }`; reads under the prefix are served from the local filesystem source directory, writes are rejected with `EROFS`. Used by platforms (e.g. PonchOS) to expose deployment-shipped defaults without persisting them in each tenant's VFS — improvements ship via normal deploys and tenant data stays portable. Empty by default; CLI/dev workflows are unaffected.

### Patch Changes

- [`b171c0e`](https://github.com/cesr/poncho-ai/commit/b171c0e9c4cdc149e8282611f7333519b5e04e38) Thanks [@cesr](https://github.com/cesr)! - harness: properly decode `FileInput.data` per its documented contract

  `FileInput.data` is documented in `@poncho-ai/sdk` as accepting raw
  base64, `data:<mime>;base64,<…>` URIs, or `https?://` URLs. The
  runtime used to call `Buffer.from(data, "base64")` unconditionally,
  which silently produced garbage bytes for data URIs (Node's base64
  decoder ignores invalid chars like `:` `;` `,` rather than throwing,
  so the file's magic bytes were destroyed). Anthropic responded with
  "Could not process image" on every turn that attached an image as a
  data URI — including PonchOS's `resolveAttachment`, which built data
  URIs by following the documented format.

  Introduce `decodeFileInputData(data)` in `upload-store.ts` that
  detects the three formats and decodes accordingly, and call it from
  `AgentHarness.run` and `runConversationTurn` instead of the inline
  `Buffer.from(_, "base64")`. Pinned by a new test that exercises raw
  base64, simple data URIs, and data URIs with mime parameters.

  Callers that have been passing raw base64 all along see no behavior
  change.

- [`4d322f7`](https://github.com/cesr/poncho-ai/commit/4d322f79900f449d1f7783f697eef0351cd45f0a) Thanks [@cesr](https://github.com/cesr)! - fix(harness): reminders.scheduledAt no longer rounds on Postgres

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

- [`1499eb4`](https://github.com/cesr/poncho-ai/commit/1499eb4f63cc480fb42ec4e5568e023b84e54b5a) Thanks [@cesr](https://github.com/cesr)! - harness: discover VFS skills written without running bash

  Per-tenant VFS skill discovery was tied to the storage engine's
  in-memory path cache, which was only ever populated by
  `bash-manager.refreshPathCache` before a bash invocation. Chat-only
  flows (PonchOS's iOS Files browser, the `write_file` tool, any agent
  that never shells out) left the cache empty, the patched `writeFile`'s
  incremental update was a silent no-op (it only mutates when the cache
  is already initialized for that tenant), and the skill fingerprint
  stuck at `""` for the lifetime of the harness instance — so any
  SKILL.md authored after `getSkillsForTenant` first ran for a tenant
  was invisible from that point forward.

  Refresh the engine's path cache inside `getSkillsForTenant` before
  computing the fingerprint. One extra SELECT-paths round-trip per
  turn (skills are checked once per `buildSystemPrompt`); correctness
  for the increasingly common no-bash deployments wins easily over the
  saved query.

  Surfaced by PonchOS (no bash, iOS Files + write_file is the only way
  SKILL.md ends up in `/skills/`).

## 0.43.1

### Patch Changes

- [`134fae7`](https://github.com/cesr/poncho-ai/commit/134fae7eb4f3658b8d2dc0a5e560b0bcad094679) Thanks [@cesr](https://github.com/cesr)! - fix(harness): conversations.search now works on Postgres

  The SQL for `engine.conversations.search()` matched `data LIKE $3`, but
  `data` is a `jsonb` column in Postgres — `jsonb LIKE text` raises
  `operator does not exist: jsonb ~~ unknown` (Postgres error 42883), so
  every search call against a Postgres-backed engine 500'd at runtime.

  Cast `data` to text in the Postgres branch (`data::text LIKE $3`).
  SQLite stores `data` as TEXT-of-JSON, so no cast there.

  Discovered while wiring `GET /me/conversations/search` in PonchOS.

## 0.43.0

### Minor Changes

- [`ff89631`](https://github.com/cesr/poncho-ai/commit/ff89631715e54d6fdce174943e6e0fc9e4ce5d1e) Thanks [@cesr](https://github.com/cesr)! - harness: export `defaultAgentDefinition` so SDK consumers can match `poncho init` exactly

  Lifts the `AGENT_TEMPLATE` markdown body from `@poncho-ai/cli` (where it lived
  inside the `init` scaffolding) into a public helper on `@poncho-ai/harness`.
  SDK consumers (PonchOS, custom servers, anyone calling
  `new AgentHarness({ agentDefinition })` directly) can now do:

  ```ts
  import { defaultAgentDefinition } from "@poncho-ai/harness";

  const harness = new AgentHarness({
    agentDefinition: defaultAgentDefinition({
      name: "poncho",
      modelName: "claude-sonnet-4-6",
    }),
    // ... storageEngine, config, etc.
  });
  ```

  This eliminates hand-copying the template — drift between consumers and
  `poncho init` is no longer possible.

  The CLI's `AGENT_TEMPLATE` export is preserved as a thin back-compat
  wrapper that delegates to `defaultAgentDefinition`. No behavior change.

  API additions (harness):
  - `defaultAgentDefinition(opts?: DefaultAgentDefinitionOptions): string`
  - `DefaultAgentDefinitionOptions`
  - `DEFAULT_AGENT_NAME`, `DEFAULT_AGENT_DESCRIPTION`,
    `DEFAULT_MODEL_PROVIDER`, `DEFAULT_MODEL_NAME`, `DEFAULT_TEMPERATURE`,
    `DEFAULT_MAX_STEPS`, `DEFAULT_TIMEOUT` constants

## 0.42.0

### Minor Changes

- [`39793b0`](https://github.com/cesr/poncho-ai/commit/39793b0ab11ed26f140af6fc9c0cd3e1b1c83fec) Thanks [@cesr](https://github.com/cesr)! - harness: extract `runConversationTurn` helper; refactor CLI to use it

  Lifts the inline turn lifecycle from the CLI's
  `POST /api/conversations/:id/messages` handler (~280 lines of orchestration)
  into a new public helper at `@poncho-ai/harness`.

  The helper handles the full conversation lifecycle for a primary chat
  turn: load the conversation with archive, resolve canonical history,
  upload files via the harness's upload store, build stable user/assistant
  ids, persist the user message immediately, drive `executeConversationTurn`,
  periodically persist the in-flight assistant draft on `step:completed`
  and `tool:approval:required`, persist on `tool:approval:checkpoint` and
  `run:completed` continuation, rebuild history on `compaction:completed`,
  apply turn metadata on success, and persist partial state on
  cancel/error.

  Caller responsibilities (auth, active-run dedup, streaming, continuation
  HTTP self-fetch, title inference) stay outside the helper — passed in
  via opts or handled around the call. `opts.onEvent` is invoked for every
  `AgentEvent` for downstream forwarding (SSE, WebSocket, telemetry, etc.).

  The CLI's handler now delegates to `runConversationTurn` (drops from
  ~430 to ~150 lines). Consumers like PonchOS can call the same helper
  to ship the _exact_ same conversation lifecycle without duplicating
  the orchestration.

  Public API additions:
  - `runConversationTurn(opts): Promise<RunConversationTurnResult>`
  - `RunConversationTurnOpts`
  - `RunConversationTurnResult`

  No behavior changes. The helper is a verbatim extraction of the CLI's
  prior inline implementation.

### Patch Changes

- [`111d24e`](https://github.com/cesr/poncho-ai/commit/111d24efaab054ef7543c396085f8f4d41e7976a) Thanks [@cesr](https://github.com/cesr)! - cli: include VFS skills in the chat input slash command menu

  The `/api/slash-commands` endpoint was returning only repo-loaded skills,
  so tenant-authored skills stored in the VFS (`/skills/<name>/SKILL.md`)
  never appeared in the `/` autocomplete bar even though the agent could
  already see and run them at conversation time.

  The endpoint now resolves skills per-tenant via a new
  `harness.listSkillsForTenant(tenantId)` and applies the same repo-wins
  collision semantics used elsewhere in the harness.

## 0.41.0

### Minor Changes

- [#110](https://github.com/cesr/poncho-ai/pull/110) [`7d57a88`](https://github.com/cesr/poncho-ai/commit/7d57a88e55a49ec04de3dbd415b2440bb727e31f) Thanks [@cesr](https://github.com/cesr)! - harness: allow programmatic agent + storage injection (no AGENT.md required)

  `HarnessOptions` gains two optional fields that let callers construct a
  `Harness` without an `AGENT.md` on disk and without the
  `ensureAgentIdentity` filesystem dance:
  - `agentDefinition?: string | ParsedAgent` — raw markdown or a pre-parsed
    agent. When provided, `initialize()` skips the `AGENT.md` read.
  - `storageEngine?: StorageEngine` — pre-constructed engine; required
    whenever `agentDefinition` is provided. The engine's `agentId` (now a
    public readonly field on the `StorageEngine` interface) becomes the
    source of truth for partitioning, and is mirrored onto
    `parsedAgent.frontmatter.id` so existing downstream readers continue
    to resolve correctly.

  When neither field is provided, behaviour is unchanged: the harness
  reads `AGENT.md` from `workingDir`, calls `ensureAgentIdentity`, and
  constructs the `StorageEngine` internally.

  `refreshAgentIfChanged()` short-circuits when an agent definition was
  injected — callers who update an agent re-instantiate the harness
  rather than relying on disk file watching.

  This is the first of a small set of changes that lets `@poncho-ai/harness`
  be embedded as a library by consumer SaaS apps where each user has
  their own per-tenant agent state in a database, no filesystem layout.

- [#111](https://github.com/cesr/poncho-ai/pull/111) [`ac18616`](https://github.com/cesr/poncho-ai/commit/ac18616b864189c91d0957c72c537933497505f4) Thanks [@cesr](https://github.com/cesr)! - harness: allow programmatic `PonchoConfig` injection

  `HarnessOptions` gains an optional `config?: PonchoConfig` field. When
  provided, `initialize()` skips `loadPonchoConfig` (which imports
  `poncho.config.js` from `workingDir`) and uses the supplied object
  directly. Downstream resolvers (`resolveMemoryConfig`,
  `resolveStateConfig`, etc.) run as today, so any validation/normalization
  they perform applies to injected configs identically.

  Behaviour is unchanged when the field is absent: the disk loader runs
  as before.

  This is part of a small series of changes that enables
  `@poncho-ai/harness` to be embedded as a library by a consumer SaaS
  where each user's agent configuration comes from a database row, not a
  `poncho.config.js` on disk.

- [#112](https://github.com/cesr/poncho-ai/pull/112) [`c22416b`](https://github.com/cesr/poncho-ai/commit/c22416b3d4c4557277aeabf53e70877be6436e85) Thanks [@cesr](https://github.com/cesr)! - harness: cache MCP clients per `(serverName, tenantId)` instead of rebuilding per call

  When a tenant resolves a different bearer token than the host's
  `process.env` default for an MCP server, the per-call handler used to
  construct a brand-new `StreamableHttpMcpRpcClient` on every tool call.
  For builders this rarely triggered. For consumer/SaaS deployments where
  **every** call resolves a different per-user token, every tool call
  forced a fresh `initialize` round-trip — no session reuse, high
  latency, and a behaviour the recently-added 404 session-retry can't
  help with because there was nothing to retry.

  `LocalMcpBridge` now keeps a `Map<key, { client, token, lastUsed }>`
  keyed by `(serverName, tenantId)`. Lookups reuse the cached client when
  the token is unchanged and the entry is within the configured idle TTL
  (default 15 minutes). On token rotation or TTL expiry the entry is
  evicted lazily and rebuilt. `stopLocalServers()` closes all cached
  tenant clients alongside the server-default ones.

  The TTL is configurable via a constructor option (`tenantClientTtlMs`)
  for tests and tuning.

### Patch Changes

- [#109](https://github.com/cesr/poncho-ai/pull/109) [`4b5d974`](https://github.com/cesr/poncho-ai/commit/4b5d974345733ac9e68f36201dff7e7d8a8f0327) Thanks [@cesr](https://github.com/cesr)! - harness: re-initialize MCP session on 404 instead of staying wedged

  Streamable-HTTP MCP clients with session state (e.g. Arcade's gateway
  for Gmail / Google Calendar) issue an `Mcp-Session-Id` on initialize
  and expire it after some idle window. The bridge cached `sessionId`
  and `initialized` in process memory and never reset them, so once the
  server returned 404 for a stale session every subsequent tool call
  also 404'd until the host process restarted. Long-lived deployments
  (e.g. Railway) hit this; serverless platforms masked it because each
  invocation re-initialized.

  The client now treats `404` with a stored `sessionId` as a session
  expiry signal: it clears the session, re-runs `initialize`, and
  retries the request once. A 404 from initialize itself (no session
  yet) is still treated as a hard endpoint failure with no retry.

## 0.40.1

### Patch Changes

- [`8dec90d`](https://github.com/cesr/poncho-ai/commit/8dec90d4df246b0cc16adc9fae61a568db67cbfe) Thanks [@cesr](https://github.com/cesr)! - fix(harness): accept "UTC" (and "GMT") as valid cron timezones

  `AGENT.md` cron jobs with `timezone: "UTC"` were rejected at parse time
  with `Invalid timezone at AGENT.md frontmatter cron.<job>: "UTC"`. The
  validator was matching against `Intl.supportedValuesOf("timeZone")`,
  which returns canonical IANA names only (`"Etc/UTC"`) and excludes
  common aliases like `"UTC"` and `"GMT"`, even though `Intl.DateTimeFormat`
  accepts them everywhere. The error message ironically cited `"UTC"`
  itself as a valid example.

  Now delegates to `Intl.DateTimeFormat` directly, which accepts `"UTC"`,
  `"GMT"`, every IANA name, and any platform alias the runtime knows about.

## 0.40.0

### Minor Changes

- [#105](https://github.com/cesr/poncho-ai/pull/105) [`e127174`](https://github.com/cesr/poncho-ai/commit/e12717415b1114c5e9a58e7c51fcf9e038218f9f) Thanks [@cesr](https://github.com/cesr)! - feat: tenant-authored skills in the VFS

  Tenants can now author skills in their VFS at `/skills/<name>/SKILL.md`
  (plus sibling files such as `scripts/*.ts` and `references/*.md`). VFS
  skills are merged with the agent's repo skills per-tenant when building
  the `<available_skills>` block in the system prompt; repo skills win on
  name collision (a warning is logged for the dropped VFS skill).

  VFS skills can ship runnable scripts in their tree (`scripts/foo.ts`
  etc.); the agent runs them via the existing `run_code` tool with
  `file: "/skills/<name>/scripts/foo.ts"`, which executes in the sandboxed
  isolated-vm runtime. `run_skill_script` remains for repo-shipped skills
  only (jiti, full Node access), and returns a clear redirect when
  called against a VFS skill. The agent's tool-policy lookups still
  resolve against repo skills only, so tenants cannot grant themselves
  new MCP tools by uploading a SKILL.md (security boundary).

  `run_code` is enhanced so skill-authored scripts feel natural:
  - Accepts top-level `export const run = ...`, `export default function ...`,
    and `export default <expr>;` (the keyword is stripped at strip-TypeScript
    time; `export default <expr>` becomes a `__default` binding).
  - New optional `input` parameter, exposed inside the script as the global
    `__input`.
  - If the script defines a top-level `run` / `default` / `main` / `handler`
    function and doesn't `return` on its own, the dispatcher invokes that
    function with `__input` and returns its result. Existing
    return-style scripts are unaffected.

  The CLI Files sidebar already exposes the VFS, so creating a tenant
  skill is just writing to `/skills/...` from the UI or via the agent's
  own VFS write tools — the harness invalidates its per-tenant skill
  cache on writes under `/skills/`.

### Patch Changes

- [`d24c152`](https://github.com/cesr/poncho-ai/commit/d24c152c1ecb9bfe59b086cb1f18a5ab43688223) Thanks [@cesr](https://github.com/cesr)! - fix(harness): cap `_toolResultArchive` size per conversation, FIFO-evict oldest

  Heap-snapshot evidence from a 3.7 GB OOM showed 147,448 retained strings,
  including 8 exact duplicates (~239 KB each) of the same browser-extracted
  page text. The browser screenshot/snapshot skip-list from a prior fix
  didn't help because page-text/web-extract tools still archived their
  full payloads in `_toolResultArchive`, with no eviction across the
  session.

  Add a per-conversation archive byte cap (default 25 MB, configurable via
  `PONCHO_TOOL_ARCHIVE_MAX_MB`). When a new archive write would push the
  total over the cap, evict oldest entries (by `createdAt`) until we're
  back under. Tool-name-agnostic, so it bounds memory regardless of which
  tool returned the large payload.

- [`8de45a7`](https://github.com/cesr/poncho-ai/commit/8de45a7ac434fa928ae3b83deec52727073d4658) Thanks [@cesr](https://github.com/cesr)! - fix(harness): browser status/frame listeners no longer pin runInput across runs

  Heap-snapshot evidence pointed to the actual leak: `BrowserSession.tabs[cid].statusListeners`
  was retaining ~3.4 GB on a long browser session. Each `harness.run()`
  registered two arrow-function listeners (frame + status) whose lexical
  scope captured the entire run scope, including `input.parameters.__toolResultArchive`.
  V8 captures the full enclosing scope into the closure's Context object
  even for variables the listener body doesn't reference, so the runInput
  was reachable through every listener.

  Two fixes:
  1. The listeners are now produced by module-scope factories
     (`makeBrowserFrameListener`, `makeBrowserStatusListener`) whose only
     captured variable is the target event queue. The runInput is no longer
     in scope when the closure is created.
  2. The listener cleanup at the end of `run()` is now in a `try/finally`,
     so listeners are always removed — even when the run errors or the
     consumer abandons the generator. Previously a thrown run would leave
     listeners pinned forever.

- [`524df41`](https://github.com/cesr/poncho-ai/commit/524df411904bd00c07901695eda6d4dd07dde972) Thanks [@cesr](https://github.com/cesr)! - fix: persist harness messages on cancelled runs so the agent doesn't lose context

  When a run was cancelled (Stop button, abort signal), `conversation.messages`
  was updated with the partial assistant turn but `conversation._harnessMessages`
  — the canonical history `loadCanonicalHistory` hands to the model on the next
  turn — was left holding a snapshot from the _previous_ successful run. The
  agent had no memory of the cancelled work, even though the user-facing UI
  still showed it. The new verbose-mode harness toggle made this divergence
  directly visible.

  The fix plumbs an in-flight `messages` snapshot through the `run:cancelled`
  event, trims it to a model-valid prefix (no orphan `tool_use`), and persists
  it as `_harnessMessages` on every cancel path in the CLI.

- [`8e410a1`](https://github.com/cesr/poncho-ai/commit/8e410a15b246a2b129fded8d1c06b98878e5fd07) Thanks [@cesr](https://github.com/cesr)! - fix(harness): surface real `isolated-vm` load error instead of generic message

  The previous error told users "Run: pnpm add isolated-vm" even when the
  package was installed but the native binary couldn't be loaded — typically
  because a Node upgrade left the installed prebuilds with the wrong ABI
  version (e.g. Node 25 reports ABI 141 but `isolated-vm@6.1.2` only ships
  abi127/abi137 prebuilds). Now the error includes the underlying load
  message, the current Node version + ABI, and a hint to rebuild rather
  than reinstall when the cause is a binary mismatch.

- [#105](https://github.com/cesr/poncho-ai/pull/105) [`e127174`](https://github.com/cesr/poncho-ai/commit/e12717415b1114c5e9a58e7c51fcf9e038218f9f) Thanks [@cesr](https://github.com/cesr)! - chore(harness): declare `engines.node` as `>=20.0.0 <25.0.0`

  `isolated-vm@6.1.2` (the version harness uses for sandboxed code execution)
  ships V8-ABI-specific prebuilt binaries up to ABI 137 (Node 24). Node 25
  reports ABI 141 and has no matching prebuild, so the native module fails
  to load. Declaring the upper bound makes pnpm/npm warn (or hard-fail with
  `engine-strict`) at install time on Node 25, instead of surfacing as a
  runtime error the first time `run_code` is invoked.

- [`2792d84`](https://github.com/cesr/poncho-ai/commit/2792d8448b304bf748f926ce42a91c76f37edf79) Thanks [@cesr](https://github.com/cesr)! - Include weekday (Mon/Tue/...) alongside the UTC date in the system prompt's time context, so models stop misidentifying the day of the week.

- Updated dependencies [[`524df41`](https://github.com/cesr/poncho-ai/commit/524df411904bd00c07901695eda6d4dd07dde972), [`9616060`](https://github.com/cesr/poncho-ai/commit/96160607502c2c0b05bc60b67b8fc012f4052ef1)]:
  - @poncho-ai/sdk@1.10.0

## 0.39.1

### Patch Changes

- [`244a3a3`](https://github.com/cesr/poncho-ai/commit/244a3a310c6c52f9e8535b28fb25d77829583d3f) Thanks [@cesr](https://github.com/cesr)! - fix(harness): don't archive `browser_screenshot` / `browser_snapshot` payloads

  The per-conversation `_toolResultArchive` had no size cap or eviction, and
  browser tool results were being archived in full — base64 JPEG screenshots
  (~50-500KB each) and accessibility-tree snapshots accumulated for the lifetime
  of a conversation. Heavy browser sessions OOM'd `poncho dev` after ~80 minutes.

  Skip archiving for view-once tool results (`browser_screenshot`,
  `browser_snapshot`). The model consumes them in-step; they're never retrieved
  after-the-fact, so archiving them only burns memory.

- [`d6248c8`](https://github.com/cesr/poncho-ai/commit/d6248c8b6d22e0fd0becde9e31dff7c12c724d84) Thanks [@cesr](https://github.com/cesr)! - fix(cli, harness): unify turn-parameter assembly so `conversation_recall` works everywhere

  The recall tool relies on three context parameters (`__conversationRecallCorpus`,
  `__conversationListFn`, `__conversationFetchFn`) that were only injected for
  user-initiated HTTP turns. Cron, reminder, messaging-adapter, chat-continuation,
  subagent-callback, and tool-approval-resume runs all built their own
  `runInput.parameters` object and silently omitted these — causing
  `conversation_recall` to throw "not available in this environment" or return
  empty results depending on the call mode.

  Introduces a single `buildTurnParameters(conversation, opts)` helper in the CLI
  that owns context-parameter assembly (recall functions, `__activeConversationId`,
  `__ownerId`, messaging metadata, tool-result archive). HTTP, messaging, and
  cron/reminder paths now go through it. The harness orchestrator's three
  internal turn sites (chat continuation, subagent-callback resume, tool-approval
  resume) now call the existing `hooks.buildRecallParams` so they pick up the
  recall functions too.

## 0.39.0

### Minor Changes

- [#97](https://github.com/cesr/poncho-ai/pull/97) [`1eb1b1e`](https://github.com/cesr/poncho-ai/commit/1eb1b1e71641f79aa089a967811dcfe2de59be8d) Thanks [@cesr](https://github.com/cesr)! - refactor: extract subagent lifecycle into AgentOrchestrator (phase 5)

  Move subagent orchestration (~1100 lines) from the CLI into the
  AgentOrchestrator class in the harness package. The orchestrator now
  owns all subagent state (activeSubagentRuns, pendingSubagentApprovals,
  pendingCallbackNeeded), lifecycle methods (runSubagent,
  processSubagentCallback, triggerParentCallback), SubagentManager
  creation, approval handling, and stale recovery.

  New hooks on OrchestratorHooks allow transport-specific concerns
  (child harness creation, serverless dispatch, SSE stream lifecycle,
  messaging notifications) to stay in the CLI while the orchestrator
  handles all orchestration logic.

  Also fixes subagent approval persistence (decisions now explicitly
  written to the conversation store) and adds live SSE streaming for
  parent callback runs in the web UI.

- [#95](https://github.com/cesr/poncho-ai/pull/95) [`21ee02a`](https://github.com/cesr/poncho-ai/commit/21ee02a577cd0a85823cc3922dd0dc54c630f417) Thanks [@cesr](https://github.com/cesr)! - perf: eliminate per-conversation archive egress on the hot read path

  Three related fixes that together dramatically reduce database and
  server→browser egress for any long-lived conversation:
  - `conversationStore.get()` no longer loads the `tool_result_archive`
    column. Callers that actually need to reseed the harness archive —
    run entry points, cron runs, reminder firings — must now use the new
    `conversationStore.getWithArchive()` method instead.
  - The `GET /api/conversations/:id` response strips `_toolResultArchive`
    alongside the already-stripped `_continuationMessages` and
    `_harnessMessages`, so the browser never receives the archive payload.
  - Adds a cheap `GET /api/conversations/:id/status` endpoint backed by a
    new `getStatusSnapshot()` method that reads only summary columns (no
    `data` blob). The web UI poll loops now hit this endpoint every 2s
    and only refetch the full conversation when `updatedAt`,
    `messageCount`, or the pending-approval counts actually change.

  The SQL upsert was also updated to preserve `tool_result_archive` via
  `COALESCE(excluded, conversations.tool_result_archive)` so that updates
  on conversations loaded via the light `get()` do not clobber the
  existing archive.

- [#100](https://github.com/cesr/poncho-ai/pull/100) [`ef4fe5d`](https://github.com/cesr/poncho-ai/commit/ef4fe5d1fd4bb31c201fd240f4524b64f01e3e6d) Thanks [@cesr](https://github.com/cesr)! - feat: Slack-style message threads

  Users can now fork any persisted message into one or more threads. Each
  thread is a new conversation whose initial history is a snapshot of the
  parent up to and including the anchor message; replies in the thread
  evolve independently of the parent. Multiple threads per parent message
  are supported.

  ## Web UI
  - Hover any message in the main pane to reveal a "Reply in thread" pill
    positioned just below the bubble (offset varies by role). The pill is
    invisible by default and only appears on hover; a delayed-hide bridges
    the empty space between message and pill so the user can move the
    mouse onto it without it flickering off.
  - Once a thread exists on a message, the pill is replaced by an
    always-visible badge (`"N replies · 5m ago"`, count bold + meta muted).
    Multiple threads stack vertically under the message, each with its own
    badge. Hovering a badge reveals an outside-positioned `×` delete with
    the same two-step "× → sure?" confirmation as the sidebar
    conversation-delete.
  - Clicking a badge opens the thread in a right-side panel that mirrors
    the existing browser-panel pattern: a flex sibling of `.main-chat`
    with a 1px drag-resize handle. The panel has its own composer
    (independent file uploads, paste-to-attach, attachment preview)
    rendered alongside the main composer so users can keep typing in the
    parent conversation. Vertical padding matches the main composer so
    both chatboxes line up at the same baseline.
  - The pinned parent message and replies inside the panel render through
    the same DOM construction logic as the main pane (assistant avatar +
    markdown, user bubble + file thumbnails). Reply submissions stream
    token-by-token via SSE (parsed model:chunk events feed an optimistic
    assistant placeholder; a thinking-indicator shows until the first
    chunk lands).
  - The open thread is reflected in the URL hash (`#thread=<id>`) so a
    page reload restores the panel. Switching conversations or closing
    the panel clears the hash and any sticky drag-resize widths.

  ## DB
  - New `parent_message_id TEXT` column on `conversations` (migration 6)
    plus a partial index on `(parent_conversation_id, parent_message_id)
WHERE parent_message_id IS NOT NULL`.
  - The existing `parent_conversation_id` plumbing is reused; subagents
    and threads coexist on that column, discriminated by whether
    `parent_message_id` is set (subagents leave it `NULL`).
  - `threadMeta` (snapshot length + cached parent-message summary)
    round-trips inside the conversation `data` blob.

  ## API
  - `GET /api/conversations/:id/threads` → `{ threads: ApiThreadSummary[] }`
  - `POST /api/conversations/:id/threads { parentMessageId, title? }` →
    201 `{ thread, conversationId }` |
    404 `PARENT_MESSAGE_NOT_FOUND` |
    409 `MESSAGE_ID_REQUIRED` (anchor lacks a stable id) |
    409 `ANCHOR_IN_FLIGHT` (anchor is the streaming tail of a live run)
  - The two `SUBAGENT_READ_ONLY` gates on `/messages` and `/continue` are
    now keyed on `subagentMeta` rather than `parentConversationId` so
    threads remain writable.
  - New `ApiThreadSummary`, `ApiThreadListResponse`,
    `ApiCreateThreadRequest`, `ApiCreateThreadResponse` types in
    `@poncho-ai/sdk`. New `AgentClient.listThreads` /
    `AgentClient.createThread` wrappers in `@poncho-ai/client`.

  ## Storage interface
  - `ConversationStore.listThreads(parentConversationId)` and the
    matching `StorageEngine.conversations.listThreads(...)`. External
    implementers of these interfaces will need to add the method.
  - `Conversation` / `ConversationCreateInit` / `ConversationSummary`
    gained optional `parentMessageId` and `threadMeta` fields.

  ## Fork semantics
  - Stable `metadata.id` on every persisted message: `randomUUID()` is
    hoisted once per turn and reused for both the user message and the
    in-flight assistant message across all persist sites (cli messaging
    run, cli `/messages` handler, cron path). `buildAssistantMetadata`
    takes an optional `{ id, timestamp }` opt-arg.
  - No DB backfill of legacy id-less messages; the SPA hides the
    "Reply in thread" affordance on rows whose `metadata.id` is missing.
  - The visible-sequence used for the anchor lookup is reconstructed as
    `[...compactedHistory, ...messages.filter(notCompactionSummary)]`,
    so pre-compaction anchors are supported. For pre-compaction anchors,
    `_harnessMessages` is reset to `undefined` so the harness rebuilds
    canonical history from `messages` on the thread's first run.
  - Forking on the actively-streaming tail message of a live run returns
    409 `ANCHOR_IN_FLIGHT`; any prior, already-persisted message is
    fork-able even while the parent is mid-run.
  - Tool-result archive entries are filtered to only those referenced by
    tool calls in the trimmed `_harnessMessages` (no whole-archive clones).
  - All run-specific state is reset on the new thread:
    `runtimeRunId`, `pendingApprovals`, `runStatus`,
    `pendingSubagentResults`, `subagentCallbackCount`,
    `runningCallbackSince`, `_continuationMessages`. `channelMeta` and
    `subagentMeta` are explicitly NOT inherited so threads aren't bound
    to the parent's Slack/Telegram thread and aren't subagent runs.
  - Thread conversations stay out of the sidebar list (already-existing
    `!c.parentConversationId` filter) and are cascade-deleted with their
    parent.

### Patch Changes

- [#100](https://github.com/cesr/poncho-ai/pull/100) [`ef4fe5d`](https://github.com/cesr/poncho-ai/commit/ef4fe5d1fd4bb31c201fd240f4524b64f01e3e6d) Thanks [@cesr](https://github.com/cesr)! - feat(logging): readable, scoped, level-aware dev server logs

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

- [`fcf6a02`](https://github.com/cesr/poncho-ai/commit/fcf6a027880ac94ada2e3fd732b11eed9f5f15b8) Thanks [@cesr](https://github.com/cesr)! - chore: drop browser-frame noise from the dev log

  Two sources of per-frame log noise during interactive browser use
  are now silenced:
  - `TelemetryEmitter.emit` skips `browser:frame` events alongside the
    already-skipped `model:chunk`. OTLP forwarding and custom handlers
    still receive every event unchanged.
  - The CLI's browser SSE endpoint no longer prints the
    `[poncho][browser-sse] Frame N: WxH, data bytes: ...` counter
    (which fired for the first 3 frames and every 50th). Related
    `frameCount` / `droppedFrames` state dropped with it.

- Updated dependencies [[`ef4fe5d`](https://github.com/cesr/poncho-ai/commit/ef4fe5d1fd4bb31c201fd240f4524b64f01e3e6d), [`ef4fe5d`](https://github.com/cesr/poncho-ai/commit/ef4fe5d1fd4bb31c201fd240f4524b64f01e3e6d)]:
  - @poncho-ai/sdk@1.9.0

## 0.38.0

### Minor Changes

- [`620a0c8`](https://github.com/cesr/poncho-ai/commit/620a0c89efaafce28968fca5cbde2e2b19bd1595) Thanks [@cesr](https://github.com/cesr)! - feat: add recurrent reminders (daily, weekly, monthly, cron)

  The `set_reminder` tool now accepts an optional `recurrence` parameter that makes reminders repeat on a schedule instead of firing once. Supports daily, weekly (with specific days-of-week), monthly, and cron expressions. Recurring reminders are rescheduled after each firing and can be bounded by `maxOccurrences` or `endsAt`. Cancel a recurring reminder to stop all future occurrences.

### Patch Changes

- [`6486de2`](https://github.com/cesr/poncho-ai/commit/6486de2242a2976068e4bd09f7c0f2d978c35c96) Thanks [@cesr](https://github.com/cesr)! - fix: persist subagent `parentConversationId` atomically so children never appear top-level in the sidebar.

  `SubagentManager.spawn` previously did a two-step write: `conversationStore.create(...)` followed by `conversationStore.update(...)` to attach `parentConversationId`, `subagentMeta`, and the initial user message. If the follow-up update was interrupted (serverless timeout, transient DB error), the child row was left in the database with `parent_conversation_id = NULL`, so it slipped past the `!c.parentConversationId` filter on `/api/conversations` and showed up as a top-level conversation. This was especially visible with cron-driven research subagents.

  `ConversationStore.create` now accepts an optional `init` bag (`parentConversationId`, `subagentMeta`, `messages`, `channelMeta`) that is written in the single INSERT — both into the `data` blob and into the dedicated `parent_conversation_id` column. `spawn` passes those fields through and drops the redundant update, eliminating the orphan window. All existing `create(ownerId, title, tenantId)` callers keep working since `init` is optional.

- [`0d0578f`](https://github.com/cesr/poncho-ai/commit/0d0578fbc97a3d2644c4e22cab14ff02a79f805f) Thanks [@cesr](https://github.com/cesr)! - fix: route file tools through MountableFs so `/project/` paths resolve correctly

  `edit_file`, `read_file`, and `write_file` were hitting `engine.vfs` directly, which has no knowledge of the `/project/` mount that bash uses via `MountableFs`. This caused `edit_file` to throw "File not found" on `/project/` paths that bash could see fine. All three file tools now receive a filesystem factory from `BashEnvironmentManager.getFs()` that returns the same combined filesystem (VFS + `/project/` overlay) that bash uses.

## 0.37.2

### Patch Changes

- [`2229f74`](https://github.com/cesr/poncho-ai/commit/2229f74ae4d02c5618c60787a7db925060cc1313) Thanks [@cesr](https://github.com/cesr)! - fix: stop invalidating the prompt cache across runs and preserve cache reads when tool results are in flight.

  Two issues were degrading prompt-cache hit rates to ~0 between turns:
  1. The system prompt embedded `new Date().toISOString()` (millisecond precision) on every run when a reminder store was active, which changed the very first block of the prefix and prevented any cross-run cache match. The timestamp is now quantized to the hour, which keeps the system prompt stable across runs while still giving the agent a usable sense of time.
  2. When the message history contained untruncated tool results from the previous run, prompt caching was disabled entirely — no `cache_control` breakpoint was emitted, which also killed cache _reads_ of the stable prefix (system prompt + earlier turns). The breakpoint is now placed immediately before the first untruncated tool result instead, so the stable prefix is still cached and read while the soon-to-be-truncated tail stays out of the cache.

  `addPromptCacheBreakpoints` now takes an optional `targetIndex` to support this.

## 0.37.1

### Patch Changes

- [`fb61a62`](https://github.com/cesr/poncho-ai/commit/fb61a6259367f0a62d0acd7a20ef2fae93013819) Thanks [@cesr](https://github.com/cesr)! - fix: migration script now discovers and migrates all agent directories instead of only the first one

## 0.37.0

### Minor Changes

- [`86bc5ac`](https://github.com/cesr/poncho-ai/commit/86bc5ac2a73b80a286228cd9e3b663b50b3d82e7) Thanks [@cesr](https://github.com/cesr)! - perf: promote parentConversationId, pendingApprovals, and channelMeta to dedicated columns so list/summary queries no longer fetch the full data JSONB blob — dramatically reduces database egress

## 0.36.4

### Patch Changes

- [`d7eb744`](https://github.com/cesr/poncho-ai/commit/d7eb744fb371727278bda6a349b9e117065549b4) Thanks [@cesr](https://github.com/cesr)! - fix: upsert conflict key matches PK (id only) — fixes ON CONFLICT error on conversation persist

## 0.36.3

### Patch Changes

- [`abb7ec3`](https://github.com/cesr/poncho-ai/commit/abb7ec3c65503f6feaf133f5d2488dc25152a1a8) Thanks [@cesr](https://github.com/cesr)! - fix: messaging conversations not persisting in SQL storage engines

  The messaging runner creates conversations with a deterministic ID and calls
  `update()` to persist them. But `update()` was a plain UPDATE that silently
  matched zero rows for new conversations, so messages were never saved.
  Changed `update()` to an upsert (INSERT ... ON CONFLICT DO UPDATE) so
  conversations are created on first write and updated on subsequent ones.

## 0.36.2

### Patch Changes

- [`04ebc73`](https://github.com/cesr/poncho-ai/commit/04ebc737914ee24b6f76b42016948c372d6a52d0) Thanks [@cesr](https://github.com/cesr)! - fix: disable prepared statements in PostgreSQL driver for compatibility with transaction-mode connection poolers (Supabase, PgBouncer)

## 0.36.1

### Patch Changes

- Updated dependencies []:
  - @poncho-ai/sdk@1.8.1

## 0.36.0

### Minor Changes

- feat: unified conversation_recall tool, subagent recall access, fix subagent streaming
  - Consolidate `conversation_recall` into a single tool with three modes: keyword search, date-range listing, and full conversation fetch by ID.
  - Give subagents access to conversation recall via shared `buildRecallParams` helper.
  - Fix subagent streaming: variable scoping bug preventing poll start, race condition in `processSubagentCallback` losing concurrent results, and spawn detection race causing `pendingSubagents` flag to be missed.
  - Simplify subagent result polling to avoid duplicate messages from polling-to-SSE handoff.

- feat: VFS file tools and vfs:// lazy resolution
  - Add `read_file`, `edit_file`, and `write_file` tools for the virtual filesystem, registered alongside `bash`.
  - `read_file` returns images and PDFs as lightweight `vfs://` references resolved to actual bytes only at model-request time, keeping conversation history small.
  - `edit_file` uses targeted `old_str`/`new_str` replacement for efficient edits to large files.
  - `write_file` creates or overwrites files with automatic parent directory creation.
  - Add `vfs://` scheme resolution in `convertMessage` for user messages, tool results, and rich media items.
  - Extend `extractMediaFromToolOutput` to handle PDFs alongside images.

## 0.35.0

### Minor Changes

- [`83d3c5f`](https://github.com/cesr/poncho-ai/commit/83d3c5f841fe84965d1f9fec6dfc5d8832e4489a) Thanks [@cesr](https://github.com/cesr)! - feat: add multi-tenancy with JWT-based tenant scoping

  Deploy one agent, serve many tenants with fully isolated conversations, memory, reminders, and secrets. Tenancy activates automatically when a valid JWT is received — no config changes needed.
  - **Auth**: `createTenantToken()` in client SDK, `poncho auth create-token` CLI, or any HS256 JWT library.
  - **Isolation**: conversations, memory, reminders, and todos scoped per tenant.
  - **Per-tenant secrets**: encrypted secret overrides for MCP auth tokens, manageable via CLI (`poncho secrets`), API, and web UI settings panel.
  - **MCP**: per-tenant token resolution with deferred discovery for servers without a default env var.
  - **Web UI**: `?token=` tenant access, settings cog for secret management, dark mode support.
  - **Backward compatible**: existing single-user deployments work unchanged.

### Patch Changes

- Updated dependencies [[`83d3c5f`](https://github.com/cesr/poncho-ai/commit/83d3c5f841fe84965d1f9fec6dfc5d8832e4489a)]:
  - @poncho-ai/sdk@1.8.0

## 0.34.1

### Patch Changes

- [`59a88cc`](https://github.com/cesr/poncho-ai/commit/59a88cc52b5c3aa7432b820424bb8067174233e5) Thanks [@cesr](https://github.com/cesr)! - fix: improve token estimation accuracy and handle missing attachments
  - Use a JSON-specific token ratio for tool definitions to avoid inflating counts with many MCP tools.
  - Track actual context size from model responses for compaction triggers instead of cumulative input tokens.
  - Gracefully degrade when file attachments are missing or expired instead of crashing.

## 0.34.0

### Minor Changes

- [`3f096f2`](https://github.com/cesr/poncho-ai/commit/3f096f28b9ab797b52f1b725778976929156cce9) Thanks [@cesr](https://github.com/cesr)! - fix: scope MCP tools to skills via server-level claiming

  MCP tools from configured servers are now globally available by default. When a skill claims any tool from a server via `allowed-tools`, the entire server becomes skill-managed — its tools are only available when the claiming skill is active (or declared in AGENT.md `allowed-tools`).

## 0.33.1

### Patch Changes

- [`d8fe87c`](https://github.com/cesr/poncho-ai/commit/d8fe87c68d42878829422750f98e3c70a425e3e3) Thanks [@cesr](https://github.com/cesr)! - fix: OTLP trace exporter reliability and error visibility
  - Use provider instance directly instead of global `trace.getTracer()` to avoid silent failure when another library registers a tracer provider first
  - Append `/v1/traces` to base OTLP endpoints so users can pass either the base URL or the full signal-specific URL
  - Surface HTTP status code and response body on export failures
  - Enable OTel diagnostic logger at WARN level for internal SDK errors

## 0.33.0

### Minor Changes

- [#75](https://github.com/cesr/poncho-ai/pull/75) [`d447d0a`](https://github.com/cesr/poncho-ai/commit/d447d0a3cb77f3d097276b524b5f870dddf1899e) Thanks [@cesr](https://github.com/cesr)! - Add `maxRuns` option to cron jobs for automatic pruning of old conversations, preventing unbounded storage growth on hosted stores.

## 0.32.1

### Patch Changes

- [`67424e0`](https://github.com/cesr/poncho-ai/commit/67424e073b2faa28a255781f91a80f4602c745e2) Thanks [@cesr](https://github.com/cesr)! - Fix stale fired reminders not being cleaned up: pruneStale now removes all fired reminders immediately and runs on list() in addition to create().

## 0.32.0

### Minor Changes

- [#68](https://github.com/cesr/poncho-ai/pull/68) [`5a7e370`](https://github.com/cesr/poncho-ai/commit/5a7e3700a5ee441ef41cf4dc0ca70ff90e57d282) Thanks [@cesr](https://github.com/cesr)! - Add one-off reminders: agents can dynamically set, list, and cancel reminders that fire at a specific time. Fired reminders are immediately deleted from storage. Includes polling for local dev and Vercel cron integration.

## 0.31.3

### Patch Changes

- [#56](https://github.com/cesr/poncho-ai/pull/56) [`28b2913`](https://github.com/cesr/poncho-ai/commit/28b291379e640dec53a66c41a2795d0a9fbb9ee7) Thanks [@cesr](https://github.com/cesr)! - Fix historical tool result truncation reliability for deployed conversations.

  This stamps `runId` on all harness-authored assistant messages and adds a fallback truncation boundary for legacy histories that lack `runId` metadata.

## 0.31.2

### Patch Changes

- [#54](https://github.com/cesr/poncho-ai/pull/54) [`2341915`](https://github.com/cesr/poncho-ai/commit/23419152d52c39f3bcaf8cdcd424625d5f897315) Thanks [@cesr](https://github.com/cesr)! - Reduce high-cost outliers with aggressive runtime controls and better cost visibility.

  This adds older-turn tool result archiving/truncation, tighter retry/step/subagent limits, compaction tuning, selective prompt cache behavior, and richer cache-write token attribution in logs/events.

- Updated dependencies [[`2341915`](https://github.com/cesr/poncho-ai/commit/23419152d52c39f3bcaf8cdcd424625d5f897315)]:
  - @poncho-ai/sdk@1.7.1

## 0.31.1

### Patch Changes

- Fix OpenAI Codex compatibility for reasoning model runs by normalizing tool schemas, enforcing required payload fields, and adding endpoint fallback behavior.

## 0.31.0

### Minor Changes

- Add OpenAI Codex OAuth provider support with one-time auth bootstrap and runtime token refresh.

  This adds `openai-codex` model provider support, `poncho auth` login/status/logout/export commands, onboarding updates, and Codex request compatibility handling for OAuth-backed Responses API calls.

### Patch Changes

- Updated dependencies []:
  - @poncho-ai/sdk@1.7.0

## 0.30.0

### Minor Changes

- [`193c367`](https://github.com/cesr/poncho-ai/commit/193c367568dce22a470dff6acd022c221be3b722) Thanks [@cesr](https://github.com/cesr)! - Unified continuation logic across all entry points (chat, cron, subagents, SDK) with mid-stream soft deadline checkpointing and proper context preservation across continuation boundaries.

### Patch Changes

- Updated dependencies [[`193c367`](https://github.com/cesr/poncho-ai/commit/193c367568dce22a470dff6acd022c221be3b722)]:
  - @poncho-ai/sdk@1.6.3

## 0.29.0

### Minor Changes

- [#51](https://github.com/cesr/poncho-ai/pull/51) [`eb661a5`](https://github.com/cesr/poncho-ai/commit/eb661a554da6839702651671db8a8820ceb13f35) Thanks [@cesr](https://github.com/cesr)! - Add generic OTLP trace exporter for sending OpenTelemetry traces to any collector (Jaeger, Grafana Tempo, Honeycomb, etc.). Configure via `telemetry.otlp` as a URL string or `{ url, headers }` object. Works alongside or instead of Latitude telemetry.

### Patch Changes

- Updated dependencies [[`eb661a5`](https://github.com/cesr/poncho-ai/commit/eb661a554da6839702651671db8a8820ceb13f35)]:
  - @poncho-ai/sdk@1.6.2

## 0.28.3

### Patch Changes

- [`87f844b`](https://github.com/cesr/poncho-ai/commit/87f844b0a76ece87e4bba78eaf73392f857cdef2) Thanks [@cesr](https://github.com/cesr)! - Fix tool execution blowing past serverless timeout and cross-skill script paths
  - Race tool batch execution against remaining soft deadline so parallel tools can't push past the hard platform timeout
  - Add post-tool-execution soft deadline checkpoint for tools that finish just past the deadline
  - Allow skill scripts to reference sibling directories (e.g. ../scripts/current-date.ts)
  - Catch script path normalization errors in approval check instead of crashing the run

## 0.28.2

### Patch Changes

- [`98df42f`](https://github.com/cesr/poncho-ai/commit/98df42f79e0a376d0a864598557758bfa644039d) Thanks [@cesr](https://github.com/cesr)! - Fix serverless subagent and continuation reliability
  - Use stable internal secret across serverless instances for callback auth
  - Wrap continuation self-fetches in waitUntil to survive function shutdown
  - Set runStatus during callback re-runs so clients detect active processing
  - Add post-streaming soft deadline check to catch long model responses
  - Client auto-recovers from abrupt stream termination and orphaned continuations
  - Fix callback continuation losing \_continuationMessages when no pending results

## 0.28.1

### Patch Changes

- [`4d50ad9`](https://github.com/cesr/poncho-ai/commit/4d50ad970886c9d3635ec36a407514c91ce6a71a) Thanks [@cesr](https://github.com/cesr)! - Improve callback-run reliability and streaming across subagent workflows, including safer concurrent approval handling and parent callback retriggers.

  Add context window/token reporting through run completion events, improve cron/web UI rendering and approval streaming behavior, and harden built-in web search retry/throttle behavior.

- Updated dependencies [[`4d50ad9`](https://github.com/cesr/poncho-ai/commit/4d50ad970886c9d3635ec36a407514c91ce6a71a)]:
  - @poncho-ai/sdk@1.6.1

## 0.28.0

### Minor Changes

- [`c0ca56b`](https://github.com/cesr/poncho-ai/commit/c0ca56b54bb877d96ba8088537d6f1c7461d2a55) Thanks [@cesr](https://github.com/cesr)! - Add built-in `web_search` and `web_fetch` tools so agents can search the web and fetch page content without a browser or API keys. Remove the scaffolded `fetch-page` skill (superseded by `web_fetch`). Fix `browser_open` crash when agent projects have an older `@poncho-ai/browser` installed.

## 0.27.0

### Minor Changes

- [#42](https://github.com/cesr/poncho-ai/pull/42) [`e58a984`](https://github.com/cesr/poncho-ai/commit/e58a984efaa673b649318102bbf735fb4c2f9172) Thanks [@cesr](https://github.com/cesr)! - Add continuation model and fire-and-forget subagents

  **Continuation model**: Agents no longer send a synthetic `"Continue"` user message between steps. Instead, the harness injects a transient signal when needed, and the full internal message chain is preserved across continuations so the LLM never loses context. `RunInput` gains `disableSoftDeadline` and `RunResult` gains `continuationMessages`.

  **Fire-and-forget subagents**: Subagents now run asynchronously in the background. `spawn_subagent` returns immediately with a subagent ID; results are delivered back to the parent conversation as a callback once the subagent completes. Subagents cannot spawn their own subagents. The web UI shows results in a collapsible disclosure and reconnects the live event stream automatically when the parent agent resumes.

  **Bug fixes**:
  - Fixed a race condition where concurrent runs on the same harness instance could assign a subagent or browser tab to the wrong parent conversation (shared `_currentRunConversationId` field replaced with per-run `ToolContext.conversationId`).
  - Fixed Upstash KV store silently dropping large values by switching from URL-path encoding to request body format for `SET`/`SETEX` commands.
  - Fixed empty assistant content blocks causing Anthropic `text content blocks must be non-empty` errors.

  **Client**: Added `getConversationStatus()` and `waitForSubagents` option on `sendMessage()`.

### Patch Changes

- Updated dependencies [[`e58a984`](https://github.com/cesr/poncho-ai/commit/e58a984efaa673b649318102bbf735fb4c2f9172)]:
  - @poncho-ai/sdk@1.6.0

## 0.26.0

### Minor Changes

- [#40](https://github.com/cesr/poncho-ai/pull/40) [`95ae86b`](https://github.com/cesr/poncho-ai/commit/95ae86b4ea0d913357ccca9a43a227c83e46b9c4) Thanks [@cesr](https://github.com/cesr)! - Add built-in todo tools (todo_list, todo_add, todo_update, todo_remove) with per-conversation storage and a live todo panel in the web UI

## 0.25.0

### Minor Changes

- [`5a103ca`](https://github.com/cesr/poncho-ai/commit/5a103ca62238cceaa4f4b31769a96637330d6b84) Thanks [@cesr](https://github.com/cesr)! - Split `memory_main_update` into `memory_main_write` (full overwrite) and `memory_main_edit` (targeted string replacement). Hot-reload AGENT.md and skills in dev mode without restarting the server. Merge agent + skill MCP tool patterns additively. Fix MissingToolResultsError when resuming from nested approval checkpoints.

## 0.24.0

### Minor Changes

- [`aee4f17`](https://github.com/cesr/poncho-ai/commit/aee4f17237d33b2cc134ed9934b709d967ca3f10) Thanks [@cesr](https://github.com/cesr)! - Add `edit_file` built-in tool with str_replace semantics for targeted file edits. The tool takes `path`, `old_str`, and `new_str` parameters, enforces uniqueness of the match, and is write-gated like `write_file` (disabled in production by default). Also improves browser SSE frame streaming with backpressure handling and auto-stops screencast when all listeners disconnect.

## 0.23.0

### Minor Changes

- [`d1e1bfb`](https://github.com/cesr/poncho-ai/commit/d1e1bfbf35b18788ab79231ca675774e949f5116) Thanks [@cesr](https://github.com/cesr)! - Add proactive scheduled messaging via channel-targeted cron jobs. Cron jobs with `channel: telegram` (or `slack`) now automatically discover known conversations and send the agent's response directly to each chat, continuing the existing conversation history.

## 0.22.1

### Patch Changes

- [`096953d`](https://github.com/cesr/poncho-ai/commit/096953d5a64a785950ea0a7f09e2183e481afd29) Thanks [@cesr](https://github.com/cesr)! - Improve time-to-first-token by lazy-loading the recall corpus

  The recall corpus (past conversation summaries) is now fetched on-demand only when the LLM invokes the `conversation_recall` tool, instead of blocking every message with ~1.3s of upfront I/O. Also adds batch `mget` support to Upstash/Redis/DynamoDB conversation stores, parallelizes memory fetch with skill refresh, debounces skill refresh in dev mode, and caches message conversions across multi-step runs.

## 0.22.0

### Minor Changes

- [`6f0abfd`](https://github.com/cesr/poncho-ai/commit/6f0abfd9f729b545cf293741ee813f705910aaf3) Thanks [@cesr](https://github.com/cesr)! - Add context compaction for long conversations. Automatically summarizes older messages when the context window fills up, keeping conversations going indefinitely. Includes auto-compaction in the run loop, `/compact` command, Web UI divider with expandable summary, and visual history preservation.

### Patch Changes

- Updated dependencies [[`6f0abfd`](https://github.com/cesr/poncho-ai/commit/6f0abfd9f729b545cf293741ee813f705910aaf3)]:
  - @poncho-ai/sdk@1.5.0

## 0.21.1

### Patch Changes

- [`76294e9`](https://github.com/cesr/poncho-ai/commit/76294e95035bf3abbb19c28871a33f82351c49ec) Thanks [@cesr](https://github.com/cesr)! - Add `provider` and `cdpUrl` to the `PonchoConfig.browser` type for cloud and remote browser configurations.

## 0.21.0

### Minor Changes

- [#33](https://github.com/cesr/poncho-ai/pull/33) [`f611bb9`](https://github.com/cesr/poncho-ai/commit/f611bb9137142de923d90502ece597d5cd6a5d3e) Thanks [@cesr](https://github.com/cesr)! - Add built-in `poncho_docs` tool for on-demand documentation discovery

  Agents in development mode can now call `poncho_docs` with a topic (`api`, `features`, `configuration`, `troubleshooting`) to load detailed framework documentation on demand. Docs are embedded at build time from `docs/*.md` at the repo root, keeping a single source of truth that stays in sync with releases.

## 0.20.14

### Patch Changes

- [`d997362`](https://github.com/cesr/poncho-ai/commit/d997362b114f6e9c5d95794cedff2c7675e32ca5) Thanks [@cesr](https://github.com/cesr)! - Add stealth mode to browser automation (enabled by default). Reduces bot-detection fingerprints with a realistic Chrome user-agent, navigator.webdriver override, window.chrome shim, fake plugins, WebGL patches, and anti-automation Chrome flags. Configurable via `stealth` and `userAgent` options in `poncho.config.js`.

## 0.20.13

### Patch Changes

- [`735eb64`](https://github.com/cesr/poncho-ai/commit/735eb6467831263671d56b58a79c736c602e594b) Thanks [@cesr](https://github.com/cesr)! - Add Telegram setup instructions to injected agent development context.

## 0.20.12

### Patch Changes

- [`3216e80`](https://github.com/cesr/poncho-ai/commit/3216e8072027896dd1cc5f29b1a7b0eea9ee1ff5) Thanks [@cesr](https://github.com/cesr)! - Add `allowedUserIds` option to Telegram adapter for restricting bot access to specific users.

## 0.20.11

### Patch Changes

- [`de28ef5`](https://github.com/cesr/poncho-ai/commit/de28ef5acceed921269d15816acd392f5208f03d) Thanks [@cesr](https://github.com/cesr)! - Add Telegram messaging adapter with private/group chat support, file attachments, /new command, and typing indicators.

- Updated dependencies [[`de28ef5`](https://github.com/cesr/poncho-ai/commit/de28ef5acceed921269d15816acd392f5208f03d)]:
  - @poncho-ai/sdk@1.4.1

## 0.20.10

### Patch Changes

- [`45fc930`](https://github.com/cesr/poncho-ai/commit/45fc93066547f8ba01eb6f2fcdff560f18da3451) Thanks [@cesr](https://github.com/cesr)! - Use clean `anthropic` provider name in telemetry instead of `anthropic.messages`, so Latitude correctly identifies the model.

## 0.20.9

### Patch Changes

- [`29cc075`](https://github.com/cesr/poncho-ai/commit/29cc075554077db177f93fd07af031da4a69ac51) Thanks [@cesr](https://github.com/cesr)! - Strip provider prefix from model names in AGENT.md (e.g. `anthropic/claude-sonnet-4-5` → `claude-sonnet-4-5`). The provider is extracted and used for routing; only the bare model name is sent to the API.

## 0.20.8

### Patch Changes

- [`0ec1f69`](https://github.com/cesr/poncho-ai/commit/0ec1f69a56b6424967d994663294adbbde1b9257) Thanks [@cesr](https://github.com/cesr)! - Support flat string `model: claude-opus-4-6` shorthand in AGENT.md frontmatter (in addition to nested `model: { name: ... }`). Log the resolved model name on first step for deployment debugging.

## 0.20.7

### Patch Changes

- [`8999a47`](https://github.com/cesr/poncho-ai/commit/8999a477b6e73ffb7c942a9cc5c85e704ec158b8) Thanks [@cesr](https://github.com/cesr)! - Enable token usage and cost tracking in Latitude telemetry by setting `recordInputs` and `recordOutputs` in the Vercel AI SDK's `experimental_telemetry` config.

## 0.20.6

### Patch Changes

- [`afbcc7b`](https://github.com/cesr/poncho-ai/commit/afbcc7b188258b7d193aa1f6f9f4462c2841ceec) Thanks [@cesr](https://github.com/cesr)! - Fix Latitude telemetry traces being silently dropped when conversation IDs are not valid UUIDs (e.g. Resend/Slack-derived IDs). Only pass conversationUuid to Latitude when it matches UUID v4 format.

## 0.20.5

### Patch Changes

- [`8286e1e`](https://github.com/cesr/poncho-ai/commit/8286e1ef244208d74e1daf8ef1c2a1a3afb1459e) Thanks [@cesr](https://github.com/cesr)! - Match Latitude telemetry integration exactly to their documented Vercel AI SDK pattern — no custom constructor options.

## 0.20.4

### Patch Changes

- [`c35f676`](https://github.com/cesr/poncho-ai/commit/c35f676cdc548a3db9212ae7909302a5b876bc40) Thanks [@cesr](https://github.com/cesr)! - Switch Latitude telemetry to use BatchSpanProcessor (default) instead of SimpleSpanProcessor. Sends all spans from a trace together in one OTLP batch, matching Latitude's expected integration pattern.

## 0.20.3

### Patch Changes

- [`28046fb`](https://github.com/cesr/poncho-ai/commit/28046fb39aea00968ac532c25db4f0d654e21876) Thanks [@cesr](https://github.com/cesr)! - Add diagnostic span processor to log telemetry span details for debugging trace export issues.

## 0.20.2

### Patch Changes

- [`ec7d7a8`](https://github.com/cesr/poncho-ai/commit/ec7d7a80bf84855d19454c52053375fe86815ae4) Thanks [@cesr](https://github.com/cesr)! - Upgrade `@latitude-data/telemetry` to ^2.0.4 which adds baggage propagation for Latitude attributes on all child spans, fixing traces not appearing in the Latitude platform.

## 0.20.1

### Patch Changes

- [`ec1bb60`](https://github.com/cesr/poncho-ai/commit/ec1bb601d4f47c1b50c391cdc169cbe1623b52aa) Thanks [@cesr](https://github.com/cesr)! - Log telemetry flush errors instead of silently swallowing them, improving diagnostics when traces fail to export.

## 0.20.0

### Minor Changes

- [`5df6b5f`](https://github.com/cesr/poncho-ai/commit/5df6b5fcdc98e0445bea504dc9d077f02d1e954f) Thanks [@cesr](https://github.com/cesr)! - Add polling fallback for web UI on serverless deployments: when the SSE event stream is unavailable (different instance from the webhook handler), the UI polls the conversation every 2 seconds until the run completes. Conversations now track a persisted `runStatus` field.

## 0.19.1

### Patch Changes

- [`470563b`](https://github.com/cesr/poncho-ai/commit/470563b96bbb5d2c6358a1c89dd3b52beb7799c8) Thanks [@cesr](https://github.com/cesr)! - Fix LocalUploadStore ENOENT on Vercel: use /tmp for uploads on serverless environments instead of the read-only working directory.

## 0.19.0

### Minor Changes

- [`075b9ac`](https://github.com/cesr/poncho-ai/commit/075b9ac3556847af913bf2b58f030575c3b99852) Thanks [@cesr](https://github.com/cesr)! - Batch tool approvals, fix serverless session persistence and adapter init
  - Batch tool approvals: all approval-requiring tool calls in a single step are now collected and presented together instead of one at a time.
  - Fix messaging adapter route registration: routes are only registered after successful initialization, preventing "Adapter not initialised" errors on Vercel.
  - Add stateless signed-cookie sessions so web UI auth survives serverless cold starts.

### Patch Changes

- Updated dependencies [[`075b9ac`](https://github.com/cesr/poncho-ai/commit/075b9ac3556847af913bf2b58f030575c3b99852)]:
  - @poncho-ai/sdk@1.4.0

## 0.18.0

### Minor Changes

- [`cd6ccd7`](https://github.com/cesr/poncho-ai/commit/cd6ccd7846e16fbaf17167617666796320ec29ce) Thanks [@cesr](https://github.com/cesr)! - Add MCP custom headers support, tool:generating streaming feedback, and cross-owner subagent recovery
  - **MCP custom headers**: `poncho mcp add --header "Name: value"` and `headers` config field let servers like Arcade receive extra HTTP headers alongside bearer auth.
  - **tool:generating event**: the harness now emits `tool:generating` events when the model begins writing tool-call arguments, so the web UI shows real-time "preparing <tool>" feedback instead of appearing stuck during large tool calls.
  - **Subagent recovery**: `list`/`listSummaries` accept optional `ownerId` so stale-subagent recovery on server restart scans across all owners.

### Patch Changes

- Updated dependencies [[`cd6ccd7`](https://github.com/cesr/poncho-ai/commit/cd6ccd7846e16fbaf17167617666796320ec29ce)]:
  - @poncho-ai/sdk@1.3.0

## 0.17.0

### Minor Changes

- [#16](https://github.com/cesr/poncho-ai/pull/16) [`972577d`](https://github.com/cesr/poncho-ai/commit/972577d255ab43c2c56f3c3464042a8a617b7f9e) Thanks [@cesr](https://github.com/cesr)! - Add subagent support: agents can spawn recursive copies of themselves as independent sub-conversations with blocking tool calls, read-only memory, approval tunneling to the parent thread, and nested sidebar display in the web UI. Also adds ConversationStore.listSummaries() for fast sidebar loading without reading full conversation files from disk.

### Patch Changes

- Updated dependencies [[`972577d`](https://github.com/cesr/poncho-ai/commit/972577d255ab43c2c56f3c3464042a8a617b7f9e)]:
  - @poncho-ai/sdk@1.2.0

## 0.16.1

### Patch Changes

- [`7475da5`](https://github.com/cesr/poncho-ai/commit/7475da5c0c2399e79064a2622137c0eb2fb16871) Thanks [@cesr](https://github.com/cesr)! - Inject browser usage context into agent system prompt (auth flow, session persistence, tool selection guidance).

## 0.16.0

### Minor Changes

- [`12f2845`](https://github.com/cesr/poncho-ai/commit/12f28457c20e650640ff2a1c1dbece2a6e4a9ddd) Thanks [@cesr](https://github.com/cesr)! - Add browser storage persistence (cookies/localStorage survive restarts via configured storage provider) and new `browser_content` tool for fast text extraction from pages.

## 0.15.1

### Patch Changes

- Fix browser session reconnection, tab lifecycle management, and web UI panel state handling.

- Updated dependencies []:
  - @poncho-ai/sdk@1.1.1

## 0.15.0

### Minor Changes

- [`139ed89`](https://github.com/cesr/poncho-ai/commit/139ed89a5df2372cfb0a124c967f51f4d8158c3b) Thanks [@cesr](https://github.com/cesr)! - Add browser automation for Poncho agents with real-time viewport streaming, per-conversation tab management, interactive browser control in the web UI, and shared agent-level profiles for authentication persistence.

### Patch Changes

- Updated dependencies [[`139ed89`](https://github.com/cesr/poncho-ai/commit/139ed89a5df2372cfb0a124c967f51f4d8158c3b)]:
  - @poncho-ai/sdk@1.1.0

## 0.14.2

### Patch Changes

- [`1f47bb4`](https://github.com/cesr/poncho-ai/commit/1f47bb49e5d48dc17644172012b057190b316469) Thanks [@cesr](https://github.com/cesr)! - Add conversation rename via double-click on the title in the web UI, standardize all credential config fields to the `*Env` naming pattern, and sync the init README template with the repo README.

- Updated dependencies [[`1f47bb4`](https://github.com/cesr/poncho-ai/commit/1f47bb49e5d48dc17644172012b057190b316469)]:
  - @poncho-ai/sdk@1.0.3

## 0.14.1

### Patch Changes

- [`e000b96`](https://github.com/cesr/poncho-ai/commit/e000b96837cbbb8d95c868c91a614f458868c444) Thanks [@cesr](https://github.com/cesr)! - Durable approval checkpoints, email conversation improvements, and web UI fixes
  - Simplify approval system to checkpoint-only (remove legacy blocking approvalHandler)
  - Optimize checkpoint storage with delta messages instead of full history
  - Add sidebar sections for conversations awaiting approval with status indicator
  - Fix nested checkpoint missing baseMessageCount in resumeRunFromCheckpoint
  - Improve email conversation titles (sender email + subject)
  - Remove email threading — each incoming email creates its own conversation
  - Fix streaming after approval to preserve existing messages (liveOnly mode)
  - Preserve newlines in user messages in web UI

- Updated dependencies [[`e000b96`](https://github.com/cesr/poncho-ai/commit/e000b96837cbbb8d95c868c91a614f458868c444)]:
  - @poncho-ai/sdk@1.0.2

## 0.14.0

### Minor Changes

- [`fed3e87`](https://github.com/cesr/poncho-ai/commit/fed3e870aecaea9dcbe8070f5bb2c828d4eb8921) Thanks [@cesr](https://github.com/cesr)! - Unified tool access configuration and web UI streaming for messaging conversations
  - New `tools` config in `poncho.config.js`: control any tool with `true` (available), `false` (disabled), or `'approval'` (requires human approval). Per-environment overrides via `byEnvironment`. Works for harness, adapter, MCP, and skill tools.
  - Messaging conversations (email via Resend) now stream events to the web UI: live tool progress, approval prompts, and text chunks display in real time.
  - Clicking a conversation with an active run in the web UI sidebar auto-attaches to the event stream.
  - Fix conversation persistence race condition in messaging runner (stale-write clobber).
  - Fix duplicated last section in persisted conversations.

### Patch Changes

- [`9e87d28`](https://github.com/cesr/poncho-ai/commit/9e87d2801ba7b8d4c8b0650563d59e9cad530ff6) Thanks [@cesr](https://github.com/cesr)! - Fix Latitude telemetry not exporting traces
  - Reuse a single `LatitudeTelemetry` instance across runs instead of creating one per run (avoids OpenTelemetry global registration conflicts)
  - Use `disableBatch` mode so spans export immediately instead of being silently lost on a 5s timer
  - Warn at startup when `telemetry.latitude` is configured with missing or misnamed fields (e.g. `apiKeyEnv` instead of `apiKey`)
  - Sanitize agent name for Latitude's path validation
  - Surface OTLP export errors in console output

## 0.13.1

### Patch Changes

- [#10](https://github.com/cesr/poncho-ai/pull/10) [`d5bce7b`](https://github.com/cesr/poncho-ai/commit/d5bce7be5890c657bea915eb0926feb6de66b218) Thanks [@cesr](https://github.com/cesr)! - Add generic messaging layer with Slack as the first adapter. Agents can now respond to @mentions in Slack by adding `messaging: [{ platform: 'slack' }]` to `poncho.config.js`. Includes signature verification, threaded conversations, processing indicators, and Vercel `waitUntil` support.

- Updated dependencies [[`d5bce7b`](https://github.com/cesr/poncho-ai/commit/d5bce7be5890c657bea915eb0926feb6de66b218)]:
  - @poncho-ai/sdk@1.0.1

## 0.13.0

### Minor Changes

- [#8](https://github.com/cesr/poncho-ai/pull/8) [`658bc54`](https://github.com/cesr/poncho-ai/commit/658bc54d391cb0b58aa678a2b86cd617eebdd8aa) Thanks [@cesr](https://github.com/cesr)! - Add cron job support for scheduled agent tasks. Define recurring jobs in AGENT.md frontmatter with schedule, task, and optional timezone. Includes in-process scheduler for local dev with hot-reload, HTTP endpoint for Vercel/serverless with self-continuation, Vercel scaffold generation with drift detection, and full tool activity tracking in cron conversations.

## 0.12.0

### Minor Changes

- [`035e8b3`](https://github.com/cesr/poncho-ai/commit/035e8b300ac4de6e7cbc4e2ab6bd06cdfd0e1ae3) Thanks [@cesr](https://github.com/cesr)! - Add multimodal file support for agents — images, PDFs, and text files can be uploaded via the web UI, HTTP API, and terminal CLI. Includes pluggable upload storage (local, Vercel Blob, S3), write-behind caching, build-time dependency injection, and graceful handling of unsupported formats.

### Patch Changes

- Updated dependencies [[`035e8b3`](https://github.com/cesr/poncho-ai/commit/035e8b300ac4de6e7cbc4e2ab6bd06cdfd0e1ae3)]:
  - @poncho-ai/sdk@1.0.0

## 0.11.2

### Patch Changes

- [`3dcb914`](https://github.com/cesr/poncho-ai/commit/3dcb914acd22c403ff5372d94a0fc2152a2574b3) Thanks [@cesr](https://github.com/cesr)! - Fix scaffolded dependency versions during `poncho init` so npm installs no longer request unavailable `^0.1.0` packages.

  Improve runtime resilience by retrying transient provider/model failures, returning clearer provider error codes, and sanitizing malformed conversation history so interrupted/bad-state chats can continue.

## 0.11.1

### Patch Changes

- [`8a3937e`](https://github.com/cesr/poncho-ai/commit/8a3937e95bfb7f269e8fe46dd41640eacb30af43) Thanks [@cesr](https://github.com/cesr)! - Increase the first model response timeout from 30s to 180s to reduce premature model timeout errors on slower providers.

## 0.11.0

### Minor Changes

- [`a1df23f`](https://github.com/cesr/poncho-ai/commit/a1df23f339d815c30948ebcd275209366a3d2a72) Thanks [@cesr](https://github.com/cesr)! - Add cooperative run cancellation: stop active runs via Ctrl+C (CLI), stop button (Web UI), or the /stop API endpoint. Partial output is preserved and empty assistant messages are skipped to prevent conversation corruption.

### Patch Changes

- Updated dependencies [[`a1df23f`](https://github.com/cesr/poncho-ai/commit/a1df23f339d815c30948ebcd275209366a3d2a72)]:
  - @poncho-ai/sdk@0.6.0

## 0.10.3

### Patch Changes

- Reduce serverless warnings when loading TypeScript skill scripts.

  The harness now uses `jiti` first for `.ts/.mts/.cts` scripts in `run_skill_script`, avoiding Node's native ESM warning spam for TypeScript files in deployed environments.

## 0.10.2

### Patch Changes

- Improve runtime loading of `poncho.config.js` in serverless environments.

  The harness now falls back to `jiti` when native ESM import of `poncho.config.js` fails, allowing deploys where bundlers/runtime packaging treat project `.js` files as CommonJS. The CLI patch picks up the updated harness runtime.

## 0.10.1

### Patch Changes

- Updated dependencies []:
  - @poncho-ai/sdk@0.5.0

## 0.7.1

### Patch Changes

- Persist pending approvals on conversation state and add SSE reconnect endpoint so Web UI approvals survive page refresh and stream responses in real-time.

## 0.7.0

### Minor Changes

- Simplify MCP tool patterns and improve auth UI
  - Allow tool patterns without server prefix in poncho.config.js (e.g., `include: ['*']` instead of `include: ['linear/*']`)
  - Fix auth screen button styling to be fully rounded with centered arrow
  - Add self-extension capabilities section to development mode instructions
  - Update documentation to clarify MCP pattern formats

## 0.6.0

### Minor Changes

- Add markdown table support and fix Latitude telemetry integration
  - Add markdown table rendering with `marked` library in web UI
  - Add table styling with horizontal scroll and hover effects
  - Add margins to HR elements for better spacing
  - Integrate Latitude telemetry with Vercel AI SDK using event queue pattern
  - Enable real-time streaming while capturing complete traces
  - Fix telemetry to show all messages and interactions in Latitude dashboard

## 0.5.0

### Minor Changes

- d6256b2: Migrate to Vercel AI SDK for unified model provider support

  This major refactoring replaces separate OpenAI and Anthropic client implementations with Vercel AI SDK's unified interface, simplifying the codebase by ~1,265 lines and enabling easier addition of new model providers.

  **Key improvements:**
  - Unified model provider interface via Vercel AI SDK
  - JSON Schema to Zod converter for tool definitions
  - Fixed tool call preservation in multi-step agent loops
  - Simplified architecture with better maintainability
  - Added comprehensive error handling for step execution

  **Breaking changes (internal API only):**
  - `ModelClient` interface removed (use Vercel AI SDK directly)
  - `OpenAiModelClient` and `AnthropicModelClient` classes removed
  - `createModelClient()` replaced with `createModelProvider()`

  **User-facing API unchanged:**
  - AGENT.md format unchanged
  - Tool definitions unchanged (JSON Schema still works)
  - Model provider names unchanged (`openai`, `anthropic`)
  - Agent behavior unchanged from user perspective

## 0.4.1

### Patch Changes

- Fix MCP tool prefix to use `mcp:` instead of `@mcp:` for YAML compatibility. The `@` character is reserved in YAML and cannot start plain values without quoting.

## 0.4.0

### Minor Changes

- BREAKING: Switch to AgentSkills allowed-tools format with mcp/ prefix

  Replace nested `tools: { mcp: [...], scripts: [...] }` with flat `allowed-tools: [...]` list format. MCP tools now require `mcp/` prefix (e.g., `mcp/github/list_issues`).

  Migration: Update AGENT.md and SKILL.md frontmatter from:

  ```yaml
  tools:
    mcp:
      - github/list_issues
  ```

  To:

  ```yaml
  allowed-tools:
    - mcp/github/list_issues
  ```

## 0.3.1

### Patch Changes

- Split agent template and development context

  Move development-specific guidance from AGENT.md template into runtime-injected development context. Production agents now receive a cleaner prompt focused on task execution, while development agents get additional context about customization and setup.

## 0.3.0

### Minor Changes

- Implement tool policy and declarative intent system

  Add comprehensive tool policy framework for MCP and script tools with pattern matching, environment-based configuration, and declarative tool intent in AGENT.md and SKILL.md frontmatter.

## 0.2.0

### Minor Changes

- Initial release of Poncho - an open framework for building and deploying AI agents.
  - `@poncho-ai/sdk`: Core types and utilities for building Poncho skills
  - `@poncho-ai/harness`: Agent execution runtime with conversation loop, tool dispatch, and streaming
  - `@poncho-ai/client`: TypeScript client for calling deployed Poncho agents
  - `@poncho-ai/cli`: CLI for building and deploying AI agents

### Patch Changes

- Updated dependencies []:
  - @poncho-ai/sdk@0.2.0
