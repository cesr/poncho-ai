import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentHarness } from "../src/harness.js";
import type { PonchoConfig } from "../src/config.js";

const AGENT_MD = `---
name: config-inject-agent
model:
  provider: anthropic
  name: claude-opus-4-5
---

# Config injection test
`;

describe("HarnessOptions.config injection (PR 2)", () => {
  it("uses an injected PonchoConfig instead of reading poncho.config.js from disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poncho-cfg-injected-"));
    try {
      await writeFile(join(dir, "AGENT.md"), AGENT_MD, "utf8");
      // Deliberately do NOT write a poncho.config.js — the injected
      // config should be used end-to-end.
      const config: PonchoConfig = {
        tools: { web_search: false },
        storage: { provider: "memory" },
      };

      const harness = new AgentHarness({ workingDir: dir, config });
      await harness.initialize();

      const names = harness.listTools().map((t) => t.name);
      // web_search was disabled in the injected config; bash is a default
      // built-in that should still be registered.
      expect(names).not.toContain("web_search");
      expect(names).toContain("bash");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("disk-loaded behaviour is unchanged when no config option is provided", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poncho-cfg-disk-"));
    try {
      await writeFile(join(dir, "AGENT.md"), AGENT_MD, "utf8");
      // Write a poncho.config.js that disables a tool — proves loadPonchoConfig
      // ran (otherwise web_search would be present).
      await writeFile(
        join(dir, "poncho.config.js"),
        "export default { tools: { web_search: false }, storage: { provider: 'memory' } };\n",
        "utf8",
      );
      const harness = new AgentHarness({ workingDir: dir });
      await harness.initialize();
      const names = harness.listTools().map((t) => t.name);
      expect(names).not.toContain("web_search");
      expect(names).toContain("bash");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
