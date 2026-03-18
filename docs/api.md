# HTTP API & Client SDK

> Back to [README](../README.md)

Your deployed agent exposes these endpoints:

| Endpoint | Use case |
|----------|----------|
| `GET /health` | Health checks for load balancers |
| `GET /api/docs` | Interactive API documentation (Scalar) |
| `GET /api/openapi.json` | OpenAPI 3.1 spec (machine-readable) |
| `GET /api/auth/session` | Session status + CSRF token for browser clients |
| `POST /api/auth/login` | Passphrase login for browser sessions |
| `POST /api/auth/logout` | End browser session |
| `GET /api/conversations` | List stored conversations |
| `POST /api/conversations` | Create conversation |
| `GET /api/conversations/:conversationId` | Get conversation transcript |
| `PATCH /api/conversations/:conversationId` | Rename conversation |
| `DELETE /api/conversations/:conversationId` | Delete conversation |
| `POST /api/conversations/:conversationId/messages` | Stream a new assistant response |
| `GET /api/conversations/:conversationId/events` | Attach to live SSE stream |
| `POST /api/conversations/:conversationId/stop` | Cancel an in-flight run |
| `POST /api/conversations/:conversationId/compact` | Compact conversation context (summarize older messages) |
| `POST /api/approvals/:approvalId` | Resolve tool approval request |
| `GET /api/uploads/:key` | Retrieve uploaded file |
| `GET\|POST /api/cron/:jobName` | Trigger a cron job (see [Cron Jobs](../README.md#cron-jobs)) |
| `GET /api/browser/status` | Browser session status (when browser is enabled) |
| `GET /api/browser/stream` | SSE stream of live browser viewport frames |
| `POST /api/browser/input` | Send input events to the browser session |
| `POST /api/browser/navigate` | Navigate the browser to a URL |

> **Tip:** Visit `/api/docs` on any running agent for interactive API documentation with request examples and full schema details.

## POST /api/conversations/:conversationId/messages (streaming)

```bash
curl -N -X POST https://my-agent.vercel.app/api/conversations/<conversation-id>/messages \
  -H "Content-Type: application/json" \
  -d '{"message": "Write a hello world function"}'
```

Response: Server-Sent Events (`run:started`, `model:chunk`, `tool:*`, `run:completed`).

On serverless deployments with `PONCHO_MAX_DURATION` set, the `run:completed` event may
include `continuation: true` in `result`, indicating the agent stopped early due to a
platform timeout. The server preserves the full internal message chain so the agent
resumes with complete context. The web UI and client SDK handle continuation automatically
by re-posting to the same conversation with `{ continuation: true }` — no manual
"Continue" message is needed.

## Build a custom chat UI

You can build your own chat frontend by calling Poncho's conversation endpoints directly.

Typical UI flow:

1. Create a conversation: `POST /api/conversations`
2. Send a message and stream events: `POST /api/conversations/:conversationId/messages`
3. Append `model:chunk` events into the in-progress assistant message
4. Render `tool:*` events as activity status
5. Finalize on `run:completed` (or handle `run:error` / `run:cancelled`)
6. Reload full transcript on refresh: `GET /api/conversations/:conversationId`

Minimal browser example (SSE parsing):

```typescript
async function streamMessage(conversationId: string, message: string) {
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
      credentials: "include", // keep for session auth
    },
  );

  if (!response.ok || !response.body) {
    throw new Error(`Streaming request failed: HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      const lines = frame
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

      const eventLine = lines.find((line) => line.startsWith("event:"));
      const dataLine = lines.find((line) => line.startsWith("data:"));
      if (!eventLine || !dataLine) continue;

      const eventName = eventLine.slice("event:".length).trim();
      const payload = JSON.parse(dataLine.slice("data:".length).trim());

      if (eventName === "model:chunk") {
        // Append payload.content to the active assistant message
      } else if (eventName === "tool:started") {
        // Show "running tool" activity
      } else if (eventName === "tool:completed") {
        // Mark tool activity as complete
      } else if (eventName === "run:completed") {
        // Finalize assistant message
      } else if (eventName === "run:error" || eventName === "run:cancelled") {
        // Show interrupted/error state in UI
      }
    }
  }
}
```

Useful optional endpoints for richer UIs:

- `POST /api/conversations/:conversationId/stop` with `{ "runId": "<run-id>" }` to cancel an in-flight run
- `POST /api/conversations/:conversationId/compact` with optional `{ "instructions": "focus hint" }` to summarize older messages and free context space (returns 409 if a run is active)
- `GET /api/conversations/:conversationId/events` to attach/re-attach to a live event stream
- `POST /api/approvals/:approvalId` with `{ "approved": true|false }` to resolve `tool:approval:required`

Auth notes for custom frontends:

- Browser session mode: `GET /api/auth/session`, then `POST /api/auth/login`, and send `x-csrf-token` on mutating requests.
- API token mode: send `Authorization: Bearer <PONCHO_AUTH_TOKEN>` on API requests.

## Headless mode (API-only)

If you're building your own frontend or using the agent purely as an API, disable the built-in Web UI:

```javascript
// poncho.config.js
export default {
  webUi: false,
}
```

When `webUi` is `false`:
- The built-in chat UI at `/` is disabled (returns 404).
- All `/api/*` endpoints, `/health`, and `/api/docs` continue to work normally.
- Messaging adapter routes (e.g., Slack) are unaffected.

This is useful for API-only deployments where a separate frontend (e.g., a Next.js app) calls the Poncho API via a backend-for-frontend pattern.

## TypeScript/JavaScript Client

Install the client SDK for type-safe access:

```bash
npm install @poncho-ai/client
```

```typescript
import { AgentClient } from '@poncho-ai/client'

const agent = new AgentClient({
  url: 'https://my-agent.vercel.app',
  apiKey: 'your-api-key'  // Optional, if auth enabled
})

// Create and send in one call (conversation() returns a stateful helper)
const conv = agent.conversation()
const first = await conv.send('What is 2 + 2?')
console.log(first.result.response)
const followUp = await conv.send('And what is 3 + 3?')

// Or manage conversations explicitly
const created = await agent.createConversation({ title: 'Session' })
const response = await agent.sendMessage(created.conversationId, 'What is 2 + 2?')
console.log(response.result.response)

// Send with file attachments
await agent.sendMessage(created.conversationId, 'Describe this image', {
  files: [{ data: base64Data, mediaType: 'image/png', filename: 'photo.png' }],
})

// One-shot run (creates a conversation automatically)
const result = await agent.run({ task: 'Write a haiku about coding' })

// Stream events (creates a conversation automatically)
for await (const event of agent.stream({ task: 'Write a story' })) {
  if (event.type === 'model:chunk') process.stdout.write(event.content)
}

// List, get, delete conversations
const conversations = await agent.listConversations()
const transcript = await agent.getConversation(created.conversationId)
await agent.deleteConversation(created.conversationId)
```

## Multi-turn Conversations

Conversations are persisted and keyed by `conversationId`.

Typical flow:

1. `POST /api/conversations`
2. `POST /api/conversations/:conversationId/messages`
3. Repeat step 2 for follow-up turns
4. `GET /api/conversations/:conversationId` to fetch full transcript

## File Attachments

Agents support multimodal inputs — attach files to any message via the Web UI, API, or client SDK.

### Web UI

Click the attach button (paperclip icon), drag files onto the chat, or paste from your clipboard. Attached files appear as previews above the composer before sending.

### HTTP API

Send files as `multipart/form-data` or as base64-encoded JSON:

```bash
# multipart/form-data
curl -N -X POST "http://localhost:3000/api/conversations/<id>/messages" \
  -F "message=Describe this image" \
  -F "files=@screenshot.png"

# JSON with base64
curl -N -X POST "http://localhost:3000/api/conversations/<id>/messages" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Describe this image",
    "files": [{
      "data": "<base64-encoded>",
      "mediaType": "image/png",
      "filename": "screenshot.png"
    }]
  }'
```

### Client SDK

```typescript
const response = await agent.sendMessage(conversationId, 'Describe this image', {
  files: [{ data: base64Data, mediaType: 'image/png', filename: 'screenshot.png' }],
})
```

### Upload storage

By default, uploaded files are stored on the local filesystem. For production deployments, configure a cloud upload provider:

```javascript
// poncho.config.js
export default {
  uploads: {
    provider: 'vercel-blob',  // 'local' | 'vercel-blob' | 's3'
    access: 'public',         // vercel-blob access mode (default: 'public')
  },
  // Or S3-compatible storage:
  uploads: {
    provider: 's3',
    bucket: 'my-agent-uploads',
    region: 'us-east-1',
    endpoint: 'https://s3.amazonaws.com',  // optional, for S3-compatible services
  },
}
```

Environment variables for upload providers:

| Provider | Required env vars |
|----------|-------------------|
| `vercel-blob` | `BLOB_READ_WRITE_TOKEN` |
| `s3` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `PONCHO_UPLOADS_BUCKET` (or `uploads.bucket` in config) |
