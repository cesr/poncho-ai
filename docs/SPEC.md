# Claude Agent Framework Specification

> A standalone, isolated agent framework based on Claude Code patterns for cloud deployment

**Version**: 0.1.0-draft
**Status**: RFC
**Authors**: Latitude Team
**Last Updated**: 2025-02-11

> Implementation note: the current runtime intentionally uses remote-only MCP servers (no local MCP server execution path), and currently supports Anthropic + OpenAI model providers.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Goals & Non-Goals](#2-goals--non-goals)
3. [Architecture Overview](#3-architecture-overview)
4. [Agent Definition](#4-agent-definition)
5. [Agent Harness](#5-agent-harness)
6. [Skills and Tools](#6-skills-and-tools)
7. [Execution Environment](#7-execution-environment)
8. [API Key Management](#8-api-key-management)
9. [The `agentl` CLI](#9-the-agentl-cli)
10. [Observability & Telemetry](#10-observability--telemetry)
11. [Security Considerations](#11-security-considerations)
12. [Deployed Agent HTTP API](#12-deployed-agent-http-api)
13. [Web UI Specification](#13-web-ui-specification)
14. [Open Questions](#14-open-questions)

---

## 1. Executive Summary

AgentL is an open agent framework inspired by Claude Code patterns. Develop locally, deploy anywhere.

**Core principles:**

- **Portable**: Build once, deploy to Vercel, AWS, Fly.io, or your own infra
- **Open**: Import skills from npm, GitHub, or local. Full MCP support for tools
- **Simple**: One `AGENT.md` file defines your agent. Mustache templating.
- **Swappable**: Default harness works great, or bring your own execution loop
- **Observable**: OpenTelemetry events go wherever you want (Latitude, Datadog, self-hosted)

**The workflow:**

```bash
agentl init my-agent          # Scaffold
agentl add @agentl/web-fetch  # Add skills
agentl dev                    # Develop locally
agentl build vercel           # Build for your platform
vercel deploy                 # Deploy wherever
```

**Not a platform** - AgentL is a framework and CLI. You own your agents, you choose where they run, you connect your own tools via MCP.

---

## 2. Goals & Non-Goals

### 2.1 Goals

| Priority | Goal |
|----------|------|
| P0 | Portable agents - deploy to any cloud platform |
| P0 | Full MCP support for connecting tools |
| P0 | Simple agent definition (AGENT.md + frontmatter) |
| P0 | Great local development experience |
| P1 | Open skill ecosystem (npm, GitHub, local) |
| P1 | Swappable harness for custom execution strategies |
| P1 | OpenTelemetry-based observability |
| P2 | Multiple build targets (Vercel, Docker, Lambda, Fly.io) |
| P2 | Optional Latitude integration for dashboard/management |

### 2.2 Non-Goals

- **Not a managed platform**: AgentL is a framework, not a hosting service
- **Not PromptL-compatible**: This is the next iteration, clean break
- **Not opinionated about hosting**: You deploy where you want
- **Not a single execution model**: Harness is swappable

---

## 3. Architecture Overview

### 3.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Your Agent                                     │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                        AGENT.md                                  │   │
│  │  • System prompt        • Model configuration                    │   │
│  │  • Guidelines           • Mustache templating                    │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                    │                                    │
│  ┌─────────────────────────────────┴───────────────────────────────┐   │
│  │                         Harness                                  │   │
│  │  • Turn-based loop      • Tool dispatch                          │   │
│  │  • Message management   • Event streaming                        │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                    │                                    │
│         ┌──────────────────────────┼──────────────────────────┐        │
│         ▼                          ▼                          ▼        │
│  ┌─────────────┐           ┌─────────────┐           ┌─────────────┐  │
│  │   Skills    │           │  MCP Tools  │           │  Model API  │  │
│  │ (npm/local) │           │ (any server)│           │ (Anthropic) │  │
│  └─────────────┘           └─────────────┘           └─────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                            agentl build
                                    │
         ┌──────────────────────────┼──────────────────────────┐
         ▼                          ▼                          ▼
  ┌─────────────┐           ┌─────────────┐           ┌─────────────┐
  │   Vercel    │           │   Docker    │           │  AWS Lambda │
  │  Function   │           │  Container  │           │   Function  │
  └─────────────┘           └─────────────┘           └─────────────┘
```

### 3.2 Core Components

| Component | Responsibility |
|-----------|----------------|
| **AGENT.md** | Agent definition - system prompt, model config |
| **Harness** | Execution loop, tool dispatch, message management |
| **Skills** | Packaged tools from npm/GitHub/local |
| **MCP Client** | Connects to MCP servers for tools |
| **Build System** | Produces deployable artifacts for each platform |

### 3.3 Execution Flow

```
Local Development:
1. agentl dev loads AGENT.md and skills
2. Harness initializes with MCP connections
3. HTTP server listens for requests
4. Each request runs the agent loop
5. Events stream to console (or OTEL endpoint)

Production:
1. agentl build produces platform-specific artifact
2. Deploy to your cloud (Vercel, etc.)
3. Platform handles HTTP routing
4. Same harness executes on each request
5. Events go to your observability stack
```

---

## 4. Agent Definition

An agent is defined by a single `AGENT.md` file with YAML frontmatter.

### 4.1 AGENT.md Structure

```markdown
---
name: code-assistant
description: A software development assistant
model:
  provider: anthropic
  name: claude-opus-4-5
  temperature: 0.7
---

# Code Assistant

You are a software development assistant. Help users understand, write, and debug code.

## Guidelines

- Always read existing code before making changes
- Test changes when possible
- Explain your reasoning clearly
- Ask for clarification when requirements are ambiguous

## Capabilities

You have access to tools for file operations, code execution, and web browsing.
Use them as needed to complete tasks.
```

### 4.2 Frontmatter Schema

The frontmatter contains only essential configuration:

```yaml
# Required
name: string              # Agent identifier

# Optional
description: string       # Human-readable description

model:                    # Model configuration
  provider: string        # anthropic, openai, etc.
  name: string            # claude-opus-4-5, gpt-4, etc.
  temperature: number     # 0.0 - 1.0
  maxTokens: number       # Max response tokens

limits:                   # Execution limits
  maxSteps: number        # Max turns (default: 50)
  timeout: number         # Max runtime in seconds (default: 300)
```

### 4.3 What's NOT in Frontmatter

Skills, tools, and parameters are **not** declared in frontmatter:

- **Skills**: Available at runtime from a registry. The agent uses what it needs.
- **Tools**: Come from skills. No static declaration.
- **Parameters**: Passed at runtime when invoking the agent.
- **API keys**: Managed separately (see [API Key Management](#8-api-key-management)).

### 4.4 Mustache Templating

The markdown body supports Mustache for dynamic content:

```markdown
---
name: code-assistant
---

# {{name}}

Working directory: {{runtime.workingDir}}
Environment: {{runtime.environment}}

{{#parameters.projectContext}}
## Project Context
{{parameters.projectContext}}
{{/parameters.projectContext}}
```

**Available context:**

| Variable | Description |
|----------|-------------|
| `name` | From frontmatter |
| `description` | From frontmatter |
| `runtime.workingDir` | Agent's working directory |
| `runtime.agentId` | Unique agent identifier |
| `runtime.runId` | Current run identifier |
| `runtime.environment` | development/staging/production |
| `parameters.*` | Runtime parameters passed by caller |

---

## 5. Agent Harness

The harness is the core execution engine that implements the agent loop pattern from Claude Code.

### 5.1 Harness Architecture

```typescript
interface AgentHarness {
  // Lifecycle
  initialize(config: AgentConfig): Promise<void>
  run(input: AgentInput): AsyncGenerator<AgentEvent>
  shutdown(): Promise<void>

  // State
  readonly state: HarnessState
  readonly messages: Message[]
  readonly context: ExecutionContext
}

interface HarnessState {
  status: 'idle' | 'running' | 'paused' | 'completed' | 'error'
  currentStep: number
  maxSteps: number
  toolsInFlight: string[]
  startTime: number
  lastActivity: number
}
```

### 5.2 Execution Loop

The harness implements a turn-based execution loop:

```
┌─────────────────────────────────────────────────────┐
│                  HARNESS LOOP                        │
│                                                      │
│  ┌──────────────────────────────────────────────┐  │
│  │              1. PREPARE TURN                  │  │
│  │  • Render system prompt with current state    │  │
│  │  • Apply skill prompts and tool definitions   │  │
│  │  • Inject context (files, environment)        │  │
│  └──────────────────────────────────────────────┘  │
│                       │                             │
│                       ▼                             │
│  ┌──────────────────────────────────────────────┐  │
│  │              2. CALL MODEL                    │  │
│  │  • Stream response from Claude                │  │
│  │  • Parse tool calls and content               │  │
│  │  • Emit streaming events                      │  │
│  └──────────────────────────────────────────────┘  │
│                       │                             │
│                       ▼                             │
│  ┌──────────────────────────────────────────────┐  │
│  │            3. EXECUTE TOOLS                   │  │
│  │  • Validate tool calls against schema         │  │
│  │  • Execute tools (parallel where safe)        │  │
│  │  • Collect results and errors                 │  │
│  └──────────────────────────────────────────────┘  │
│                       │                             │
│                       ▼                             │
│  ┌──────────────────────────────────────────────┐  │
│  │            4. CHECK COMPLETION                │  │
│  │  • Is task complete? (no tool calls)          │  │
│  │  • Max steps reached?                         │  │
│  │  • Error threshold exceeded?                  │  │
│  └──────────────────────────────────────────────┘  │
│                       │                             │
│           ┌───────────┴───────────┐                │
│           ▼                       ▼                │
│     [Continue Loop]         [Exit Loop]            │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### 5.3 Message Management

```typescript
interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentBlock[]
  toolCalls?: ToolCall[]
  toolResults?: ToolResult[]
  metadata: MessageMetadata
}

interface MessageMetadata {
  id: string
  timestamp: number
  tokenCount: number
  step: number
  cached?: boolean
}

// The harness maintains a sliding window of messages
// with automatic summarization when context limit approached
interface MessageWindow {
  messages: Message[]
  totalTokens: number
  maxTokens: number

  add(message: Message): void
  summarize(): Promise<void>  // Compresses history
  getContext(): Message[]     // Returns context window
}
```

### 5.4 Tool Dispatch

```typescript
interface ToolDispatcher {
  // Register tools from skills and config
  register(tool: ToolDefinition): void

  // Execute a tool call with timeout and isolation
  execute(call: ToolCall): Promise<ToolResult>

  // Parallel execution with dependency resolution
  executeBatch(calls: ToolCall[]): Promise<ToolResult[]>
}

interface ToolDefinition {
  name: string
  description: string
  inputSchema: JSONSchema
  outputSchema?: JSONSchema
  handler: ToolHandler

  // Execution constraints
  timeout?: number        // Max execution time (ms)
  retries?: number        // Retry count on failure
  isolated?: boolean      // Run in subprocess
  requiresApproval?: boolean  // Human-in-the-loop
}

type ToolHandler = (
  input: Record<string, unknown>,
  context: ToolContext
) => Promise<unknown>
```

### 5.5 Event Stream

All harness activity is emitted as typed events:

```typescript
type AgentEvent =
  // Run lifecycle
  | { type: 'run:started'; runId: string; agentId: string }
  | { type: 'run:completed'; runId: string; result: RunResult }
  | { type: 'run:error'; runId: string; error: AgentError }

  // Step lifecycle (each model call)
  | { type: 'step:started'; step: number }
  | { type: 'step:completed'; step: number; duration: number }

  // Model events
  | { type: 'model:request'; tokens: number }
  | { type: 'model:chunk'; content: string }
  | { type: 'model:response'; usage: TokenUsage }

  // Tool events
  | { type: 'tool:started'; tool: string; input: unknown }
  | { type: 'tool:completed'; tool: string; output: unknown; duration: number }
  | { type: 'tool:error'; tool: string; error: string; recoverable: boolean }

  // Approval events (for requiresApproval tools)
  | { type: 'tool:approval:required'; tool: string; input: unknown; approvalId: string }
  | { type: 'tool:approval:granted'; approvalId: string }
  | { type: 'tool:approval:denied'; approvalId: string; reason?: string }

interface RunResult {
  status: 'completed' | 'error' | 'cancelled'
  response?: string
  steps: number
  tokens: { input: number; output: number; cached: number }
  duration: number
}

interface AgentError {
  code: string
  message: string
  details?: Record<string, unknown>
}
```

---

## 6. Skills and Tools

Agents have access to tools from two sources: **Skills** and **MCP Servers**.

### 6.1 How Tools Work

```
┌─────────────────────────────────────────────────────────────┐
│                        Agent Harness                         │
│                                                              │
│  Available Tools = Skills + MCP Servers                      │
│                                                              │
│  ┌─────────────────────────┐  ┌─────────────────────────┐  │
│  │        Skills           │  │      MCP Servers        │  │
│  │  (bundled with agent)   │  │  (external services)    │  │
│  │                         │  │                         │  │
│  │  • @agentl/file-system  │  │  • GitHub MCP server    │  │
│  │  • @agentl/web-fetch    │  │  • Slack MCP server     │  │
│  │  • ./skills/my-skill    │  │  • Your custom MCP      │  │
│  └─────────────────────────┘  └─────────────────────────┘  │
│                                                              │
│  The model sees ALL tools and uses what it needs.            │
│  (Same pattern as Claude Code / OpenCode)                    │
└─────────────────────────────────────────────────────────────┘
```

**Skills**: Packages that bundle tools with the agent. They're installed via `agentl add` and included in the build output.

**MCP Servers**: External services that provide tools via the MCP protocol. Can be remote (hosted) or local (run by the agent).

### 6.2 Skill Structure

Each skill is a directory with a `SKILL.md` file and tools:

```
skills/
├── code-execution/
│   ├── SKILL.md             # Skill definition (frontmatter + prompt)
│   └── tools/
│       ├── run-code.ts
│       ├── read-file.ts
│       └── write-file.ts
│
├── web-browsing/
│   ├── SKILL.md
│   └── tools/
│       ├── fetch-url.ts
│       └── search-web.ts
│
└── git-operations/
    ├── SKILL.md
    └── tools/
        ├── git-status.ts
        ├── git-commit.ts
        └── git-diff.ts
```

### 6.2 SKILL.md Definition

```markdown
---
name: code-execution
version: 1.0.0
description: Execute code in isolated sandboxes

requires:
  - file-system

tools:
  - run-code
  - read-file
  - write-file

limits:
  memory: 512mb
  timeout: 60s
  network: restricted
---

# Code Execution

You have access to code execution tools that run in an isolated sandbox.

## Available Tools

- `run-code`: Execute code in JavaScript, TypeScript, or Python
- `read-file`: Read file contents from the workspace
- `write-file`: Write content to a file

## Guidelines

1. Always read existing code before making changes
2. Test code changes by running them
3. Handle errors gracefully
4. Never execute code that could harm the system
```

### 6.3 Tool Implementation

```typescript
// tools/run-code.ts
import { defineTool, ToolContext } from '@agentl/sdk'

export default defineTool({
  name: 'run-code',
  description: 'Execute code in an isolated sandbox',

  inputSchema: {
    type: 'object',
    properties: {
      language: {
        type: 'string',
        enum: ['javascript', 'typescript', 'python'],
        description: 'Programming language to execute'
      },
      code: {
        type: 'string',
        description: 'Code to execute'
      },
      timeout: {
        type: 'number',
        description: 'Execution timeout in milliseconds',
        default: 30000
      }
    },
    required: ['language', 'code']
  },

  outputSchema: {
    type: 'object',
    properties: {
      stdout: { type: 'string' },
      stderr: { type: 'string' },
      exitCode: { type: 'number' },
      duration: { type: 'number' }
    }
  },

  async handler(input, context: ToolContext) {
    const { language, code, timeout } = input
    const { sandbox, config } = context

    // Validate language is allowed
    if (!config.allowedLanguages.includes(language)) {
      throw new Error(`Language '${language}' is not allowed`)
    }

    // Execute in sandbox
    const result = await sandbox.execute({
      language,
      code,
      timeout: Math.min(timeout, config.maxExecutionTime)
    })

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      duration: result.duration
    }
  }
})
```

### 6.4 Skill Discovery

At startup, the harness:

1. Reads `package.json` dependencies
2. Scans each package for `SKILL.md`
3. Loads tools from packages with valid skill definitions
4. Also scans local `./skills/` directory

```
Loaded skills:
  @agentl/file-system (3 tools: read-file, write-file, glob)
  @agentl/web-fetch (2 tools: fetch-url, fetch-json)
  ./skills/my-skill (1 tool: my-tool)
```

### 6.5 Built-in Skills

Official skills (published to npm as `@agentl/*`):

| Package | Tools | Description |
|---------|-------|-------------|
| `@agentl/file-system` | read-file, write-file, glob, grep | File operations |
| `@agentl/code-execution` | run-code | Execute JS/TS/Python |
| `@agentl/web-fetch` | fetch-url, fetch-json | HTTP requests |
| `@agentl/web-search` | search | Web search |
| `@agentl/git` | git-status, git-diff, git-commit | Git operations |
| `@agentl/shell` | run-command | Shell commands (restricted) |

Install with:

```bash
agentl add @agentl/file-system @agentl/web-fetch
```

### 6.6 Skill Configuration

Configure skills in `agentl.config.js`:

```javascript
export default {
  skills: {
    '@agentl/web-fetch': {
      allowedDomains: ['*.github.com', 'api.example.com'],
      timeout: 10000,
      maxResponseSize: 1024 * 1024,  // 1MB
    },
    '@agentl/code-execution': {
      allowedLanguages: ['javascript', 'typescript'],
      maxExecutionTime: 30000,
      // Code runs on the deployment platform (Vercel/Lambda sandbox)
    },
    '@agentl/shell': {
      allowedCommands: ['ls', 'cat', 'grep', 'find'],
      // Disallowed by default: rm, mv, chmod, etc.
    },
  },
}
```

Skills read their config at initialization and enforce restrictions.

### 6.7 Custom Skills

Create custom skills in your project:

```
my-agent/
├── AGENT.md
├── package.json
└── skills/
    └── my-custom-skill/
        ├── SKILL.md
        └── tools/
            └── my-tool.ts
```

Or publish to npm for reuse across projects.

---

## 7. Execution Environment

Agents run wherever you deploy them. The execution environment depends on your deployment target.

### 7.1 Deployment Targets

| Target | Runtime | Code Execution | Limitations |
|--------|---------|----------------|-------------|
| **Vercel** | Node.js (Edge/Serverless) | Via Vercel's sandbox | 10s-300s timeout |
| **AWS Lambda** | Node.js | Via Lambda runtime | 15min timeout |
| **Docker** | Node.js | Full container access | You control limits |
| **Fly.io** | Node.js | Full VM access | You control limits |
| **Local** | Node.js | Direct execution | Development only |

### 7.2 Code Execution

When an agent needs to run code (e.g., `code-execution` skill), execution happens on the deployment platform:

```
┌─────────────────────────────────────────────────────────────┐
│                    Your Deployment Platform                  │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐│
│  │                    Agent Process                         ││
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     ││
│  │  │   Harness   │  │   Skills    │  │ MCP Clients │     ││
│  │  └─────────────┘  └─────────────┘  └─────────────┘     ││
│  │         │                │                │              ││
│  │         └────────────────┴────────────────┘              ││
│  │                          │                               ││
│  │                          ▼                               ││
│  │  ┌─────────────────────────────────────────────────────┐││
│  │  │              Platform Sandbox                        │││
│  │  │  • Vercel: Edge Runtime sandbox                      │││
│  │  │  • Lambda: Lambda execution environment              │││
│  │  │  • Docker: Container isolation                       │││
│  │  └─────────────────────────────────────────────────────┘││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

**Local development**: Code runs directly via Node.js child processes.

**Production**: Code runs in the platform's sandboxed environment. Security is handled by the platform (Vercel, AWS, etc.).

### 7.3 Resource Limits

Limits are set by your deployment platform, not AgentL:

```javascript
// agentl.config.js - platform-specific settings
export default {
  build: {
    vercel: {
      runtime: 'nodejs20.x',
      memory: 1024,           // MB
      maxDuration: 60,        // seconds
    },
    lambda: {
      memorySize: 1024,       // MB
      timeout: 300,           // seconds
    },
    docker: {
      // You control everything
    },
  },
}
```

### 7.4 File System Access

| Target | Filesystem | Persistence |
|--------|------------|-------------|
| Vercel | `/tmp` only, read-only source | None (stateless) |
| Lambda | `/tmp` (512MB), read-only source | None (stateless) |
| Docker | Full access | Depends on volumes |
| Fly.io | Full access | Depends on volumes |

For stateful agents, use external storage (S3, KV stores, databases).

### 7.5 State Management

Serverless platforms (Vercel, Lambda) are stateless. For multi-turn conversations:

**Option 1: Client manages state**

The client stores conversation history and sends it with each request:

```bash
POST /run
{
  "messages": [
    {"role": "user", "content": "Create a React component"},
    {"role": "assistant", "content": "I'll create..."},
    {"role": "user", "content": "Now add tests"}
  ]
}
```

**Option 2: External state store**

Configure a KV store for conversation persistence:

```javascript
// agentl.config.js
export default {
  state: {
    provider: 'redis',  // or 'upstash', 'dynamodb'
    url: process.env.REDIS_URL,
    ttl: 3600,  // Conversation expires after 1 hour
  },
}
```

Then use `runId` to continue:

```bash
POST /continue
{ "runId": "run_abc123", "message": "Now add tests" }
```

**Option 3: Long-running (Docker/Fly.io)**

On platforms with persistent processes, conversations stay in memory for the process lifetime.

---

## 8. API Key Management

Agents need API keys for model providers. Keys live in your environment, not in AgentL.

### 8.1 Key Flow

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│   Local .env     │     │  Your deploy     │     │  Agent reads     │
│   for dev        │     │  platform sets   │ ──▶ │  process.env     │
│                  │     │  env vars        │     │  at runtime      │
└──────────────────┘     └──────────────────┘     └──────────────────┘
```

### 8.2 Local Development

Create a `.env` file (gitignored):

```bash
# .env
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...  # Optional, if using OpenAI
```

```bash
agentl dev  # Loads .env automatically
```

### 8.3 Deployment

Set keys on your deployment platform:

```bash
# Vercel
vercel env add ANTHROPIC_API_KEY

# Fly.io
fly secrets set ANTHROPIC_API_KEY=sk-ant-...

# AWS Lambda
aws lambda update-function-configuration \
  --function-name my-agent \
  --environment "Variables={ANTHROPIC_API_KEY=sk-ant-...}"
```

### 8.4 Environment Variables

The agent reads these at runtime:

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes* | Claude API key |
| `OPENAI_API_KEY` | No | OpenAI API key (if using OpenAI models) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | For telemetry export |
| `LATITUDE_API_KEY` | No | For Latitude dashboard integration |

*Required if using Anthropic models (the default).

---

## 9. The `agentl` CLI

The `agentl` CLI is a local development and build tool. You develop locally, build a portable artifact, and deploy wherever you want.

### 9.1 Installation

```bash
npm install -g agentl
# or
brew install agentl
```

### 9.2 Commands

#### `agentl init`

Scaffold a new agent project:

```bash
agentl init my-agent
cd my-agent

# Creates:
# my-agent/
# ├── AGENT.md           # Agent definition
# ├── package.json       # Dependencies (skills)
# ├── agentl.config.js   # Configuration
# ├── .env.example       # Environment template
# └── .gitignore
```

Init modes:
- `agentl init <name>` uses light onboarding defaults.
- `agentl init <name> --yes` skips prompts with deterministic defaults.

**package.json:**

```json
{
  "name": "my-agent",
  "private": true,
  "type": "module",
  "dependencies": {
    "@agentl/harness": "^1.0.0",
    "@agentl/file-system": "^1.0.0"
  }
}
```

Skills are npm packages listed in `dependencies`. Run `npm install` after cloning.

#### `agentl dev`

Run the agent locally for development:

```bash
agentl dev

# Starts local server at http://localhost:3000
# Loads .env for API keys
```

Options:
- `--port <port>` - Server port (default: 3000)

#### `agentl run`

Execute the agent once with a task:

```bash
agentl run "Analyze the code in ./src"

# With parameters:
agentl run --param project=myapp "Fix the failing tests"

# With file context:
agentl run --file ./src/index.ts "Explain this code"

# Interactive REPL mode:
agentl run --interactive
```

On first interactive session (web UI or CLI interactive), the agent sends a one-time introduction describing available configurable features and how to request config changes in plain language.

Options:
- `--param key=value` - Pass parameters (can repeat)
- `--file <path>` - Include file contents in context
- `--interactive` - Multi-turn conversation mode
- `--json` - Output JSON instead of streaming text

#### `agentl test`

Run tests against your agent:

```bash
agentl test                    # Run all tests
agentl test tests/math.yaml    # Run specific test file
```

**Test file format** (`tests/example.yaml`):

```yaml
tests:
  - name: "Basic math"
    task: "What is 2 + 2?"
    expect:
      contains: "4"

  - name: "File reading"
    task: "Read the package.json and tell me the name"
    expect:
      contains: "my-agent"
      maxSteps: 3

  - name: "Should refuse harmful requests"
    task: "Delete all files on the system"
    expect:
      refusal: true
```

#### `agentl tools`

List all tools available to your agent:

```bash
agentl tools

# Output:
# Skills:
#   @agentl/file-system (3 tools: read-file, write-file, glob)
#   @agentl/web-fetch (2 tools: fetch-url, fetch-json)
#   ./skills/my-skill (1 tool: my-tool)
#
# MCP Servers:
#   @modelcontextprotocol/server-filesystem (3 tools)
```

#### `agentl add`

Add skills to your agent (modifies `package.json` and runs `npm install`):

```bash
agentl add @agentl/code-execution    # From npm registry
agentl add github:user/my-skill      # From GitHub
agentl add ./path/to/local/skill     # Link local skill
```

This is equivalent to `npm install` but validates the package is a valid AgentL skill.

```bash
# These are equivalent:
agentl add @agentl/web-fetch
npm install @agentl/web-fetch
```

**Skill discovery**: At startup, the harness scans `package.json` dependencies for packages containing a `SKILL.md` file and registers their tools.

#### `agentl build`

Build a deployable artifact for your target platform:

```bash
# Build for Vercel
agentl build vercel
# Output: .vercel/output ready to deploy

# Build for Docker
agentl build docker
# Output: Dockerfile + image

# Build for AWS Lambda
agentl build lambda
# Output: Lambda-compatible zip

# Build for Fly.io
agentl build fly
# Output: fly.toml + Dockerfile
```

The build output is self-contained - includes the harness, your AGENT.md, and all skills.

#### `agentl mcp`

Connect MCP servers (remote):

```bash
# Add a remote MCP server (connect via URL)
agentl mcp add --url wss://mcp.example.com/github --env GITHUB_TOKEN

# List connected servers
agentl mcp list

# Remove
agentl mcp remove filesystem
```

**Remote MCP servers**: The agent connects to an external MCP server via WebSocket. You host the server separately.

### 9.3 Project Structure

Minimal agent:
```
my-agent/
└── AGENT.md
```

Agent with skills and MCP:
```
my-agent/
├── AGENT.md
├── skills/
│   └── my-skill/
│       ├── SKILL.md
│       └── tools/
│           └── my-tool.ts
├── agentl.config.js    # Optional: custom harness, MCP servers
└── .env
```

### 9.4 Configuration File

Optional `agentl.config.js` for advanced configuration:

```javascript
export default {
  // Custom harness (default: @agentl/harness)
  harness: './my-custom-harness',

  // MCP servers
  mcp: [
    { package: '@mcp/server-filesystem', config: { paths: ['/workspace'] } },
    { url: 'wss://mcp.example.com/github', env: ['GITHUB_TOKEN'] },
  ],

  // Skill-specific configuration
  skills: {
    '@agentl/web-fetch': {
      allowedDomains: ['*.github.com', 'api.example.com'],
      timeout: 10000,
    },
    '@agentl/code-execution': {
      allowedLanguages: ['javascript', 'typescript', 'python'],
      maxExecutionTime: 30000,
    },
  },

  // Authentication (for deployed agents)
  auth: {
    required: true,                    // Require auth for all requests
    type: 'bearer',                    // 'bearer' | 'header' | 'custom'
    header: 'Authorization',           // Header name (for type: 'header')
    validate: async (token, req) => {  // Custom validation (optional)
      return token === process.env.AGENT_API_KEY
    },
  },

  // State persistence for multi-turn conversations
  state: {
    provider: 'local',  // 'local' | 'redis' | 'upstash' | 'dynamodb'
    url: process.env.REDIS_URL,
    ttl: 3600,           // Conversation TTL in seconds
  },

  // Telemetry
  telemetry: {
    enabled: true,
    otlp: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    // Or send to Latitude
    latitude: { apiKey: process.env.LATITUDE_API_KEY },
  },

  // Build targets
  build: {
    vercel: {
      runtime: 'nodejs20.x',
      memory: 1024,
      maxDuration: 60,
    },
    docker: {
      baseImage: 'node:20-slim',
    },
    lambda: {
      memorySize: 1024,
      timeout: 300,
    },
  },
}
```

### 9.5 Configuration Schema

Full TypeScript interface for configuration:

```typescript
interface AgentLConfig {
  harness?: string  // Package name or path

  mcp?: Array<
    | { package: string; config?: Record<string, unknown> }
    | { url: string; env?: string[] }
  >

  skills?: Record<string, Record<string, unknown>>

  auth?: {
    required?: boolean
    type?: 'bearer' | 'header' | 'custom'
    header?: string
    validate?: (token: string, req: Request) => Promise<boolean> | boolean
  }

  state?: {
    provider: 'local' | 'redis' | 'upstash' | 'dynamodb'
    url?: string
    token?: string
    ttl?: number
  }

  telemetry?: {
    enabled?: boolean
    otlp?: string
    latitude?: { apiKey: string }
    handler?: (event: AgentEvent) => Promise<void>
  }

  build?: {
    vercel?: { runtime?: string; memory?: number; maxDuration?: number }
    docker?: { baseImage?: string }
    lambda?: { memorySize?: number; timeout?: number }
    fly?: { /* ... */ }
  }
}
```

### 9.6 Harness Hooks

The harness emits lifecycle hooks for customization:

```typescript
import { BaseHarness } from '@agentl/harness'

export class MyHarness extends BaseHarness {
  // Called when a run starts
  async onRunStart(context: RunContext): Promise<void> {
    console.log(`Starting run ${context.runId}`)
  }

  // Called before each step (model call)
  async onStepStart(context: StepContext): Promise<void> {
    console.log(`Step ${context.step} starting`)
  }

  // Called after each step completes
  async onStepEnd(context: StepContext, result: StepResult): Promise<void> {
    console.log(`Step ${context.step} completed in ${result.duration}ms`)
  }

  // Called before a tool executes
  async onToolStart(tool: string, input: unknown): Promise<unknown> {
    console.log(`Tool ${tool} called`)
    return input  // Can modify input
  }

  // Called after a tool completes
  async onToolEnd(tool: string, output: unknown, error?: Error): Promise<unknown> {
    if (error) console.error(`Tool ${tool} failed:`, error)
    return output  // Can modify output
  }

  // Called when a run completes
  async onRunEnd(context: RunContext, result: RunResult): Promise<void> {
    console.log(`Run completed: ${result.status}`)
  }

  // Called on any error
  async onError(error: Error, context: RunContext): Promise<void> {
    await reportToErrorTracking(error)
  }
}
```

### 9.7 Error Handling

Errors are emitted as events and can be handled via hooks:

```typescript
type AgentError =
  | { code: 'MAX_STEPS_EXCEEDED'; steps: number }
  | { code: 'TIMEOUT'; duration: number }
  | { code: 'TOOL_ERROR'; tool: string; message: string }
  | { code: 'MODEL_ERROR'; message: string; status?: number }
  | { code: 'AUTH_ERROR'; message: string }
  | { code: 'CONFIG_ERROR'; message: string }
```

**Tool errors don't crash the agent** - they're reported back to the model which can retry or try a different approach.

**Fatal errors** (timeout, max steps, model API errors) end the run and emit a `run:error` event:

```typescript
// SSE event
event: run:error
data: {"code": "TIMEOUT", "duration": 60000, "message": "Run exceeded timeout"}
```

### 9.8 Harness Swapping

The harness is the agent runtime loop. The default is `@agentl/harness`, but you can:

1. **Use the default**: Works out of the box
2. **Extend it**: Subclass for custom behavior
3. **Replace it entirely**: Implement the harness interface

```typescript
// agentl.config.js
export default {
  harness: './my-harness.js'  // or '@my-org/custom-harness'
}
```

This lets you experiment with different execution strategies while keeping the same AGENT.md.

---

## 10. Observability & Telemetry

Agents emit OpenTelemetry-compatible events. You choose where to send them.

### 10.1 Event Types

```
┌─────────────────────────────────────────────────────────────┐
│                    Agent Execution                           │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐│
│  │ Run Started                                              ││
│  │ • agent_id, run_id                                       ││
│  │ • parameters                                             ││
│  └─────────────────────────────────────────────────────────┘│
│                          │                                   │
│                          ▼                                   │
│  ┌─────────────────────────────────────────────────────────┐│
│  │ Step Events (per turn)                                   ││
│  │ • model request (tokens, latency)                        ││
│  │ • tool calls (name, duration, success/error)             ││
│  │ • assistant response                                     ││
│  └─────────────────────────────────────────────────────────┘│
│                          │                                   │
│                          ▼                                   │
│  ┌─────────────────────────────────────────────────────────┐│
│  │ Run Completed                                            ││
│  │ • total duration, tokens, step count                     ││
│  │ • success/error status                                   ││
│  └─────────────────────────────────────────────────────────┘│
│                                                              │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
            ┌─────────────────────────────┐
            │   Your observability stack   │
            │  • Latitude (optional)       │
            │  • Datadog, Honeycomb, etc   │
            │  • Self-hosted OTEL          │
            └─────────────────────────────┘
```

### 10.2 Configuration

Set your telemetry destination via environment or config:

```bash
# Send to your OTEL collector
OTEL_EXPORTER_OTLP_ENDPOINT=https://otel.mycompany.com

# Or send to Latitude for their dashboard
LATITUDE_API_KEY=lat_xxx
LATITUDE_TELEMETRY=true
```

Or in `agentl.config.js`:

```javascript
export default {
  telemetry: {
    // Option 1: OTEL endpoint
    otlp: 'https://otel.mycompany.com',

    // Option 2: Latitude
    latitude: {
      apiKey: process.env.LATITUDE_API_KEY,
    },

    // Option 3: Custom handler
    handler: async (event) => {
      await myCustomLogger(event)
    },
  },
}
```

### 10.3 Latitude Integration (Optional)

If you want Latitude's dashboard for observability:

1. Create a Latitude account
2. Get an API key
3. Set `LATITUDE_API_KEY` and `LATITUDE_TELEMETRY=true`

You get:
- Run history with filtering
- Step-by-step execution traces
- Tool call inspection
- Error debugging
- Cost tracking

### 10.4 Local Development

During `agentl dev`, telemetry is logged to console by default:

```bash
agentl dev
# [run:abc123] Started
# [run:abc123] Step 1: model request (1500 input tokens)
# [run:abc123] Step 1: tool call "read-file" (45ms)
# [run:abc123] Completed (3 steps, 2340 tokens)
```

By default, dev telemetry events are logged to console output.

---

## 11. Security Considerations

Security is a shared responsibility between AgentL and your deployment platform.

### 11.1 What AgentL Handles

| Concern | How AgentL Helps |
|---------|------------------|
| **API key exposure** | Keys in env vars, never in code or logs |
| **Prompt injection** | Harness sanitizes tool outputs before feeding back |
| **Tool abuse** | Tools can require approval (`requiresApproval: true`) |
| **Runaway execution** | Configurable `maxSteps` and `timeout` limits |
| **Audit trail** | All tool calls logged via telemetry events |

### 11.2 What Your Platform Handles

| Concern | Platform Responsibility |
|---------|------------------------|
| **Process isolation** | Vercel/Lambda/Docker sandboxing |
| **Network security** | Platform firewall, VPC settings |
| **Resource limits** | Memory, CPU, timeout configured per platform |
| **DDoS protection** | Platform-level rate limiting |
| **Secrets management** | Platform env var encryption |

### 11.3 Best Practices

**API Authentication**

Always protect your deployed agent:

```javascript
// agentl.config.js
export default {
  auth: {
    required: true,
    // Checks Authorization: Bearer <token>
    validateToken: async (token) => {
      return token === process.env.AGENT_API_KEY
    },
  },
}
```

**Tool Approval**

For sensitive tools, require human approval:

```typescript
defineTool({
  name: 'delete-file',
  requiresApproval: true,  // Pauses execution, emits approval event
  // ...
})
```

**Limit External Access**

Be explicit about what your agent can access:

```javascript
// agentl.config.js
export default {
  skills: {
    'web-fetch': {
      allowedDomains: ['api.github.com', '*.example.com'],
    },
  },
}
```

### 11.4 Telemetry for Auditing

All tool executions are logged via telemetry:

```typescript
// Emitted for every tool call
{
  type: 'tool:call:completed',
  tool: 'read-file',
  input: { path: '/workspace/secrets.txt' },  // Can be redacted
  output: '...',  // Can be redacted
  duration: 45,
  timestamp: '2024-01-15T10:30:00Z'
}
```

Send to your SIEM or logging platform for audit trails.

---

## 12. Deployed Agent HTTP API

When you deploy an agent, it exposes a simple HTTP API. The URL depends on your deployment platform.

### 12.1 Endpoints

```
POST /run          - Execute the agent (streaming)
POST /run/sync     - Execute the agent (wait for completion)
POST /continue     - Continue a conversation
GET  /health       - Health check
```

### 12.2 Run Agent (Streaming)

```bash
POST https://my-agent.vercel.app/run
Content-Type: application/json

{
  "task": "Analyze the code in ./src and find bugs",
  "parameters": {
    "projectPath": "/workspace/myapp"
  }
}
```

Response: Server-Sent Events (SSE)

```
event: run:started
data: {"runId": "run_abc123"}

event: step:started
data: {"step": 1}

event: model:chunk
data: {"content": "I'll analyze the code..."}

event: tool:started
data: {"tool": "read-file", "input": {"path": "src/index.ts"}}

event: tool:completed
data: {"tool": "read-file", "output": "..."}

event: run:completed
data: {"runId": "run_abc123", "result": {...}}
```

### 12.3 Run Agent (Sync)

```bash
POST https://my-agent.vercel.app/run/sync
Content-Type: application/json

{
  "task": "What is 2 + 2?"
}
```

Response:

```json
{
  "runId": "run_abc123",
  "status": "completed",
  "result": {
    "response": "2 + 2 equals 4.",
    "steps": 1,
    "tokens": { "input": 150, "output": 12 }
  }
}
```

### 12.4 Continue Conversation

For multi-turn conversations, pass the `runId`:

```bash
POST https://my-agent.vercel.app/continue
Content-Type: application/json

{
  "runId": "run_abc123",
  "message": "Now multiply that by 10"
}
```

### 12.5 TypeScript SDK

```typescript
import { AgentClient } from '@agentl/client'

const agent = new AgentClient({
  url: 'https://my-agent.vercel.app'
})

// Simple run
const result = await agent.run({
  task: 'Analyze the code in /src'
})

// Streaming
for await (const event of agent.stream({
  task: 'Build a REST API'
})) {
  console.log(event.type, event)
}

// Multi-turn conversation
const conversation = agent.conversation()
await conversation.send('Create a React component')
await conversation.send('Add unit tests for it')
const result = await conversation.end()
```

### 12.6 Authentication

By default, agents are open. Add authentication via environment variables:

```bash
# .env
AGENT_API_KEY=your-secret-key
```

Then require the key in requests:

```bash
POST https://my-agent.vercel.app/run
Authorization: Bearer your-secret-key
```

---

## 13. Web UI Specification

A dedicated Web UI specification is maintained in:

- [`docs/SPEC_WEB_UI.md`](./SPEC_WEB_UI.md)

This document defines a ChatGPT-like interface (conversation sidebar + streaming chat pane) for local and deployed usage, including:

- UX and interaction model
- runtime endpoint integration (`/run`, `/continue`, `/health`)
- conversation/session data model
- default hardened passphrase security profile for browser access
- phased rollout plan and acceptance criteria

The Web UI auth/session model is additive and does not replace direct API auth for existing clients.

---

## 14. Open Questions

### 14.1 Decisions Made

| Question | Decision |
|----------|----------|
| **Pricing** | Open source framework. You pay your cloud provider. |
| **Skills** | Open ecosystem - npm, GitHub, local |
| **PromptL interop** | None - clean break |
| **MCP support** | Remote MCP support (WebSocket servers) |
| **Deployment model** | `agentl build` → deploy anywhere |
| **Code execution** | Runs on deployment platform (Vercel sandbox, Lambda, etc.) |

### 14.2 Technical Decisions Needed

| Question | Options | Notes |
|----------|---------|-------|
| **State store interface** | Redis, Upstash, Vercel KV, DynamoDB | Which to support first? |
| **Skill versioning** | Lock file? package.json? | How to pin skill versions |
| **Remote MCP session lifecycle** | Reconnect/backoff/heartbeat policies | Reliability vs complexity |

### 14.3 Check Latitude Repo for Reusable Code

Before implementation, evaluate these components from `latitude-llm` for potential reuse:

| Component | Location to Check | Why |
|-----------|-------------------|-----|
| **YAML/frontmatter parsing** | PromptL compiler | Battle-tested parsing, edge cases handled |
| **Telemetry/tracing patterns** | SDK or platform code | For Latitude integration (`LATITUDE_API_KEY`) |
| **Error types and handling** | Core packages | Consistent error patterns across ecosystem |
| **MCP client implementation** | If exists | Avoid reimplementing MCP protocol |
| **Zod schemas / validation** | API or SDK | Type-safe config validation patterns |

**Explicitly NOT reusing:**
- PromptL compiler/syntax (clean break, using Mustache)
- Chain execution model (we use turn-based harness)
- Platform deployment code (we build artifacts, user deploys)
- Billing/auth/team management (platform concerns)

### 14.4 Product Decisions Needed

| Question | Options | Notes |
|----------|---------|-------|
| **Skill discovery** | npm search, awesome list, Latitude hub | How do people find skills? |
| **Agent templates** | Code assistant, support bot, etc. | Starter templates for common use cases |
| **Documentation** | Standalone site or Latitude docs | Where does AgentL docs live? |

### 14.5 Latitude Platform Integration

When using Latitude (optional), you get additional features:

| Feature | Description |
|---------|-------------|
| **`agentl sync`** | Sync agent to Latitude for managed deployment |
| **Dashboard** | Run history, traces, cost tracking |
| **Evaluations** | Run evals against your agent |
| **Team sharing** | Collaborate on agents |
| **Hosted MCP** | Latitude-hosted MCP servers |

Open questions:
- Should Latitude offer managed agent hosting (with Firecracker isolation)?
- Should Latitude host a public skill/agent registry?

---

## Appendix A: Comparison with PromptL

| Aspect | PromptL | AgentL |
|--------|---------|--------|
| **Philosophy** | Platform-integrated | Open, portable |
| **Template** | Jinja2 + YAML | Mustache + frontmatter |
| **Tools** | Inline definitions | MCP + skill packages |
| **Execution** | Chain steps | Turn-based harness |
| **Deployment** | Latitude-managed | Build artifact, deploy anywhere |
| **Telemetry** | Latitude required | OTEL, your choice |
| **Skills** | Built into platform | npm/GitHub packages |

## Appendix B: Implementation Phases

```
Phase 1: Core Framework
├── AGENT.md parser (frontmatter + Mustache)
├── Default harness implementation
├── MCP client integration
└── agentl init / dev / run commands

Phase 2: Build System
├── agentl build vercel
├── agentl build docker
├── agentl build lambda
└── Build artifact bundling

Phase 3: Skill Ecosystem
├── agentl add command
├── Skill package format spec
├── Built-in skills (@agentl/*)
└── Skill authoring docs

Phase 4: Observability
├── OTEL event emission
├── Latitude integration (optional)
├── Local dev logging
└── agentl logs command (for local)
```

## Appendix C: References

- [Claude Code](https://docs.anthropic.com/claude-code) - Inspiration for patterns
- [AGENTS.md Convention](https://github.com/anthropics/claude-code) - Agent definition patterns
- [MCP Specification](https://modelcontextprotocol.io) - Tool protocol
- [OpenTelemetry](https://opentelemetry.io) - Telemetry standard
- [Vercel Build Output API](https://vercel.com/docs/build-output-api/v3) - Build target
