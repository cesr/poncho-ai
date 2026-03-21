# Error Handling & Troubleshooting

> Back to [README](../README.md)

## Error Types

These error codes appear in `run:error` SSE events:

| Code | Description |
|------|-------------|
| `MAX_STEPS_EXCEEDED` | Agent hit the step limit without completing |
| `TIMEOUT` | Agent exceeded the timeout |
| `MODEL_TIMEOUT` | Model API call timed out |
| `MODEL_ERROR` | Model API returned an error |
| `CONTENT_FILTER` | Response blocked by the provider's content filter |
| `AUTH_ERROR` | Authentication failed |

## Tool Errors Are Recoverable

When a tool fails, the error is sent back to the model via a `tool:error` event. The model can retry with different parameters, try a different tool, or ask the user for help:

```
event: tool:error
data: {"tool": "fetch-url", "error": "Connection timeout", "recoverable": true}

event: model:chunk
data: {"content": "I couldn't fetch that URL. Let me try a different approach..."}
```

## Fatal Errors End the Run

Timeout, max steps, or model API errors end the run immediately:

```
event: run:error
data: {"runId": "run_abc", "error": {"code": "TIMEOUT", "message": "Run exceeded 60 second timeout"}}
```

## Handle Errors in Your Client

```typescript
const agent = new AgentClient({ url: 'https://my-agent.vercel.app' })

try {
  const result = await agent.run({ task: 'Do something' })
} catch (error) {
  console.error('Agent run failed:', error.message)
}
```

## Troubleshooting

### "ANTHROPIC_API_KEY not set"

Make sure you have a `.env` file with your API key:

```bash
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env
```

### "OpenAI Codex credentials not found"

Bootstrap credentials with device auth, then export env values:

```bash
poncho auth login --provider openai-codex --device
poncho auth export --provider openai-codex --format env
```

For production, copy exported values into your deployment secret manager (not committed files).

### "OpenAI Codex token refresh failed" / `invalid_grant`

Your refresh token is expired or rotated. Re-run one-time auth and rotate deployment secrets:

```bash
poncho auth login --provider openai-codex --device
poncho auth export --provider openai-codex --format env
```

Then restart your deployment so new secrets are loaded.

### "Missing scopes: model.request / api.model.read / api.responses.write"

Re-authenticate and ensure the OAuth flow requested required scopes. Then verify:

```bash
poncho auth status --provider openai-codex
```

### "MCP server failed to connect"

Check that:
1. A remote MCP server is configured (`poncho mcp list`)
2. The MCP URL is correct and reachable (`http://` or `https://`)
3. Required environment variables/secrets are set
4. Any required auth headers/tokens expected by the remote server are configured

### Agent keeps running forever

Set execution limits:

```yaml
---
limits:
  maxSteps: 20
  timeout: 60  # 1 minute (in seconds)
---
```

### Vercel deploy issues

- After upgrading `@poncho-ai/cli`, re-run `poncho build vercel --force` to refresh generated deploy files.
- If Vercel fails during `pnpm install` due to a lockfile mismatch, run `pnpm install --no-frozen-lockfile` locally and commit `pnpm-lock.yaml`.
- Deploy from the project root: `vercel deploy --prod`.
