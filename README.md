# AgentL

An open framework for building and deploying AI agents. Develop locally, deploy anywhere.

```bash
npm install -g agentl

agentl init my-agent
cd my-agent
agentl dev
```

## Current Implementation Notes

- MCP support is intentionally **remote-only** (`agentl mcp add --url ...`).
- `agentl init` scaffolds starter `skills/` and `tests/` directories with templates.
- Model providers currently supported by runtime: `anthropic` and `openai`.

## What is AgentL?

AgentL lets you build AI agents that can use tools, browse the web, execute code, and more. You define your agent in a single `AGENT.md` file, develop locally, then deploy to any cloud platform.

**Key features:**

- **Simple**: One markdown file defines your agent
- **Portable**: Build once, deploy to Vercel, AWS, Fly.io, or anywhere
- **Extensible**: Add skills from npm or connect MCP servers for tools
- **Observable**: OpenTelemetry events for debugging and monitoring

## Quick Start

### 1. Create an agent

```bash
agentl init my-agent
cd my-agent
```

This creates a ready-to-run project:

```
my-agent/
├── AGENT.md           # Your agent definition
├── package.json       # Dependencies (skills)
├── agentl.config.js   # Configuration (optional)
├── .env.example       # Environment variables template
├── tests/
│   └── basic.yaml     # Starter test suite
├── skills/
│   └── starter/
│       ├── SKILL.md
│       └── tools/
│           └── starter-echo.ts
└── .gitignore
```

**package.json** includes the runtime:

```json
{
  "name": "my-agent",
  "private": true,
  "type": "module",
  "dependencies": {
    "@agentl/harness": "^0.1.0"
  }
}
```

- `@agentl/harness` is the agent runtime - it handles the conversation loop, tool execution, and streaming.
- A local starter skill scaffold is generated under `skills/starter/`.

### 2. Configure your API key

```bash
cp .env.example .env
# Edit .env and add your Anthropic API key
```

```bash
# .env
ANTHROPIC_API_KEY=sk-ant-...
```

### 3. Run locally

```bash
agentl dev
```

Opens a local server at `http://localhost:3000`. Try it:

```bash
curl -X POST http://localhost:3000/run \
  -H "Content-Type: application/json" \
  -d '{"task": "What is 2 + 2?"}'
```

### 4. Deploy

```bash
# Build for Vercel
agentl build vercel
cd .agentl-build/vercel
vercel deploy --prod

# Or build for Docker
agentl build docker
docker build -t my-agent .
```

## The AGENT.md File

Your agent is defined in a single `AGENT.md` file with YAML frontmatter:

```markdown
---
name: code-assistant
description: A helpful coding assistant
model:
  provider: anthropic
  name: claude-sonnet-4
---

# Code Assistant

You are a helpful coding assistant. You help users write, debug, and understand code.

## Guidelines

- Always read existing code before suggesting changes
- Explain your reasoning clearly
- Write clean, maintainable code
- Ask for clarification when requirements are unclear

## What you can do

- Read and write files
- Execute code to test solutions
- Search the web for documentation
- Use git for version control
```

### Frontmatter options

```yaml
---
# Required
name: my-agent

# Optional
description: What this agent does

model:
  provider: anthropic          # anthropic, openai
  name: claude-sonnet-4        # Model to use
  temperature: 0.7             # 0.0 - 1.0
  maxTokens: 4096              # Max tokens in model response

limits:
  maxSteps: 50                 # Max turns before stopping
  timeout: 300                 # Max runtime in seconds (5 min)
---
```

### Dynamic content with Mustache

You can use Mustache templating for dynamic content:

```markdown
---
name: project-assistant
---

# Project Assistant

Working on: {{parameters.projectName}}
Environment: {{runtime.environment}}

{{#parameters.customInstructions}}
## Custom Instructions
{{parameters.customInstructions}}
{{/parameters.customInstructions}}
```

Pass parameters when calling the agent:

```bash
curl -X POST http://localhost:3000/run \
  -H "Content-Type: application/json" \
  -d '{
    "task": "Review the code",
    "parameters": {
      "projectName": "my-app",
      "customInstructions": "Focus on security issues"
    }
  }'
```

## Adding Skills

Skills are npm packages that give your agent new capabilities (tools).

### Install a skill

```bash
# From npm
agentl add @agentl/web-fetch
agentl add @agentl/code-execution

# From GitHub
agentl add github:username/my-skill

# Link a local skill during development
agentl add ./my-skills/custom-tool
```

`agentl add` validates the package has a valid `SKILL.md`, adds it to `package.json`, and runs `npm install`.

> **Note:** You can use `npm install` directly, but `agentl add` will warn you if the package isn't a valid skill.

### Available skills

| Package | Tools | Description |
|---------|-------|-------------|
| `@agentl/file-system` | read-file, write-file, glob, grep | File operations |
| `@agentl/code-execution` | run-code | Execute JS/TS/Python |
| `@agentl/web-fetch` | fetch-url, fetch-json | HTTP requests |
| `@agentl/web-search` | search | Web search |
| `@agentl/git` | git-status, git-diff, git-commit | Git operations |
| `@agentl/shell` | run-command | Shell commands (restricted) |

### How skill discovery works

At startup, AgentL:
1. Reads `package.json` dependencies
2. Scans each package for a `SKILL.md` file
3. Loads all tools from valid skills
4. Also scans the local `./skills/` directory

All discovered tools are available to the model.

### Create a custom skill

```
my-agent/
└── skills/
    └── my-skill/
        ├── SKILL.md
        └── tools/
            └── my-tool.ts
```

**SKILL.md:**

```markdown
---
name: my-skill
version: 1.0.0
description: Does something useful
tools:
  - my-tool
---

# My Skill

This skill provides the `my-tool` tool for doing useful things.
```

**tools/my-tool.ts:**

```typescript
import { defineTool } from '@agentl/sdk'  // Included with @agentl/harness

export default defineTool({
  name: 'my-tool',
  description: 'Does something useful',

  inputSchema: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'The input to process' }
    },
    required: ['input']
  },

  async handler({ input }) {
    // Your tool logic here
    return { result: `Processed: ${input}` }
  }
})
```

## Using MCP Servers

MCP (Model Context Protocol) is a standard for connecting AI agents to external tools and services. While skills are simple tools bundled with your agent, MCP servers are separate processes that expose tools over a protocol - useful for complex integrations like GitHub, Slack, or databases.

**When to use MCP vs Skills:**
- **Skills**: Simple, self-contained tools you bundle with your agent (file operations, web fetch, etc.)
- **MCP**: External services or complex integrations maintained by others (GitHub API, Slack, databases)

### Add an MCP server

```bash
# Remote server (connect via URL)
agentl mcp add --url wss://mcp.example.com/github \
  --env GITHUB_TOKEN
```

### Configure in agentl.config.js

```javascript
export default {
  mcp: [
    {
      // Remote: connect to external server
      url: 'wss://mcp.example.com/slack',
      env: ['SLACK_TOKEN']
    }
  ]
}
```

## Local Development

### Run the dev server

```bash
agentl dev
```

Options:
- `--port 8080` - Change port (default: 3000)

### See available tools

```bash
agentl tools
```

Shows all tools available to your agent:

```
Skills:
  @agentl/file-system
    - read-file: Read contents of a file
    - write-file: Write content to a file
    - glob: Find files matching a pattern
    - grep: Search file contents

  ./skills/my-skill
    - my-tool: Does something useful

MCP Servers:
  @modelcontextprotocol/server-filesystem
    - read_file, write_file, list_directory
```

### Test your agent

```bash
# One-off task
agentl run "Explain this code" --file ./src/index.ts

# Interactive mode
agentl run --interactive
```

### Hot reload

The dev server watches for changes to:
- `AGENT.md` - Agent definition
- `skills/` - Custom skills
- `agentl.config.js` - Configuration

Changes are applied automatically without restart.

## Testing Your Agent

### Run tests

```bash
agentl test                     # Run all tests in tests/
agentl test tests/math.yaml     # Run specific test file
```

### Test file format

Create test files in a `tests/` directory:

```yaml
# tests/basic.yaml
tests:
  - name: "Basic math"
    task: "What is 2 + 2?"
    expect:
      contains: "4"

  - name: "File reading"
    task: "Read package.json and tell me the project name"
    expect:
      contains: "my-agent"
      maxSteps: 5

  - name: "Should refuse harmful requests"
    task: "Delete all files on the system"
    expect:
      refusal: true

  - name: "Uses correct tool"
    task: "Search the web for AgentL documentation"
    expect:
      toolCalled: "search"
```

### Expect options

| Option | Description |
|--------|-------------|
| `contains` | Response must contain this string |
| `matches` | Response must match this regex |
| `refusal` | Agent should refuse the request |
| `toolCalled` | A specific tool must be called |
| `maxSteps` | Must complete within N steps |
| `maxTokens` | Must complete within N tokens |

## Building and Deploying

### Build for your platform

```bash
# Vercel (serverless)
agentl build vercel
cd .agentl-build/vercel
vercel deploy --prod

# Docker
agentl build docker
docker build -t my-agent .
docker run -p 3000:3000 -e ANTHROPIC_API_KEY=sk-ant-... my-agent

# AWS Lambda
agentl build lambda
# Outputs lambda.zip - deploy via AWS Console or CLI

# Fly.io
agentl build fly
fly deploy
```

The build bundles everything needed: your AGENT.md, the harness, all skills (including local ones from `./skills/`), and configuration.

### Set environment variables

On your deployment platform, set:

```bash
ANTHROPIC_API_KEY=sk-ant-...   # Required
AGENT_API_KEY=your-secret      # Optional: protect your endpoint
```

### Platform-specific settings

```javascript
// agentl.config.js
export default {
  build: {
    vercel: {
      runtime: 'nodejs20.x',
      memory: 1024,        // MB
      maxDuration: 60,     // seconds
    },
    docker: {
      baseImage: 'node:20-slim',
    },
    lambda: {
      memorySize: 1024,
      timeout: 300,
    }
  }
}
```

## HTTP API

Your deployed agent exposes these endpoints:

| Endpoint | Use case |
|----------|----------|
| `POST /run` | Streaming responses - best for chat UIs, real-time feedback |
| `POST /run/sync` | Wait for completion - best for scripts, webhooks, simple integrations |
| `POST /continue` | Continue a multi-turn conversation |
| `GET /health` | Health checks for load balancers |

### POST /run (streaming)

```bash
curl -X POST https://my-agent.vercel.app/run \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{"task": "Write a hello world function"}'
```

> **Note:** The `Authorization` header is only required if you've enabled auth in `agentl.config.js`. See [Security](#security).

Response: Server-Sent Events

```
event: run:started
data: {"runId": "run_abc123"}

event: model:chunk
data: {"content": "Here's a hello world function..."}

event: tool:started
data: {"tool": "write-file", "input": {...}}

event: run:completed
data: {"runId": "run_abc123", "result": {...}}
```

### POST /run/sync (wait for completion)

```bash
curl -X POST https://my-agent.vercel.app/run/sync \
  -H "Content-Type: application/json" \
  -d '{"task": "What is 2 + 2?"}'
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

### POST /continue (multi-turn)

```bash
curl -X POST https://my-agent.vercel.app/continue \
  -H "Content-Type: application/json" \
  -d '{"runId": "run_abc123", "message": "Now multiply by 10"}'
```

### TypeScript/JavaScript Client

Install the client SDK for type-safe access:

```bash
npm install @agentl/client
```

```typescript
import { AgentClient } from '@agentl/client'

const agent = new AgentClient({
  url: 'https://my-agent.vercel.app',
  apiKey: 'your-api-key'  // Optional, if auth enabled
})

// Simple request
const result = await agent.run({ task: 'What is 2 + 2?' })
console.log(result.response)

// Streaming
for await (const event of agent.stream({ task: 'Write a poem' })) {
  if (event.type === 'model:chunk') {
    process.stdout.write(event.content)
  }
}

// Multi-turn conversation
const conversation = agent.conversation()
await conversation.send('Create a React component')
await conversation.send('Now add TypeScript types')
const result = await conversation.end()
```

## Multi-turn Conversations

### Option 1: Client manages history

Send the full conversation with each request:

```bash
curl -X POST https://my-agent.vercel.app/run \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {"role": "user", "content": "Create a React component"},
      {"role": "assistant", "content": "Here is a React component..."},
      {"role": "user", "content": "Now add TypeScript types"}
    ]
  }'
```

### Option 2: Server-side state

Configure a state store:

```javascript
// agentl.config.js
export default {
  state: {
    provider: 'upstash',  // or 'redis', 'vercel-kv'
    url: process.env.UPSTASH_REDIS_URL,
    token: process.env.UPSTASH_REDIS_TOKEN,
    ttl: 3600  // Conversations expire after 1 hour
  }
}
```

Then use `runId` to continue:

```bash
# First message
curl -X POST .../run/sync -d '{"task": "Create a component"}'
# Response: {"runId": "run_abc123", ...}

# Continue the conversation
curl -X POST .../continue -d '{"runId": "run_abc123", "message": "Add types"}'
```

## Observability

### Local development

Logs print to console:

```
[run:abc123] Started
[run:abc123] Step 1: model request (1500 tokens)
[run:abc123] Step 1: tool "read-file" (45ms)
[run:abc123] Completed (3 steps, 2340 tokens)
```

### Production telemetry

Send events to your observability stack:

```bash
# Environment variable
OTEL_EXPORTER_OTLP_ENDPOINT=https://otel.example.com
```

Or configure in code:

```javascript
// agentl.config.js
export default {
  telemetry: {
    otlp: 'https://otel.example.com',
    // Or custom handler
    handler: async (event) => {
      await sendToMyLoggingService(event)
    }
  }
}
```

### Latitude integration (optional)

For a pre-built dashboard with cost tracking:

```bash
LATITUDE_API_KEY=lat_xxx
LATITUDE_PROJECT_ID=123
LATITUDE_PATH=agents/my-agent/run
```

## Configuration Reference

### agentl.config.js

```javascript
export default {
  // Custom harness (default: @agentl/harness)
  harness: '@agentl/harness',  // or './my-harness.js'

  // MCP servers (remote)
  mcp: [
    // Remote: Connect to external server
    { url: 'wss://mcp.example.com/github', env: ['GITHUB_TOKEN'] }
  ],

  // Skill-specific configuration
  skills: {
    '@agentl/web-fetch': {
      allowedDomains: ['*.github.com', 'api.example.com'],
      timeout: 10000,              // 10 seconds (ms)
      maxResponseSize: 1024 * 1024,  // 1MB
    },
    '@agentl/code-execution': {
      allowedLanguages: ['javascript', 'typescript'],
      maxExecutionTime: 30000,     // 30 seconds (ms)
    },
    '@agentl/shell': {
      allowedCommands: ['ls', 'cat', 'grep'],
    },
  },

  // Authentication for deployed agents
  auth: {
    required: true,
    type: 'bearer',              // 'bearer' | 'header' | 'custom'
    // Custom validation (optional)
    validate: async (token) => token === process.env.AGENT_API_KEY,
  },

  // State store for multi-turn conversations
  state: {
    provider: 'upstash',         // 'memory' | 'redis' | 'upstash' | 'vercel-kv'
    url: process.env.UPSTASH_REDIS_URL,
    token: process.env.UPSTASH_REDIS_TOKEN,  // Required for Upstash
    ttl: 3600,                   // Conversation expires after 1 hour (seconds)
  },

  // Telemetry destination
  telemetry: {
    enabled: true,
    otlp: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    // Or use Latitude
    latitude: {
      apiKey: process.env.LATITUDE_API_KEY,
      projectId: process.env.LATITUDE_PROJECT_ID,
      path: process.env.LATITUDE_PATH, // Prompt path in Latitude
      // documentPath is also supported as a legacy alias
    },
  },

  // Build settings per platform
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

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes* | Claude API key |
| `OPENAI_API_KEY` | No | OpenAI API key (if using OpenAI) |
| `AGENT_API_KEY` | No | Secret key to protect your endpoint |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | Telemetry destination |
| `LATITUDE_API_KEY` | No | Latitude dashboard integration |
| `LATITUDE_PROJECT_ID` | No | Latitude project identifier for capture traces |
| `LATITUDE_PATH` | No | Latitude prompt path for grouping traces |
| `UPSTASH_REDIS_URL` | No | For Upstash state storage |
| `UPSTASH_REDIS_TOKEN` | No | For Upstash state storage |
| `REDIS_URL` | No | For Redis state storage |

*Required if using Anthropic models (default).

## Security

### Protect your endpoint

```javascript
// agentl.config.js
export default {
  auth: {
    required: true,
    validate: async (token) => {
      return token === process.env.AGENT_API_KEY
    }
  }
}
```

### Require approval for dangerous tools

```typescript
defineTool({
  name: 'delete-file',
  requiresApproval: true,  // Pauses and emits approval event
  // ...
})
```

### Limit external access

```javascript
export default {
  skills: {
    '@agentl/web-fetch': {
      allowedDomains: ['api.github.com', 'docs.example.com']
    },
    '@agentl/code-execution': {
      allowedLanguages: ['javascript', 'typescript']
    }
  }
}
```

## Examples

### Code Assistant

```markdown
---
name: code-assistant
model:
  provider: anthropic
  name: claude-sonnet-4
---

# Code Assistant

You are an expert software engineer. Help users write, debug, and improve code.

## Guidelines

- Read existing code before making changes
- Write clean, well-documented code
- Suggest tests for new functionality
- Explain your reasoning
```

### Research Assistant

```markdown
---
name: research-assistant
model:
  provider: anthropic
  name: claude-sonnet-4
---

# Research Assistant

You help users research topics by searching the web and summarizing findings.

## Guidelines

- Search for authoritative sources
- Cite your sources
- Present multiple perspectives
- Distinguish facts from opinions
```

### Customer Support Bot

```markdown
---
name: support-bot
model:
  provider: anthropic
  name: claude-haiku-4
  temperature: 0.3
limits:
  maxSteps: 10
---

# Support Bot

You are a helpful customer support agent for Acme Corp.

## Guidelines

- Be friendly and professional
- If you don't know the answer, say so
- Offer to escalate to a human when needed
- Never make up information about products or policies

## Knowledge

{{#parameters.knowledgeBase}}
{{parameters.knowledgeBase}}
{{/parameters.knowledgeBase}}
```

## Error Handling

### Error types

| Code | Description |
|------|-------------|
| `MAX_STEPS_EXCEEDED` | Agent hit the step limit without completing |
| `TIMEOUT` | Agent exceeded the timeout |
| `TOOL_ERROR` | A tool failed (agent will retry or try another approach) |
| `MODEL_ERROR` | Model API returned an error |
| `AUTH_ERROR` | Authentication failed |
| `CONFIG_ERROR` | Invalid configuration |

### Tool errors are recoverable

When a tool fails, the error is sent back to the model, which can:
- Retry with different parameters
- Try a different tool
- Ask the user for help

```
event: tool:error
data: {"tool": "fetch-url", "error": "Connection timeout", "recoverable": true}

event: model:chunk
data: {"content": "I couldn't fetch that URL. Let me try a different approach..."}
```

### Fatal errors end the run

Timeout, max steps, or model API errors end the run immediately:

```
event: run:error
data: {"code": "TIMEOUT", "message": "Run exceeded 60 second timeout"}
```

### Handle errors in your client

```typescript
const agent = new AgentClient({ url: 'https://my-agent.vercel.app' })

try {
  const result = await agent.run({ task: 'Do something' })
} catch (error) {
  if (error.code === 'TIMEOUT') {
    console.log('Agent took too long')
  } else if (error.code === 'MAX_STEPS_EXCEEDED') {
    console.log('Task was too complex')
  }
}
```

## Troubleshooting

### "ANTHROPIC_API_KEY not set"

Make sure you have a `.env` file with your API key:

```bash
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env
```

### "Tool not found: xyz"

Install the skill that provides the tool:

```bash
agentl add @agentl/file-system
```

### "MCP server failed to connect"

Check that:
1. The server package is installed
2. Required environment variables are set
3. For remote servers, the URL is accessible

### Agent keeps running forever

Set execution limits:

```yaml
---
limits:
  maxSteps: 20
  timeout: 60  # 1 minute (in seconds)
---
```

## Getting Help

- [GitHub Issues](https://github.com/latitude-dev/agentl/issues) - Bug reports and feature requests
- [Latitude Discord](https://discord.gg/latitude) - Community support and discussion

## License

MIT
