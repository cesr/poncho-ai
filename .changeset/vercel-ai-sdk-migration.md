---
"@poncho-ai/harness": minor
---

Migrate to Vercel AI SDK for unified model provider support

This major refactoring replaces separate OpenAI and Anthropic client implementations with Vercel AI SDK's unified interface, simplifying the codebase by ~1,265 lines and enabling easier addition of new model providers.

**Key improvements:**
- Unified model provider interface via Vercel AI SDK
- JSON Schema to Zod converter for tool definitions
- Fixed tool call preservation in multi-step agent loops
- Simplified architecture with better maintainability
- Added comprehensive error handling for step execution

**Breaking changes (internal API only):**
- `ModelClient` interface removed (use Vercel AI SDK directly)
- `OpenAiModelClient` and `AnthropicModelClient` classes removed
- `createModelClient()` replaced with `createModelProvider()`

**User-facing API unchanged:**
- AGENT.md format unchanged
- Tool definitions unchanged (JSON Schema still works)
- Model provider names unchanged (`openai`, `anthropic`)
- Agent behavior unchanged from user perspective
