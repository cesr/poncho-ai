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
      parameters: { project: "poncho" },
      runtime: { environment: "development", workingDir: "/tmp/work" },
    });

    expect(prompt).toContain("Project: poncho");
    expect(prompt).toContain("Env: development");
  });

  it("parses approval-required with relative script paths", () => {
    const parsed = parseAgentMarkdown(`---
name: test-agent
allowed-tools:
  - mcp:github/list_issues
  - mcp:github/create_issue
  - ./tools/deploy.ts
approval-required:
  - mcp:github/create_issue
  - ./scripts/release.ts
  - ./tools/deploy.ts
---

# Agent
`);
    expect(parsed.frontmatter.allowedTools?.mcp).toEqual([
      "github/list_issues",
      "github/create_issue",
    ]);
    expect(parsed.frontmatter.approvalRequired?.mcp).toEqual(["github/create_issue"]);
    expect(parsed.frontmatter.approvalRequired?.scripts).toEqual([
      "./scripts/release.ts",
      "./tools/deploy.ts",
    ]);
  });
});
