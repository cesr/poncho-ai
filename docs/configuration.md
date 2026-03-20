# Configuration & Security

> Back to [README](../README.md)

## Credential Pattern

All credentials in `poncho.config.js` use **env var name** fields (`*Env` suffix). The config specifies *which* environment variable to read — never the secret value itself. Every `*Env` field has a sensible default, so you only need to set the field when your env var name differs from the convention:

| Config field | Default env var | Purpose |
|---|---|---|
| `providers.anthropic.apiKeyEnv` | `ANTHROPIC_API_KEY` | Anthropic model API key |
| `providers.openai.apiKeyEnv` | `OPENAI_API_KEY` | OpenAI model API key |
| `providers.openaiCodex.refreshTokenEnv` | `OPENAI_CODEX_REFRESH_TOKEN` | OpenAI Codex OAuth refresh token |
| `providers.openaiCodex.accountIdEnv` | `OPENAI_CODEX_ACCOUNT_ID` | OpenAI Codex account/org routing header (optional) |
| `providers.openaiCodex.accessTokenEnv` | `OPENAI_CODEX_ACCESS_TOKEN` | OpenAI Codex OAuth access token seed (optional) |
| `providers.openaiCodex.accessTokenExpiresAtEnv` | `OPENAI_CODEX_ACCESS_TOKEN_EXPIRES_AT` | Access token epoch expiry in ms (optional) |
| `providers.openaiCodex.authFilePathEnv` | `OPENAI_CODEX_AUTH_FILE` | Overrides local auth file path used by `poncho auth` |
| `auth.tokenEnv` | `PONCHO_AUTH_TOKEN` | Auth passphrase / bearer token |
| `storage.urlEnv` | `UPSTASH_REDIS_REST_URL` / `REDIS_URL` | Storage connection URL |
| `storage.tokenEnv` | `UPSTASH_REDIS_REST_TOKEN` | Upstash REST token |
| `telemetry.latitude.apiKeyEnv` | `LATITUDE_API_KEY` | Latitude API key |
| `telemetry.latitude.projectIdEnv` | `LATITUDE_PROJECT_ID` | Latitude project ID |
| `messaging[].botTokenEnv` | `SLACK_BOT_TOKEN` | Slack bot token |
| `messaging[].signingSecretEnv` | `SLACK_SIGNING_SECRET` | Slack signing secret |
| `messaging[].botTokenEnv` | `TELEGRAM_BOT_TOKEN` | Telegram bot token |
| `messaging[].webhookSecretEnv` | `TELEGRAM_WEBHOOK_SECRET` | Telegram webhook secret (optional) |
| `messaging[].apiKeyEnv` | `RESEND_API_KEY` | Resend API key |
| `messaging[].webhookSecretEnv` | `RESEND_WEBHOOK_SECRET` | Resend webhook signing secret |
| `messaging[].fromEnv` | `RESEND_FROM` | Resend sender address |
| `messaging[].replyToEnv` | `RESEND_REPLY_TO` | Resend reply-to address (optional) |
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

  // Tool access: true (available), false (disabled), 'approval' (requires human approval)
  // Any tool name works — harness tools, adapter tools (send_email), MCP tools, etc.
  tools: {
    list_directory: true,          // available (default)
    read_file: true,               // available (default)
    write_file: true,              // gated by environment for writes
    delete_file: 'approval',       // requires human approval
    delete_directory: 'approval',  // requires human approval
    send_email: 'approval',        // requires human approval
    byEnvironment: {
      production: {
        write_file: false,         // disable writes in production
        delete_file: false,        // disable deletes in production
        delete_directory: false,   // disable deletes in production
        send_email: 'approval',    // keep approval in production
      },
      development: {
        send_email: true,          // skip approval in dev
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
    // openaiCodex: {
    //   refreshTokenEnv: 'OPENAI_CODEX_REFRESH_TOKEN',
    //   accountIdEnv: 'OPENAI_CODEX_ACCOUNT_ID', // optional
    // },
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

  // Telemetry destination — generic OTLP and/or Latitude
  telemetry: {
    enabled: true,
    // Generic OTLP: string shorthand or { url, headers? } object
    otlp: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    // With auth headers (Honeycomb, Grafana Cloud, etc.):
    // otlp: {
    //   url: 'https://api.honeycomb.io/v1/traces',
    //   headers: { 'x-honeycomb-team': process.env.HONEYCOMB_API_KEY },
    // },
    // Latitude (reads from LATITUDE_API_KEY and LATITUDE_PROJECT_ID env vars by default)
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
    { platform: 'telegram' },                              // Uses TELEGRAM_BOT_TOKEN (+ optional TELEGRAM_WEBHOOK_SECRET)
    // { platform: 'telegram', botTokenEnv: 'MY_TG_TOKEN' }, // Custom env var names
    { platform: 'resend' },                                // Uses RESEND_API_KEY + RESEND_WEBHOOK_SECRET + RESEND_FROM
    // { platform: 'resend', mode: 'tool', replyToEnv: 'RESEND_REPLY_TO' }, // Tool mode with custom reply-to
  ],

  // File upload storage (default: local filesystem)
  uploads: {
    provider: 'local',           // 'local' | 'vercel-blob' | 's3'
    // access: 'public',         // vercel-blob access mode
    // bucket: 'my-uploads',     // S3 bucket name
    // region: 'us-east-1',      // S3 region
    // endpoint: '...',          // S3-compatible endpoint
  },

  // Browser automation (requires @poncho-ai/browser)
  // browser: true,
  // browser: {
  //   viewport: { width: 1280, height: 720 },
  //   quality: 80,
  //   everyNthFrame: 2,
  //   headless: true,
  //   profileDir: '~/.poncho/browser-profiles',
  //   executablePath: '/path/to/chromium',
  //   stealth: true,           // Anti-bot-detection (default: true)
  //   userAgent: 'custom UA',  // Override the default stealth user-agent
  //   provider: 'browserbase', // Cloud browser: 'browserbase' | 'browseruse' | 'kernel'
  //   cdpUrl: 'wss://...',     // Or connect via CDP URL (alternative to provider)
  // },

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
| `OPENAI_CODEX_REFRESH_TOKEN` | No | OpenAI Codex OAuth refresh token (if using `model.provider: openai-codex`) |
| `OPENAI_CODEX_ACCOUNT_ID` | No | OpenAI Codex account/org id for request routing (optional) |
| `OPENAI_CODEX_ACCESS_TOKEN` | No | Optional pre-seeded short-lived access token |
| `OPENAI_CODEX_ACCESS_TOKEN_EXPIRES_AT` | No | Epoch millis expiry for `OPENAI_CODEX_ACCESS_TOKEN` |
| `OPENAI_CODEX_AUTH_FILE` | No | Local auth store override for `poncho auth` commands |
| `PONCHO_AUTH_TOKEN` | No | Unified auth token (Web UI passphrase + API Bearer token) |
| `PONCHO_INTERNAL_SECRET` | No | Shared secret used by internal serverless callbacks (recommended for Vercel/Lambda) |
| `PONCHO_SELF_BASE_URL` | No | Explicit base URL for internal self-callbacks when auto-detection is unavailable |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | OTLP trace endpoint (Jaeger, Tempo, Honeycomb, etc.) |
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
| `TELEGRAM_BOT_TOKEN` | No | Telegram Bot Token (from @BotFather) |
| `TELEGRAM_WEBHOOK_SECRET` | No | Telegram webhook secret token (optional) |
| `RESEND_API_KEY` | No | Resend API key (for email messaging) |
| `RESEND_WEBHOOK_SECRET` | No | Resend webhook signing secret |
| `RESEND_FROM` | No | Sender address for email replies |
| `RESEND_REPLY_TO` | No | Reply-to address for outgoing emails (optional) |
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

### Production telemetry (generic OTLP)

Send full OpenTelemetry traces (agent runs, LLM calls, tool executions) to any
OTLP-compatible collector — Jaeger, Grafana Tempo, Honeycomb, Datadog, etc.

```bash
# Simple: just a URL
OTEL_EXPORTER_OTLP_ENDPOINT=https://otel.example.com/v1/traces
```

```javascript
// poncho.config.js — string shorthand
export default {
  telemetry: {
    otlp: 'https://otel.example.com/v1/traces',
  }
}
```

```javascript
// poncho.config.js — with auth headers (Honeycomb, Grafana Cloud, etc.)
export default {
  telemetry: {
    otlp: {
      url: 'https://api.honeycomb.io/v1/traces',
      headers: {
        'x-honeycomb-team': process.env.HONEYCOMB_API_KEY,
      },
    },
  }
}
```

You can also use a custom event handler for non-OTLP destinations:

```javascript
// poncho.config.js
export default {
  telemetry: {
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

Both `otlp` and `latitude` can be configured simultaneously — all spans flow to both destinations.

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
