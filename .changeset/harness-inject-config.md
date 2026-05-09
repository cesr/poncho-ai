---
"@poncho-ai/harness": minor
---

harness: allow programmatic `PonchoConfig` injection

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
