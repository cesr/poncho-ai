---
"@poncho-ai/harness": minor
"@poncho-ai/cli": patch
---

harness: export `defaultAgentDefinition` so SDK consumers can match `poncho init` exactly

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
