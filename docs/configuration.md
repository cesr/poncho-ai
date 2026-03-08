# Configuration & Security

> Back to [README](../README.md)

## Credential Pattern

All credentials in `poncho.config.js` use **env var name** fields (`*Env` suffix). The config specifies *which* environment variable to read — never the secret value itself. Every `*Env` field has a sensible default, so you only need to set the field when your env var name differs from the convention:

| Config field | Default env var | Purpose |
|---|---|---|
| `providers.anthropic.apiKeyEnv` | `ANTHROPIC_API_KEY` | Anthropic model API key |
| `providers.openai.apiKeyEnv` | `OPENAI_API_KEY` | OpenAI model API key |
| `auth.tokenEnv` | `PONCHO_AUTH_TOKEN` | Auth passphrase / bearer token |
| `storage.urlEnv` | `UPSTASH_REDIS_REST_URL` / `REDIS_URL` | Storage connection URL |
| `storage.tokenEnv` | `UPSTASH_REDIS_REST_TOKEN` | Upstash REST token |
| `telemetry.latitude.apiKeyEnv` | `LATITUDE_API_KEY` | Latitude API key |
| `telemetry.latitude.projectIdEnv` | `LATITUDE_PROJECT_ID` | Latitude project ID |
| `messaging[].botTokenEnv` | `SLACK_BOT_TOKEN` | Slack bot token |
| `messaging[].signingSecretEnv` | `SLACK_SIGNING_SECRET` | Slack signing secret |
| `messaging[].apiKeyEnv` | `RESEND_API_KEY` | Resend API key |
| `messaging[].webhookSecretEnv` | `RESEND_WEBHOOK_SECRET` | Resend webhook signing secret |
| `messaging[].fromEnv` | `RESEND_FROM` | Resend sender address |
| `mcp[].auth.tokenEnv` | *(user-defined)* | MCP server bearer token |

## Config File Reference (`poncho.config.js`)

```javascript
export default {
  // Custom harness (default: @poncho-ai/harness)
  harness: '@poncho-ai/harness',  // or './my-harness.js'

  // MCP servers (remote)
  mcp: [
    // Remote: Connect to external server
    {
      name: 'github',
      url: 'https://mcp.example.com/github',
      auth: { type: 'bearer', tokenEnv: 'GITHUB_TOKEN' },
    }
  ],

  // Extra directories to scan for skills (skills/ is always scanned)
  skillPaths: ['.cursor/skills'],

  // Skill-specific configuration
  skills: {
    '@poncho-ai/web-fetch': {
      allowedDomains: ['*.github.com', 'api.example.com'],
      timeout: 10000,              // 10 seconds (ms)
      maxResponseSize: 1024 * 1024,  // 1MB
    },
    '@poncho-ai/code-execution': {
      allowedLanguages: ['javascript', 'typescript'],
      maxExecutionTime: 30000,     // 30 seconds (ms)
    },
    '@poncho-ai/shell': {
      allowedCommands: ['ls', 'cat', 'grep'],
    },
  },

  // Tool access: true (available), false (disabled), 'approval' (requires human approval)
  // Any tool name works — harness tools, adapter tools (send_email), MCP tools, etc.
  tools: {
    write_file: true,            // available (still gated by environment for writes)
    send_email: 'approval',      // available, requires human approval before each call
    list_directory: true,
    byEnvironment: {
      production: {
        write_file: false,       // disable writes in production
        send_email: 'approval',  // keep approval in production
      },
      development: {
        send_email: true,        // skip approval in dev
      },
    },
  },

  // Authentication (protects both Web UI and API)
  auth: {
    required: true,
    type: 'bearer',              // 'bearer' | 'header' | 'custom'
    // tokenEnv: 'PONCHO_AUTH_TOKEN',  // env var name (default)
  },
  // When auth.required is true:
  // - Web UI: users enter the passphrase (value of PONCHO_AUTH_TOKEN env var)
  // - API: clients include Authorization: Bearer <token> header

  // Model provider API key env var overrides (optional)
  providers: {
    // anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' },  // default
    // openai: { apiKeyEnv: 'OPENAI_API_KEY' },        // default
  },

  // Unified storage (preferred). Replaces separate `state` and `memory` blocks.
  // Credentials are read from env vars; override the var name with *Env fields.
  storage: {
    provider: 'upstash',         // 'local' | 'memory' | 'redis' | 'upstash' | 'dynamodb'
    // urlEnv: 'UPSTASH_REDIS_REST_URL',     // default (falls back to KV_REST_API_URL)
    // tokenEnv: 'UPSTASH_REDIS_REST_TOKEN', // default (falls back to KV_REST_API_TOKEN)
    ttl: {
      conversations: 3600,       // seconds
      memory: 0,                 // 0/undefined means no expiration
    },
    memory: {
      enabled: true,
      maxRecallConversations: 20, // Bounds conversation_recall scan size
    },
  },

  // Telemetry destination
  telemetry: {
    enabled: true,
    otlp: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    // Or use Latitude (reads from LATITUDE_API_KEY and LATITUDE_PROJECT_ID env vars by default)
    latitude: {
      // apiKeyEnv: 'LATITUDE_API_KEY',       // default
      // projectIdEnv: 'LATITUDE_PROJECT_ID', // default
      path: 'your/prompt-path',               // optional, defaults to agent name
    },
  },

  // Messaging platform integrations
  messaging: [
    { platform: 'slack' },                                 // Uses SLACK_BOT_TOKEN + SLACK_SIGNING_SECRET
    // { platform: 'slack', botTokenEnv: 'MY_BOT_TOKEN' }, // Custom env var names
  ],

  // File upload storage (default: local filesystem)
  uploads: {
    provider: 'local',           // 'local' | 'vercel-blob' | 's3'
    // access: 'public',         // vercel-blob access mode
    // bucket: 'my-uploads',     // S3 bucket name
    // region: 'us-east-1',      // S3 region
    // endpoint: '...',          // S3-compatible endpoint
  },

  // Headless mode: disable the built-in Web UI (API-only)
  // webUi: false,

}
```

`provider: 'local'` stores runtime state under `~/.poncho/store` (or `/tmp/.poncho/store` on serverless runtimes), scoped by both agent name and stable agent id:

```text
~/.poncho/store
└── my-agent--agent_01f4f5d7e9c7432da51f8c6b9e2b1a0c
    ├── memory.json
    ├── state.json
    ├── onboarding-state.json
    └── conversations
        ├── index.json
        ├── 20260217T154233Z--conv_01j9x8a12bcd.json
        └── 20260218T101004Z--conv_01j9x8b45efg.json
```

Remote storage keys are namespaced and versioned, for example `poncho:v1:<agentId>:...`.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes* | Claude API key |
| `OPENAI_API_KEY` | No | OpenAI API key (if using OpenAI) |
| `PONCHO_AUTH_TOKEN` | No | Unified auth token (Web UI passphrase + API Bearer token) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | Telemetry destination |
| `LATITUDE_API_KEY` | No | Latitude dashboard integration |
| `LATITUDE_PROJECT_ID` | No | Latitude project identifier for capture traces |
| `LATITUDE_PATH` | No | Latitude prompt path for grouping traces |
| `KV_REST_API_URL` | No | Upstash REST URL (Vercel Marketplace naming) |
| `KV_REST_API_TOKEN` | No | Upstash REST write token (Vercel Marketplace naming) |
| `UPSTASH_REDIS_REST_URL` | No | Upstash REST URL (direct Upstash naming) |
| `UPSTASH_REDIS_REST_TOKEN` | No | Upstash REST write token (direct Upstash naming) |
| `REDIS_URL` | No | For Redis state storage |
| `SLACK_BOT_TOKEN` | No | Slack Bot Token (for messaging integration) |
| `SLACK_SIGNING_SECRET` | No | Slack Signing Secret (for messaging integration) |
| `RESEND_API_KEY` | No | Resend API key (for email messaging) |
| `RESEND_WEBHOOK_SECRET` | No | Resend webhook signing secret |
| `RESEND_FROM` | No | Sender address for email replies |
| `BLOB_READ_WRITE_TOKEN` | No | Vercel Blob token (for `uploads.provider: 'vercel-blob'`) |
| `PONCHO_UPLOADS_BUCKET` | No | S3 bucket name (for `uploads.provider: 's3'`) |

*Required if using Anthropic models (default).

## Observability

### Local development

Logs print to console:

```
[event] run:started {"type":"run:started","runId":"run_abc123","agentId":"my-agent"}
[event] tool:started {"type":"tool:started","tool":"read_file","input":{"path":"README.md"}}
[event] tool:completed {"type":"tool:completed","tool":"read_file","duration":45,"output":{"path":"README.md","content":"..."}}
[event] run:completed {"type":"run:completed","runId":"run_abc123","result":{"status":"completed","response":"...","steps":3,"tokens":{"input":1500,"output":840}}}
```

### Production telemetry

Send events to your observability stack:

```bash
# Environment variable
OTEL_EXPORTER_OTLP_ENDPOINT=https://otel.example.com
```

Or configure in code:

```javascript
// poncho.config.js
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

Send traces to [Latitude](https://latitude.so) for a dashboard with cost tracking and prompt management:

```bash
LATITUDE_API_KEY=lat_xxx
LATITUDE_PROJECT_ID=123
LATITUDE_PATH=agents/my-agent/run
```

Or configure via `poncho.config.js`:

```javascript
telemetry: {
  latitude: {
    // apiKeyEnv: 'LATITUDE_API_KEY',       // default
    // projectIdEnv: 'LATITUDE_PROJECT_ID', // default
    path: 'your/prompt-path',
  },
}
```

## Security

### Protect your endpoint

Enable authentication to secure both the Web UI and API:

```javascript
// poncho.config.js
export default {
  auth: {
    required: true,
    type: 'bearer'  // Default: validates against PONCHO_AUTH_TOKEN
  }
}
```

```bash
# .env
PONCHO_AUTH_TOKEN=your-secret-token-here
```

With `auth.required: true`:
- **Web UI**: Users must enter `PONCHO_AUTH_TOKEN` as the passphrase to login
- **API**: Clients must include `Authorization: Bearer <PONCHO_AUTH_TOKEN>` header

For custom validation:

```javascript
// poncho.config.js
export default {
  auth: {
    required: true,
    type: 'custom',
    validate: async (token) => {
      // Custom logic: check database, verify JWT, etc.
      return token === process.env.PONCHO_AUTH_TOKEN
    }
  }
}
```

### Require approval for dangerous tools

Use `approval-required` in your `AGENT.md` or `SKILL.md` frontmatter to gate specific tools:

```yaml
---
allowed-tools:
  - mcp:linear/*
approval-required:
  - mcp:linear/list_initiatives
---
```

When a gated tool is called, the harness emits a `tool:approval:required` event and pauses until approval is granted or denied. In the web UI and interactive CLI, the user is prompted before execution continues.
