import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultAgentDefinition } from "@poncho-ai/harness";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..");

const readCliVersion = async (): Promise<string> => {
  const fallback = "0.1.0";
  try {
    const packageJsonPath = resolve(packageRoot, "package.json");
    const content = await readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(content) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.trim().length > 0) {
      return parsed.version;
    }
  } catch {
    // Use fallback when package metadata cannot be read.
  }
  return fallback;
};

/**
 * Thin back-compat wrapper around `defaultAgentDefinition` from the harness
 * package. The canonical template now lives in
 * `@poncho-ai/harness/src/default-agent.ts` so SDK consumers can pass the
 * exact same default to `new AgentHarness({ agentDefinition })` without
 * hand-copying the template.
 */
export const AGENT_TEMPLATE = (
  name: string,
  id: string,
  options: { modelProvider: "anthropic" | "openai" | "openai-codex"; modelName: string },
): string =>
  defaultAgentDefinition({
    name,
    id,
    modelProvider: options.modelProvider,
    modelName: options.modelName,
  });

/**
 * Resolve the monorepo packages root if we're running from a local dev build.
 * Returns the absolute path to the \`packages/\` directory, or null when
 * running from an npm-installed copy.
 */
export const resolveLocalPackagesRoot = (): string | null => {
  // __dirname is packages/cli/dist — the monorepo root is three levels up
  const candidate = resolve(__dirname, "..", "..", "harness", "package.json");
  if (existsSync(candidate)) {
    return resolve(__dirname, "..", "..");
  }
  return null;
};

/**
 * Resolve the @poncho-ai/cli dependency specifier for the scaffolded project.
 * In dev mode we use \`link:\` so pnpm can resolve the local package;
 * in production we point at the npm registry.
 */
export const resolveCliDep = async (projectDir: string): Promise<string> => {
  const packagesRoot = resolveLocalPackagesRoot();
  if (packagesRoot) {
    const cliAbs = resolve(packagesRoot, "cli");
    return `link:${relative(projectDir, cliAbs)}`;
  }
  const version = await readCliVersion();
  return `^${version}`;
};

export const PACKAGE_TEMPLATE = async (name: string, projectDir: string): Promise<string> => {
  const cliDep = await resolveCliDep(projectDir);
  return JSON.stringify(
    {
      name,
      private: true,
      type: "module",
      scripts: {
        dev: "poncho dev",
        start: "poncho dev",
        test: "poncho test",
      },
      dependencies: {
        "@poncho-ai/cli": cliDep,
      },
    },
    null,
    2,
  );
};

export const README_TEMPLATE = (name: string): string => `# ${name}

An AI agent built with [Poncho](https://github.com/cesr/poncho-ai).

## Prerequisites

- Node.js 20+
- npm (or pnpm/yarn)
- Anthropic API key, OpenAI API key, or OpenAI Codex OAuth refresh token

## Quick Start

\`\`\`bash
npm install
# If you didn't enter credentials during init:
cp .env.example .env
# Then edit .env and add provider credentials
poncho dev
\`\`\`

For OpenAI Codex OAuth bootstrap:

\`\`\`bash
poncho auth login --provider openai-codex --device
poncho auth export --provider openai-codex --format env
\`\`\`

Open \`http://localhost:3000\` for the web UI, or \`http://localhost:3000/api/docs\` for interactive API documentation.

The web UI supports file attachments (drag-and-drop, paste, or attach button), conversation management (sidebar), a context window usage ring, and tool approval prompts. It can be installed as a PWA.

On your first interactive session, the agent introduces its configurable capabilities.
While a response is streaming, you can stop it:
- Web UI: click the send button again (it switches to a stop icon)
- Interactive CLI: press \`Ctrl+C\`

Stopping is best-effort and keeps partial assistant output/tool activity already produced.

Interactive CLI commands: \`/help\`, \`/clear\`, \`/tools\`, \`/exit\`, \`/attach <path>\`, \`/files\`, \`/list\`, \`/open <id>\`, \`/new [title]\`, \`/delete [id]\`, \`/continue\`, \`/compact [focus]\`, \`/reset [all]\`.

## Common Commands

\`\`\`bash
# Local web UI + API server
poncho dev
poncho dev --port 8080

# Local interactive CLI
poncho run --interactive

# One-off run
poncho run "Your task here"
poncho run "Explain this code" --file ./src/index.ts
poncho run "Review the code" --param projectName=my-app

# Run tests
poncho test

# List available tools
poncho tools

# OpenAI Codex auth (OAuth subscription)
poncho auth login --provider openai-codex --device
poncho auth status --provider openai-codex
poncho auth export --provider openai-codex --format env

# Remove deprecated guidance from AGENT.md after upgrading
poncho update-agent

# Multi-tenancy: create a tenant token
poncho auth create-token --tenant acme-corp --ttl 24h

# Manage per-tenant secrets
poncho secrets set --tenant acme-corp LINEAR_API_KEY lk_123
poncho secrets list --tenant acme-corp
poncho secrets delete --tenant acme-corp LINEAR_API_KEY
\`\`\`

## Add Skills

Install skills from a local path or remote repository, then verify discovery:

\`\`\`bash
# Install all skills from a source package/repo
poncho skills add <repo-or-path>

# Install one specific skill path from a source
poncho skills add <repo-or-path> <relative-skill-path>

# Remove all installed skills from a source
poncho skills remove <repo-or-path>

# Remove one installed skill path from a source
poncho skills remove <repo-or-path> <relative-skill-path>

# List installed skills
poncho skills list

# Verify loaded tools
poncho tools
\`\`\`

\`poncho skills add\` copies discovered skill directories (folders that contain \`SKILL.md\`) into \`skills/<source>/...\`.
If a destination folder already exists, the command fails instead of overwriting files.
\`poncho add\` and \`poncho remove\` remain available as aliases.

After adding skills, run \`poncho dev\` or \`poncho run --interactive\` and ask the agent to use them.

## Configure MCP Servers (Remote)

Connect remote MCP servers and expose their tools to the agent:

\`\`\`bash
# Add remote MCP server
poncho mcp add --url https://mcp.example.com/github --name github --auth-bearer-env GITHUB_TOKEN

# Server with custom headers (e.g. Arcade)
poncho mcp add --url https://mcp.arcade.dev --name arcade \\
  --auth-bearer-env ARCADE_API_KEY --header "Arcade-User-ID: user@example.com"

# List configured servers
poncho mcp list

# Discover MCP tools and print frontmatter intent snippets
poncho mcp tools list github
poncho mcp tools select github

# Remove a server
poncho mcp remove github
\`\`\`

Set required secrets in \`.env\` (for example, \`GITHUB_TOKEN=...\`).

## Tool Intent and Approvals in Frontmatter

Declare tool intent directly in \`AGENT.md\` and \`SKILL.md\` frontmatter:

\`\`\`yaml
allowed-tools:
  - mcp:github/list_issues
  - mcp:github/*
approval-required:
  - mcp:github/create_issue
  - ./scripts/deploy.ts
\`\`\`

How it works:

- \`AGENT.md\` provides fallback MCP intent when no skill is active.
- \`SKILL.md\` intent applies when you activate that skill (\`activate_skill\`).
- Scripts in a sibling \`scripts/\` directory are available by convention.
- For non-standard script folders (for example \`tools/\`), add explicit relative entries in \`allowed-tools\`.
- Use \`approval-required\` to require human approval for specific MCP calls or script files.
- Deactivating a skill (\`deactivate_skill\`) removes its MCP tools from runtime registration.

Pattern format:

- MCP: \`mcp:server/tool\`, \`mcp:server/*\` (protocol-like prefix)
- Scripts: relative paths such as \`./scripts/file.ts\`, \`./scripts/*\`, \`./tools/deploy.ts\`

Skill authoring guardrails:

- Every \`SKILL.md\` must include YAML frontmatter between \`---\` markers.
- Include at least \`name\` (required for discovery) and \`description\`.
- Put tool intent in frontmatter using \`allowed-tools\` and \`approval-required\`.
- \`approval-required\` is stricter than allowed access:
  - MCP entries in \`approval-required\` must also appear in \`allowed-tools\`.
  - Script entries outside \`./scripts/\` must also appear in \`allowed-tools\`.
- Keep MCP server connection details in \`poncho.config.js\`, not in \`SKILL.md\`.

## Configuration

Core files:

- \`AGENT.md\`: behavior, model selection, runtime guidance
- \`poncho.config.js\`: runtime config (storage, auth, telemetry, MCP, tools)
- \`.env\`: secrets and environment variables (loaded before the harness starts, so \`process.env\` is available in skill scripts)

Example \`poncho.config.js\`:

\`\`\`javascript
export default {
  storage: {
    provider: "local", // local | memory | redis | upstash | dynamodb
    memory: {
      enabled: true,
      maxRecallConversations: 20,
    },
  },
  auth: {
    required: false,
  },
  telemetry: {
    enabled: true,
  },
  mcp: [
    {
      name: "github",
      url: "https://mcp.example.com/github",
      auth: { type: "bearer", tokenEnv: "GITHUB_TOKEN" },
    },
    // Custom headers for servers that require them (e.g. Arcade)
    // { name: "arcade", url: "https://mcp.arcade.dev", auth: { type: "bearer", tokenEnv: "ARCADE_API_KEY" }, headers: { "Arcade-User-ID": "user@example.com" } },
  ],
  // Tool access: true (available), false (disabled), 'approval' (requires human approval)
  tools: {
    list_directory: true,
    read_file: true,
    write_file: true,           // gated by environment for writes
    edit_file: true,            // gated by environment for writes
    delete_file: 'approval',    // requires human approval
    delete_directory: 'approval', // requires human approval
    send_email: 'approval',     // requires human approval
    byEnvironment: {
      production: {
        write_file: false,
        edit_file: false,
        delete_file: false,
        delete_directory: false,
      },
      development: {
        send_email: true,       // skip approval in dev
      },
    },
  },
  // browser: true, // Enable browser automation tools (requires @poncho-ai/browser)
  // browser: { provider: 'browserbase' }, // Cloud browser for serverless (Vercel, Lambda)
  // webUi: false, // Disable built-in UI for API-only deployments
  // uploads: { provider: 'local' }, // 'local' | 'vercel-blob' | 's3'
};
\`\`\`

## Project Structure

\`\`\`
\${name}/
\u251C\u2500\u2500 AGENT.md           # Agent definition and system prompt
\u251C\u2500\u2500 poncho.config.js   # Configuration (MCP servers, auth, etc.)
\u251C\u2500\u2500 package.json       # Dependencies
\u251C\u2500\u2500 .env.example       # Environment variables template
\u251C\u2500\u2500 tests/
\u2502   \u2514\u2500\u2500 basic.yaml     # Test suite
\u2514\u2500\u2500 skills/
    \u2514\u2500\u2500 starter/
        \u251C\u2500\u2500 SKILL.md
        \u2514\u2500\u2500 scripts/
            \u2514\u2500\u2500 starter-echo.ts
\`\`\`

## Cron Jobs

Define scheduled tasks in \`AGENT.md\` frontmatter:

\`\`\`yaml
cron:
  daily-report:
    schedule: "0 9 * * *"
    task: "Generate the daily sales report"
  morning-checkin:
    schedule: "0 8 * * 1-5"
    task: "Check in with the user about their day"
    channel: telegram
\`\`\`

- \`poncho dev\`: jobs run via an in-process scheduler.
- \`poncho build vercel\`: generates \`vercel.json\` cron entries. Set \`CRON_SECRET\` to the same value as \`PONCHO_AUTH_TOKEN\` so Vercel can authenticate.
- Docker/Fly.io/Railway: scheduler runs automatically.
- Lambda: use AWS EventBridge to trigger \`GET /api/cron/<jobName>\` with \`Authorization: Bearer <token>\`.
- Trigger manually: \`curl http://localhost:3000/api/cron/daily-report\`

Add \`channel: telegram\` (or another platform) to have the agent proactively send the response to all known chats on that platform. The bot must have received at least one message from each user first.

## Reminders

One-off reminders are enabled by default. The agent gets \`set_reminder\`, \`list_reminders\`, and \`cancel_reminder\` tools. Users can say things like "remind me tomorrow at 9am to check the report."

Configure in \`poncho.config.js\`:

\`\`\`javascript
export default {
  reminders: {
    enabled: true,
    pollSchedule: '*/10 * * * *', // how often to check for due reminders
  },
};
\`\`\`

- Reminders fire via a polling loop (same interval locally and on serverless).
- On Vercel, \`poncho build vercel\` adds a cron entry for \`/api/reminders/check\`.
- Channel reminders (Telegram/Slack) reply in the original conversation.
- Non-channel reminders create a new \`[reminder]\` conversation visible in the web UI.

## Messaging (Slack)

Connect your agent to Slack so it responds to @mentions:

1. Create a Slack App at [api.slack.com/apps](https://api.slack.com/apps)
2. Add Bot Token Scopes: \`app_mentions:read\`, \`chat:write\`, \`reactions:write\`
3. Enable Event Subscriptions, set Request URL to \`https://<your-url>/api/messaging/slack\`, subscribe to \`app_mention\`
4. Install to workspace, copy Bot Token and Signing Secret
5. Set env vars:
   \`\`\`
   SLACK_BOT_TOKEN=xoxb-...
   SLACK_SIGNING_SECRET=...
   \`\`\`
6. Add to \`poncho.config.js\`:
   \`\`\`javascript
   messaging: [{ platform: 'slack' }]
   \`\`\`

**Vercel deployments:** install \`@vercel/functions\` so Poncho can keep the serverless function alive while processing: \`npm install @vercel/functions\`

## Messaging (Telegram)

Connect your agent to Telegram so it responds to messages and @mentions:

1. Talk to [@BotFather](https://t.me/BotFather) on Telegram, send \`/newbot\`, and follow the prompts
2. Copy the Bot Token
3. Set env vars:
   \`\`\`
   TELEGRAM_BOT_TOKEN=123456:ABC-...
   TELEGRAM_WEBHOOK_SECRET=my-secret-token   # optional but recommended
   \`\`\`
4. Add to \`poncho.config.js\`:
   \`\`\`javascript
   messaging: [{ platform: 'telegram' }]
   \`\`\`
5. Register the webhook after deploying:
   \`\`\`bash
   curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \\
     -H "Content-Type: application/json" \\
     -d '{"url": "https://<your-url>/api/messaging/telegram", "secret_token": "<SECRET>"}'
   \`\`\`

The bot responds to all messages in private chats and only to @mentions in groups. Use \`/new\` to reset the conversation.

**Vercel deployments:** install \`@vercel/functions\` so Poncho can keep the serverless function alive while processing: \`npm install @vercel/functions\`

## Messaging (Email via Resend)

Connect your agent to email so users can interact by sending emails:

1. Set up a domain and enable Inbound at [resend.com](https://resend.com)
2. Create a webhook for \`email.received\` pointing to \`https://<your-url>/api/messaging/resend\`
3. Install the Resend SDK: \`npm install resend\`
4. Set env vars:
   \`\`\`
   RESEND_API_KEY=re_...
   RESEND_WEBHOOK_SECRET=whsec_...
   RESEND_FROM=Agent <agent@yourdomain.com>
   RESEND_REPLY_TO=support@yourdomain.com   # optional
   \`\`\`
5. Add to \`poncho.config.js\`:
   \`\`\`javascript
   messaging: [{ platform: 'resend' }]
   \`\`\`

For full control over outbound emails, use **tool mode** (\`mode: 'tool'\`) — the agent gets a \`send_email\` tool instead of auto-replying. See the repo README for details.

**Vercel deployments:** install \`@vercel/functions\` so Poncho can keep the serverless function alive while processing: \`npm install @vercel/functions\`

## Subagents

Your agent can spawn **subagents** — independent background tasks that run in their own conversations. Subagents are useful for parallelizing work or isolating subtasks.

The agent gets four tools automatically: \`spawn_subagent\` (create and run a subagent), \`message_subagent\` (send follow-ups), \`stop_subagent\`, and \`list_subagents\`. Calls return immediately — subagents run in the background and their results are delivered to the parent automatically.

- **Limits**: subagents cannot spawn other subagents; max 5 concurrent per parent.
- **Memory**: subagents have read-only access to the parent's persistent memory.
- **Approvals**: subagent tool approvals are tunneled to the parent conversation thread.
- **Web UI**: subagent conversations appear nested under the parent in the sidebar.

## Deployment

\`\`\`bash
# Build for Vercel
poncho build vercel
vercel deploy --prod

# Build for Docker
poncho build docker
docker build -t \${name} .
docker run -p 3000:3000 -e ANTHROPIC_API_KEY=sk-ant-... \${name}

# AWS Lambda
poncho build lambda

# Fly.io
poncho build fly
fly deploy

# Railway
poncho build railway
railway up
\`\`\`

Set environment variables on your deployment platform:

\`\`\`bash
ANTHROPIC_API_KEY=sk-ant-...   # Required
# OR for OpenAI API key provider:
# OPENAI_API_KEY=sk-...
# OR for OpenAI Codex OAuth provider:
# OPENAI_CODEX_REFRESH_TOKEN=rt_...
# OPENAI_CODEX_ACCOUNT_ID=...   # Optional
PONCHO_AUTH_TOKEN=your-secret  # Optional: protect your endpoint
PONCHO_MAX_DURATION=55         # Optional: serverless timeout in seconds (enables auto-continuation)
PONCHO_INTERNAL_SECRET=...     # Recommended on serverless: shared secret for internal callback auth
\`\`\`

When \`PONCHO_MAX_DURATION\` is set, the agent automatically checkpoints and resumes across
request cycles when it approaches the platform timeout. The web UI and client SDK handle
this transparently.

For serverless deployments with subagents or background callbacks, use a shared state backend
(\`upstash\`, \`redis\`, or \`dynamodb\`) instead of \`state.provider: 'local'\` / \`'memory'\`.

## Troubleshooting

### Vercel deploy issues

- After upgrading \`@poncho-ai/cli\`, re-run \`poncho build vercel --force\` to refresh generated deploy files.
- If Vercel fails during \`pnpm install\` due to a lockfile mismatch, run \`pnpm install --no-frozen-lockfile\` locally and commit \`pnpm-lock.yaml\`.
- Deploy from the project root: \`vercel deploy --prod\`.
- For subagents/background callbacks, set \`PONCHO_INTERNAL_SECRET\` and use non-local state storage.

For full reference:
https://github.com/cesr/poncho-ai
`;

export const ENV_TEMPLATE = "ANTHROPIC_API_KEY=sk-ant-...\n";
export const GITIGNORE_TEMPLATE =
  ".env\nnode_modules\ndist\n.poncho/\ninteractive-session.json\n.vercel\n";
export const TEST_TEMPLATE = `tests:
  - name: "Basic sanity"
    task: "What is 2 + 2?"
    expect:
      contains: "4"
`;

export const SKILL_TEMPLATE = `---
name: starter-skill
description: Starter local skill template
allowed-tools:
  - ./scripts/starter-echo.ts
---

# Starter Skill

This is a starter local skill created by \`poncho init\`.

## Authoring Notes

- Put executable JavaScript/TypeScript files in \`scripts/\`.
- Ask the agent to call \`run_skill_script\` with \`skill\`, \`script\`, and optional \`input\`.
`;

export const SKILL_TOOL_TEMPLATE = `export default async function run(input) {
  const message = typeof input?.message === "string" ? input.message : "";
  return { echoed: message };
}
`;
