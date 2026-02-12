import { describe, expect, it } from "vitest";
import { parseAgentMarkdown, renderAgentPrompt } from "../src/agent-parser.js";

describe("agent parser", () => {
  it("parses frontmatter and body", () => {
    const parsed = parseAgentMarkdown(`---
name: test-agent
description: test description
model:
  provider: anthropic
  name: claude-opus-4-5
---

# Hello
Working dir: {{runtime.workingDir}}
`);

    expect(parsed.frontmatter.name).toBe("test-agent");
    expect(parsed.frontmatter.description).toBe("test description");
    expect(parsed.body).toContain("# Hello");
  });

  it("renders mustache runtime and parameter context", () => {
    const parsed = parseAgentMarkdown(`---
name: test-agent
---

Project: {{parameters.project}}
Env: {{runtime.environment}}
`);
    const prompt = renderAgentPrompt(parsed, {
      parameters: { project: "agentl" },
      runtime: { environment: "development", workingDir: "/tmp/work" },
    });

    expect(prompt).toContain("Project: agentl");
    expect(prompt).toContain("Env: development");
  });
});
