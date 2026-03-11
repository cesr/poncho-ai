# Platform Features

> Back to [README](../README.md)

## Web UI

The built-in web UI at `http://localhost:3000` provides a full-featured chat interface:

- **Conversation sidebar**: create, switch between, rename, and delete conversations. Each conversation has a persistent URL (`/c/:conversationId`).
- **Streaming responses**: assistant text and tool activity stream in real time with structured sections (text blocks, tool call groups).
- **Context window progress**: a circular ring around the send button shows how much of the model's context window is used. The ring updates as the model responds and as tool results come in, with warning (70%) and critical (90%) color thresholds. Context usage is persisted per conversation so the ring stays accurate when switching between conversations.
- **File attachments**: attach images, PDFs, text files, and more via the attach button, drag-and-drop, or clipboard paste. Supported types include images, video, PDF, CSV, JSON, HTML, and plain text (up to 25 MB each).
- **Image lightbox**: click any image in the chat to view it full-size.
- **Tool approval**: when a tool requires approval, the UI shows an inline Approve/Deny prompt.
- **Stop streaming**: click the send button while a response is streaming to cancel the current run.
- **Installable PWA**: the web UI includes a manifest and service worker, so it can be installed as a standalone app on desktop and mobile.

Disable the built-in UI for API-only deployments by setting `webUi: false` in `poncho.config.js`.

## Messaging Integrations

Connect your Poncho agent to messaging platforms so it responds to @mentions.

### Slack

#### 1. Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app "From scratch"
2. Under **OAuth & Permissions**, add these Bot Token Scopes:
   - `app_mentions:read`
   - `chat:write`
   - `reactions:write`
3. Under **Event Subscriptions**, enable events:
   - Set the Request URL to `https://<your-deployed-agent>/api/messaging/slack`
   - Subscribe to the `app_mention` bot event
4. Install the app to your workspace (generates a Bot Token `xoxb-...`)
5. Copy the **Signing Secret** from the Basic Information page

#### 2. Configure your agent

Add environment variables to `.env`:

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
```

Add messaging to `poncho.config.js`:

```javascript
export default {
  // ... your existing config ...
  messaging: [
    { platform: 'slack' }
  ]
}
```

#### 3. Deploy

The messaging endpoint works on all deployment targets (Vercel, Docker, Fly.io, etc.). For local development with Slack, use a tunnel like [ngrok](https://ngrok.com) to expose your local server.

**Vercel deployments:** install `@vercel/functions` so Poncho can keep the serverless function alive while the agent processes messages:

```bash
npm install @vercel/functions
```

This is detected automatically at runtime -- no extra configuration needed.

#### How it works

- When a user @mentions your bot in Slack, the agent receives the message and responds in the same thread.
- Each Slack thread maps to a separate Poncho conversation with persistent history.
- The bot adds an "eyes" reaction while processing and removes it when done.
- Long responses are automatically split into multiple messages.

#### Custom environment variable names

If you need different env var names (e.g., running multiple Slack integrations):

```javascript
messaging: [
  {
    platform: 'slack',
    botTokenEnv: 'MY_SLACK_BOT_TOKEN',
    signingSecretEnv: 'MY_SLACK_SIGNING_SECRET',
  }
]
```

### Telegram

#### 1. Create a Telegram Bot

1. Open [Telegram](https://telegram.org) and start a chat with [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts to create your bot
3. Copy the **Bot Token** (looks like `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`)

> **Privacy mode** is enabled by default, which means the bot only receives messages that @mention it in groups. This is the desired behavior -- no changes needed.

#### 2. Configure your agent

Add environment variables to `.env`:

```
TELEGRAM_BOT_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
TELEGRAM_WEBHOOK_SECRET=my-secret-token
```

The webhook secret is optional but recommended. It can be any string up to 256 characters (`A-Z`, `a-z`, `0-9`, `_`, `-`).

Add messaging to `poncho.config.js`:

```javascript
export default {
  // ... your existing config ...
  messaging: [
    { platform: 'telegram' }
  ]
}
```

#### 3. Set up the webhook

After deploying your agent, register the webhook URL with Telegram:

```bash
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://<your-deployed-agent>/api/messaging/telegram", "secret_token": "<YOUR_WEBHOOK_SECRET>"}'
```

Omit the `secret_token` field if you're not using a webhook secret.

For local development, use a tunnel like [ngrok](https://ngrok.com) to expose your local server, then register the tunnel URL as the webhook.

#### 4. Deploy

The messaging endpoint works on all deployment targets (Vercel, Docker, Fly.io, etc.).

**Vercel deployments:** install `@vercel/functions` so Poncho can keep the serverless function alive while the agent processes messages:

```bash
npm install @vercel/functions
```

#### How it works

- **Private chats**: the bot responds to all messages.
- **Groups**: the bot only responds when @mentioned (e.g., `@mybot what's the weather?`). The mention is stripped before the message reaches the agent.
- **Forum topics**: each topic in a supergroup is treated as a separate conversation.
- The bot shows a "typing..." indicator while processing.
- Long responses are automatically split into multiple messages (4096 char limit).
- **Photos and documents** sent to the bot are forwarded to the agent as file attachments.
- Use `/new` to reset the conversation and start fresh. In groups, use `/new@botusername`.

#### Restricting access

By default any Telegram user can message your bot. To restrict it to specific users, add their numeric Telegram user IDs:

```javascript
messaging: [
  {
    platform: 'telegram',
    allowedUserIds: [1056240469, 9876543210],
  }
]
```

Messages from anyone not on the list are silently ignored. You can find your user ID by messaging [@userinfobot](https://t.me/userinfobot) on Telegram.

#### Custom environment variable names

If you need different env var names (e.g., running multiple Telegram integrations):

```javascript
messaging: [
  {
    platform: 'telegram',
    botTokenEnv: 'MY_TELEGRAM_BOT_TOKEN',
    webhookSecretEnv: 'MY_TELEGRAM_WEBHOOK_SECRET',
  }
]
```

### Email (Resend)

#### 1. Set up Resend

1. Create an account at [resend.com](https://resend.com) and add your domain
2. Enable **Inbound** on your domain in the Resend dashboard
3. Create a **Webhook** subscribing to the `email.received` event
   - Set the endpoint URL to `https://<your-deployed-agent>/api/messaging/resend`
4. Copy the webhook **Signing Secret** from the webhook details page
5. Create an API key at [resend.com/api-keys](https://resend.com/api-keys)

#### 2. Configure your agent

Add environment variables to `.env`:

```
RESEND_API_KEY=re_...
RESEND_WEBHOOK_SECRET=whsec_...
RESEND_FROM=Agent <agent@yourdomain.com>
RESEND_REPLY_TO=support@yourdomain.com   # optional
```

Add messaging to `poncho.config.js`:

```javascript
export default {
  // ... your existing config ...
  messaging: [
    { platform: 'resend' }
  ]
}
```

Install the Resend SDK:

```bash
npm install resend
```

#### 3. Deploy

The messaging endpoint works on all deployment targets (Vercel, Docker, Fly.io, etc.). For local development, use a tunnel like [ngrok](https://ngrok.com) to expose your local server and set it as your Resend webhook URL.

**Vercel deployments:** install `@vercel/functions` so Poncho can keep the serverless function alive while the agent processes messages:

```bash
npm install @vercel/functions
```

#### How it works

- When someone emails your agent's address, the agent receives the message and replies in the same email thread.
- Each email thread maps to a separate Poncho conversation with persistent history.
- Email attachments are passed to the agent as file inputs.
- Agent responses are formatted as HTML emails with proper markdown rendering.
- Quoted reply content is automatically stripped so the agent only sees the new message.
- The incoming email's sender and subject are included in the task header (`From:` / `Subject:`) so the agent knows who sent the email.

#### Response modes

Resend email supports two response modes:

- **`"auto-reply"`** (default): The agent's text response is automatically sent back as an email reply. Simple and zero-config.
- **`"tool"`**: Auto-reply is disabled. Instead, the agent gets a `send_email` tool with full control over recipients, subject, body, CC/BCC, and threading. Use this for agents that need to send emails to different people, compose custom subjects, or decide whether to reply at all.

#### Options

```javascript
messaging: [
  {
    platform: 'resend',
    // Optional: restrict who can email the agent
    allowedSenders: ['*@mycompany.com', 'partner@external.com'],
    // Optional: custom env var names
    apiKeyEnv: 'MY_RESEND_API_KEY',
    webhookSecretEnv: 'MY_RESEND_WEBHOOK_SECRET',
    fromEnv: 'MY_RESEND_FROM',
    replyToEnv: 'MY_RESEND_REPLY_TO',
  }
]
```

**Tool mode** gives the agent explicit email control:

```javascript
messaging: [
  {
    platform: 'resend',
    mode: 'tool',
    // Optional: restrict who the agent can email (glob patterns)
    allowedRecipients: ['*@mycompany.com', 'partner@external.com'],
    // Optional: max emails per agent run (default: 10)
    maxSendsPerRun: 5,
  }
]
```

In tool mode the agent can call `send_email` with:
- `to` (required): recipient email addresses
- `subject` (required): email subject
- `body` (required): markdown content (auto-converted to HTML)
- `cc`, `bcc` (optional): additional recipients
- `in_reply_to` (optional): message ID for threading as a reply; omit for a standalone email

### Custom Messaging Adapters

The `MessagingAdapter` interface from `@poncho-ai/messaging` is the extension point for adding other messaging platforms (SendGrid, Postmark, Discord, etc.). Implement the interface and wire it with `AgentBridge`:

```typescript
import { AgentBridge, type MessagingAdapter } from '@poncho-ai/messaging';
// Shared email utilities for threading (optional, useful for email adapters)
import { parseReferences, deriveRootMessageId, buildReplyHeaders } from '@poncho-ai/messaging';
```

See the `SlackAdapter` and `ResendAdapter` source code for reference implementations.

## Browser Automation (Experimental)

Give your agent the ability to browse the web with a headless Chromium browser. Powered by [`agent-browser`](https://github.com/vercel-labs/agent-browser).

```javascript
// poncho.config.js
export default {
  browser: true,
  // or with options:
  browser: {
    viewport: { width: 1280, height: 720 },
    quality: 80,
    everyNthFrame: 2,
    headless: true,
    profileDir: "~/.poncho/browser-profiles",
    stealth: true,           // Anti-bot-detection (default: true)
    userAgent: "custom UA",  // Override the default stealth user-agent
  },
}
```

When `browser` is enabled, the agent gets ten tools:

- `browser_open` — Navigate to a URL. Starts real-time viewport streaming.
- `browser_snapshot` — Get the page as a compact accessibility tree with element refs (`@e1`, `@e2`, ...).
- `browser_click` — Click an element by ref.
- `browser_click_text` — Click the first visible element containing a given text string. Useful for elements that don't appear in the accessibility snapshot (e.g. styled `<div>` buttons with no ARIA roles or identifiers). Supports exact and substring matching.
- `browser_execute_js` — Run JavaScript in the page context. Use this to inspect the DOM, find elements by text/class, get bounding boxes, or programmatically click elements that can't be targeted by other tools.
- `browser_type` — Type text into a form field by ref.
- `browser_content` — Get the visible text content of the current page as plain text.
- `browser_screenshot` — Take a PNG screenshot (sent to the model as an image).
- `browser_scroll` — Scroll the page up or down.
- `browser_close` — Save session and close the browser.

The agent uses the snapshot/ref pattern: call `browser_snapshot` to get refs, then `browser_click @e2` or `browser_type @e3 "hello"`. Re-snapshot after each interaction since refs change when the page updates.

For elements that don't appear in the snapshot (styled divs, custom components without ARIA attributes), use `browser_click_text` to click by visible text, or `browser_execute_js` for DOM-level interaction.

### Live viewport

The web UI shows a real-time browser viewport panel alongside the chat when a browser session is active. Frames stream via CDP screencast through the `/api/browser/stream` SSE endpoint.

### Session persistence

Browser sessions are stored in profile directories (`~/.poncho/browser-profiles/<agent-id>/`). Cookies, localStorage, and other browser state persist across runs, so the agent can pick up where it left off (e.g., staying logged in across cron job runs).

### Stealth mode

Stealth mode is **enabled by default** (`stealth: true`) and reduces bot-detection fingerprints so websites treat the browser like a regular user session. It applies:

- A realistic Chrome user-agent string (matching the host OS)
- `--disable-blink-features=AutomationControlled` flag
- `navigator.webdriver` overridden to `false`
- `window.chrome` shim for headless Chromium
- Fake `navigator.plugins` (3 standard Chrome plugins)
- `navigator.languages` fallback (`['en-US', 'en']`)
- WebGL vendor/renderer patched to hide SwiftShader
- `Notification.permission` patched for headless mode
- Browser-level `--user-agent` flag (covers Web Workers)

To disable stealth mode (e.g., for trusted internal sites), set `stealth: false`. To use a custom user-agent while keeping other stealth patches, set `userAgent`:

```javascript
browser: {
  stealth: true,             // default
  userAgent: "MyBot/1.0",    // overrides the auto-detected Chrome UA
}
```

### Setup

Install the browser package in your agent project:

```bash
pnpm add @poncho-ai/browser
```

Then set `browser: true` in `poncho.config.js`. Chromium is downloaded automatically via a `postinstall` hook (skipped when `CI` or `SERVERLESS` env vars are set).

### Cloud browser providers (Vercel, Lambda, serverless)

Serverless platforms like Vercel don't have a local Chromium binary. Use a cloud browser provider instead:

**[Browserbase](https://browserbase.com)** (recommended):

```javascript
// poncho.config.js
export default {
  browser: {
    provider: "browserbase",
  },
};
```

Set `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID` as environment variables on your deployment platform.

**[Browser Use](https://browseruse.com)**:

```javascript
browser: {
  provider: "browseruse",
}
```

Set `BROWSER_USE_API_KEY` as an environment variable.

**Direct CDP connection** (connect to any remote browser):

```javascript
browser: {
  cdpUrl: "wss://your-browser-service.example.com",
}
```

**`@sparticuz/chromium`** (Vercel / Lambda — bundles a stripped Chromium binary):

```bash
pnpm add @sparticuz/chromium
```

When `@sparticuz/chromium` is installed and a serverless environment is detected (Vercel, AWS Lambda), the browser package automatically resolves the executable path and uses `/tmp` for the ephemeral profile directory. No config changes needed beyond `browser: true`.

## Subagents

Poncho agents can spawn recursive copies of themselves as **subagents**. Each subagent runs in its own independent conversation with full access to the agent's tools and skills. The parent agent controls the subagent lifecycle and receives results directly.

Subagents are useful when an agent needs to parallelize work, delegate a subtask, or isolate a line of investigation without polluting the main conversation context.

### How it works

When the agent decides to use a subagent, it calls `spawn_subagent` with a task description. The subagent runs to completion and the result is returned to the parent — the call is **blocking**, so the parent waits for the subagent to finish before continuing.

The parent can also send follow-up messages to existing subagents with `message_subagent`, stop a running subagent with `stop_subagent`, or list all its subagents with `list_subagents`.

### Available tools

| Tool | Description |
|------|-------------|
| `spawn_subagent` | Create a new subagent with a task. Blocks until the subagent completes and returns the result. |
| `message_subagent` | Send a follow-up message to an existing subagent. Blocks until it responds. |
| `stop_subagent` | Stop a running subagent. |
| `list_subagents` | List all subagents for the current conversation with their IDs, tasks, and statuses. |

### Limits

- **Max depth**: 3 levels of nesting (an agent can spawn a subagent, which can spawn another, but no deeper).
- **Max concurrent**: 5 subagents per parent conversation.

### Memory isolation

Subagents have **read-only** access to the parent agent's persistent memory. They can recall information but cannot modify the main memory document. This prevents subagents from accidentally overwriting each other's memory updates.

### Approvals

When a subagent invokes a tool that requires approval, the approval request is **tunneled to the parent conversation**. You'll see the approval prompt inline in the parent's message thread with a label indicating which subagent is asking. The parent conversation also shows an orange dot in the sidebar while any subagent is waiting for approval.

### Web UI

In the web UI, subagent conversations appear **nested under their parent** in the sidebar (tree-style indentation). Clicking a subagent conversation shows it in read-only mode — you can view the full context but cannot send messages, since the parent agent controls the subagent.

When the parent conversation is active, `spawn_subagent` tool calls in the tool activity timeline are clickable links that navigate to the subagent's conversation.

## Persistent Memory

When `memory.enabled` is true in `poncho.config.js`, the harness enables a simple memory model:

- A single persistent main memory document is loaded at run start and interpolated into the system prompt under `## Persistent Memory`.
- `memory_main_update` can replace or append to that document. The tool description instructs the model to proactively evaluate each turn whether durable memory should be updated.
- `conversation_recall` can search recent prior conversations (keyword scoring) when historical context is relevant (`as we discussed`, `last time`, etc.).

```javascript
// poncho.config.js
export default {
  storage: {
    provider: 'local',           // 'local' | 'memory' | 'redis' | 'upstash' | 'dynamodb'
    memory: {
      enabled: true,
      maxRecallConversations: 20, // Bounds conversation_recall scan size
    },
  },
}
```

Available memory tools:

- `memory_main_get`
- `memory_main_update`
- `conversation_recall`
