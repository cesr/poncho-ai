// ---------------------------------------------------------------------------
// Bash tool definition – agent-facing bash interpreter tool.
// ---------------------------------------------------------------------------

import { defineTool, type ToolDefinition } from "@poncho-ai/sdk";
import type { BashEnvironmentManager } from "./bash-manager.js";

export const createBashTool = (
  bashManager: BashEnvironmentManager,
): ToolDefinition => defineTool({
  name: "bash",
  description:
    "Execute a bash command or script in a sandboxed environment. " +
    "The environment has a persistent virtual filesystem — files written in one call " +
    "are available in subsequent calls. Supports standard commands: ls, cat, echo, " +
    "grep, awk, jq, sed, sort, head, tail, wc, find, mkdir, cp, mv, rm, etc. " +
    "Use this for data processing, file manipulation, and script execution.",
  inputSchema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The bash command or script to execute",
      },
      timeout: {
        type: "number",
        description: "Timeout in milliseconds (default: 30000)",
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
  handler: async (input, context) => {
    const tenantId = context.tenantId ?? "__default__";

    // Refresh PostgreSQL path cache before exec
    await bashManager.refreshPathCache(tenantId);

    const bash = bashManager.getOrCreate(tenantId);
    const timeout = typeof input.timeout === "number" ? input.timeout : 30_000;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const result = await bash.exec(input.command as string, {
        signal: controller.signal,
      });

      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    } finally {
      clearTimeout(timer);
    }
  },
});
