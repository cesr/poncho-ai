---
"@poncho-ai/harness": minor
---

harness: allow programmatic agent + storage injection (no AGENT.md required)

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
