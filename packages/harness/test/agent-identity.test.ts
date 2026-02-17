import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAgentDirectoryName,
  ensureAgentIdentity,
  STORAGE_SCHEMA_VERSION,
} from "../src/agent-identity.js";

describe("agent identity", () => {
  it("backfills AGENT.md id when missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poncho-agent-identity-"));
    await writeFile(
      join(dir, "AGENT.md"),
      `---
name: identity-agent
model:
  provider: anthropic
  name: claude-opus-4-5
---

# Identity Agent
`,
      "utf8",
    );
    const identity = await ensureAgentIdentity(dir);
    expect(identity.name).toBe("identity-agent");
    expect(identity.id).toMatch(/^agent_[a-f0-9]{32}$/);
    const updated = await readFile(join(dir, "AGENT.md"), "utf8");
    expect(updated).toContain(`id: ${identity.id}`);
  });

  it("builds stable storage directory names", () => {
    const directory = buildAgentDirectoryName({
      name: "Support Agent",
      id: "agent_abc123",
    });
    expect(directory).toBe("support-agent--agent_abc123");
    expect(STORAGE_SCHEMA_VERSION).toBe("v1");
  });
});
