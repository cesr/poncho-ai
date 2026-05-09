import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentHarness } from "../src/harness.js";
import { InMemoryEngine } from "../src/storage/memory-engine.js";

const AGENT_MD = `---
name: injected-agent
model:
  provider: anthropic
  name: claude-opus-4-5
---

# Injected agent

You are a test agent.
`;

describe("HarnessOptions injection (PR 1)", () => {
  it("initializes without an AGENT.md on disk when agentDefinition + storageEngine are provided", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poncho-injection-"));
    try {
      const engine = new InMemoryEngine("user-123");
      const harness = new AgentHarness({
        workingDir: dir,
        agentDefinition: AGENT_MD,
        storageEngine: engine,
      });
      await expect(harness.initialize()).resolves.toBeUndefined();
      // No AGENT.md was written into `dir` — confirm initialize ran from
      // injected content alone.
      expect(harness.frontmatter?.name).toBe("injected-agent");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("mirrors storageEngine.agentId onto frontmatter.id on the injected path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poncho-injection-id-"));
    try {
      const engine = new InMemoryEngine("user-456");
      const harness = new AgentHarness({
        workingDir: dir,
        agentDefinition: AGENT_MD,
        storageEngine: engine,
      });
      await harness.initialize();
      expect(harness.frontmatter?.id).toBe("user-456");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("accepts a pre-parsed ParsedAgent as agentDefinition", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poncho-injection-parsed-"));
    try {
      const engine = new InMemoryEngine("user-789");
      const parsed = {
        frontmatter: {
          name: "preparsed-agent",
          model: { provider: "anthropic" as const, name: "claude-opus-4-5" },
        },
        body: "# Pre-parsed agent\n",
      };
      const harness = new AgentHarness({
        workingDir: dir,
        agentDefinition: parsed,
        storageEngine: engine,
      });
      await harness.initialize();
      expect(harness.frontmatter?.name).toBe("preparsed-agent");
      expect(harness.frontmatter?.id).toBe("user-789");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws when agentDefinition is provided without storageEngine", () => {
    expect(
      () =>
        new AgentHarness({
          agentDefinition: AGENT_MD,
        }),
    ).toThrow(/agentDefinition requires HarnessOptions\.storageEngine/);
  });

  it("falls back to disk path when neither agentDefinition nor storageEngine is provided (existing behaviour unchanged)", async () => {
    // This is implicitly covered by every other test in harness.test.ts —
    // we simply assert that the constructor accepts no injection options.
    expect(() => new AgentHarness({ workingDir: tmpdir() })).not.toThrow();
  });
});
