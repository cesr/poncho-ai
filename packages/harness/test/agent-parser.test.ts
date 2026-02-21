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

  describe("cron jobs", () => {
    it("parses cron jobs from frontmatter", () => {
      const parsed = parseAgentMarkdown(`---
name: test-agent
cron:
  daily-report:
    schedule: "0 9 * * *"
    task: "Generate the daily report"
  health-check:
    schedule: "*/30 * * * *"
    timezone: "America/New_York"
    task: "Check all APIs"
---

# Agent
`);
      expect(parsed.frontmatter.cron).toBeDefined();
      expect(Object.keys(parsed.frontmatter.cron!)).toEqual([
        "daily-report",
        "health-check",
      ]);
      expect(parsed.frontmatter.cron!["daily-report"]).toEqual({
        schedule: "0 9 * * *",
        task: "Generate the daily report",
        timezone: undefined,
      });
      expect(parsed.frontmatter.cron!["health-check"]).toEqual({
        schedule: "*/30 * * * *",
        task: "Check all APIs",
        timezone: "America/New_York",
      });
    });

    it("returns undefined cron when not defined", () => {
      const parsed = parseAgentMarkdown(`---
name: test-agent
---

# Agent
`);
      expect(parsed.frontmatter.cron).toBeUndefined();
    });

    it("throws on missing schedule", () => {
      expect(() =>
        parseAgentMarkdown(`---
name: test-agent
cron:
  bad-job:
    task: "Do something"
---

# Agent
`),
      ).toThrow(/"schedule" is required/);
    });

    it("throws on missing task", () => {
      expect(() =>
        parseAgentMarkdown(`---
name: test-agent
cron:
  bad-job:
    schedule: "0 9 * * *"
---

# Agent
`),
      ).toThrow(/"task" is required/);
    });

    it("throws on invalid cron expression", () => {
      expect(() =>
        parseAgentMarkdown(`---
name: test-agent
cron:
  bad-job:
    schedule: "every day"
    task: "Do something"
---

# Agent
`),
      ).toThrow(/Invalid cron expression/);
    });

    it("throws on invalid timezone", () => {
      expect(() =>
        parseAgentMarkdown(`---
name: test-agent
cron:
  bad-job:
    schedule: "0 9 * * *"
    timezone: "Fake/Zone"
    task: "Do something"
---

# Agent
`),
      ).toThrow(/Invalid timezone/);
    });

    it("accepts valid timezone", () => {
      const parsed = parseAgentMarkdown(`---
name: test-agent
cron:
  job:
    schedule: "0 9 * * *"
    timezone: "Europe/London"
    task: "Do something"
---

# Agent
`);
      expect(parsed.frontmatter.cron!["job"]!.timezone).toBe("Europe/London");
    });
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
