# Poncho SPEC Progress Tracker

This document tracks implementation progress against `docs/SPEC.md` after completing MVP and subsequent full-spec expansion work.

## Current Scope Decisions

- Model runtime supports Anthropic and OpenAI (provider selected via `AGENT.md` frontmatter).
- Advanced provider routing/fallback across multiple providers is still deferred.
- Some advanced features are implemented as practical stubs/interfaces pending production hardening.

## Delivered

### Core Foundation

- [x] Monorepo TypeScript baseline with shared `tsconfig.base.json`.
- [x] Package entrypoints and build scripts for `sdk`, `harness`, `cli`, and `client`.
- [x] Shared runtime types and event contracts in `@poncho-ai/sdk`.

### Agent Definition (`SPEC.md` section 4)

- [x] `AGENT.md` parser with YAML frontmatter extraction.
- [x] Validation for required `name`.
- [x] Mustache rendering for runtime and parameter context.

### Harness (`SPEC.md` sections 5 and 6)

- [x] Turn-based loop (prepare -> model call -> tool execution -> completion).
- [x] Event emission (`run:*`, `step:*`, `model:*`, `tool:*`).
- [x] Tool registration and execution dispatcher.
- [x] Remote MCP bridge with WebSocket session handling and reconnect/backoff baseline.
- [x] Message window compaction (bounded context window).
- [x] Batch tool execution path.
- [x] In-memory conversation state store interface and implementation.
- [x] Telemetry emitter interface with configurable event sink handler.
- [x] Local skill discovery from `skills/**/tools/*` (JS/TS) and tool registration.
- [x] `SKILL.md` context injection into the model system prompt (`Agent Skills Context` section).
- [x] Default filesystem tools with production-safe write gating (`write_file` disabled by default in production).

### CLI (`SPEC.md` section 9)

- [x] `poncho init` scaffolding command.
- [x] `poncho dev` local server command.
- [x] `poncho run` one-shot and interactive mode.
- [x] `poncho test`.
- [x] `poncho tools`.
- [x] `poncho add`.
- [x] `poncho build <target>` (`vercel`, `docker`, `lambda`, `fly`) artifact generation.
- [x] `poncho mcp add/list/remove`.
- [x] `poncho update-agent` guidance backfill/replacement for existing `AGENT.md`.
- [x] Improved interactive TUI (streaming-first output, spinner, cleaner tool event rendering).

### HTTP API (`SPEC.md` section 12)

- [x] `/run` (SSE).
- [x] `/run/sync`.
- [x] `/continue`.
- [x] `/health`.
- [x] Configurable auth check in server flow.
- [x] Server-managed conversation continuation with state store.

### Client (`SPEC.md` section 12.5)

- [x] `AgentClient` with sync `run()` support.
- [x] `AgentClient.stream()` for SSE event consumption.
- [x] `AgentClient.continue()` support.
- [x] Conversation helper API (`conversation().send()`).

## Deferred / Partially Implemented

### Provider Expansion

- [x] Base multi-provider abstraction (provider factory + shared model client interface).
- [x] OpenAI provider runtime support.
- [ ] Configurable provider routing and fallback policy.
- [ ] Additional provider integrations beyond Anthropic/OpenAI.

### MCP

- [x] Remote-only MCP strategy adopted.
- [x] `poncho mcp add/list/remove` command set exists.
- [x] MCP protocol transport implementation (remote WebSocket JSON-RPC with `tools/list` + `tools/call`).
- [x] Remote MCP WebSocket session management with reconnect/backoff baseline.
- [ ] Heartbeat and health-probe policy for remote MCP sessions.
- [ ] Advanced remote MCP resilience policies (circuit breaking, jittered backoff tuning).

### Runtime and Security

- [x] Message window compaction.
- [x] Batch tool execution.
- [ ] Harness hooks extension points.
- [x] Endpoint auth modes and custom validators (basic support).
- [x] Tool approval events + policy checks for `requiresApproval` tools.
- [x] Persistent state provider adapters (Redis/Upstash/Vercel KV/DynamoDB with graceful fallback).
- [ ] End-to-end token-window summarization (semantic summarizer instead of truncation).

### Observability

- [x] Telemetry event sink hook and default console logging.
- [x] OpenTelemetry-compatible HTTP exporter hook (basic OTLP payload emission).
- [x] Optional Latitude telemetry transport hook.
- [x] Latitude capture integration around model calls with `projectId` + `path` support.
- [x] Anthropic/OpenAI telemetry instrumentation wiring with non-fatal fallback behavior.

### Build and Deployment Hardening

- [x] Build commands for `vercel`, `docker`, `lambda`, `fly`.
- [x] Vercel production deploy path validated end-to-end (health + live `/run/sync` conversation).
- [ ] Production-grade deploy bundles and runtime bootstrap parity for Docker/Lambda/Fly.

### Web UI Stream (`docs/SPEC_WEB_UI.md`)

#### Phase 1 (MVP)

- [ ] ChatGPT-style web shell (sidebar + chat pane).
- [ ] Streaming chat wired to `/run` and continuation wired to `/continue`.
- [ ] Conversation CRUD (create/list/open/rename/delete) with persistence.
- [ ] Hardened passphrase login + secure session cookie baseline.

#### Phase 2 (Usability + Security Hardening)

- [ ] Conversation search and improved connection/retry UX.
- [ ] Session rotation/expiry UX and stronger session lifecycle controls.
- [ ] Accessibility and empty/error/loading state polish.

#### Phase 3 (Tenant-Aware Expansion)

- [ ] Tenant-aware authorization model implementation.
- [ ] Optional enterprise auth adapters / stricter deployment profiles.
- [ ] Migration and compatibility validation from single-user defaults.

## Notes

- This tracker now reflects post-MVP expansion and highlights remaining parity gaps.
- Remaining items are mostly hardening/integration depth, not command/API surface availability.
