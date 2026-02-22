/**
 * OpenAPI 3.1 spec and interactive docs page for the Poncho agent HTTP API.
 */

export const buildOpenApiSpec = (options: { agentName: string }): Record<string, unknown> => ({
  openapi: "3.1.0",
  info: {
    title: `${options.agentName} API`,
    description:
      "HTTP API for interacting with a Poncho agent. Supports conversation management, " +
      "streaming message responses via Server-Sent Events (SSE), tool approval workflows, " +
      "file uploads, and cron job triggers.",
    version: "1.0.0",
  },
  servers: [{ url: "/", description: "Current host" }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        description:
          "Pass the PONCHO_AUTH_TOKEN value as a Bearer token. " +
          "Required only when `auth.required: true` in poncho.config.js.",
      },
    },
    schemas: {
      ConversationSummary: {
        type: "object",
        properties: {
          conversationId: { type: "string" },
          title: { type: "string" },
          runtimeRunId: { type: "string" },
          ownerId: { type: "string" },
          tenantId: { type: ["string", "null"] },
          createdAt: { type: "number", description: "Unix epoch ms" },
          updatedAt: { type: "number", description: "Unix epoch ms" },
          messageCount: { type: "integer" },
        },
      },
      Message: {
        type: "object",
        properties: {
          role: { type: "string", enum: ["user", "assistant"] },
          content: {
            oneOf: [
              { type: "string" },
              {
                type: "array",
                items: {
                  oneOf: [
                    {
                      type: "object",
                      properties: {
                        type: { type: "string", const: "text" },
                        text: { type: "string" },
                      },
                    },
                    {
                      type: "object",
                      properties: {
                        type: { type: "string", const: "file" },
                        data: { type: "string" },
                        mediaType: { type: "string" },
                        filename: { type: "string" },
                      },
                    },
                  ],
                },
              },
            ],
          },
          metadata: {
            type: "object",
            properties: {
              id: { type: "string" },
              timestamp: { type: "number" },
              tokenCount: { type: "number" },
              step: { type: "number" },
              toolActivity: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
      Conversation: {
        type: "object",
        properties: {
          conversationId: { type: "string" },
          title: { type: "string" },
          ownerId: { type: "string" },
          tenantId: { type: ["string", "null"] },
          createdAt: { type: "number" },
          updatedAt: { type: "number" },
          messages: { type: "array", items: { $ref: "#/components/schemas/Message" } },
          pendingApprovals: {
            type: "array",
            items: { $ref: "#/components/schemas/PendingApproval" },
          },
        },
      },
      PendingApproval: {
        type: "object",
        properties: {
          approvalId: { type: "string" },
          runId: { type: "string" },
          tool: { type: "string" },
          input: {},
        },
      },
      TokenUsage: {
        type: "object",
        properties: {
          input: { type: "integer" },
          output: { type: "integer" },
          cached: { type: "integer" },
        },
      },
      RunResult: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["completed", "error", "cancelled"] },
          response: { type: "string" },
          steps: { type: "integer" },
          tokens: { $ref: "#/components/schemas/TokenUsage" },
          duration: { type: "number", description: "Duration in ms" },
          continuation: { type: "boolean" },
          maxSteps: { type: "integer" },
        },
      },
      FileAttachment: {
        type: "object",
        properties: {
          data: { type: "string", description: "base64-encoded file data" },
          mediaType: { type: "string" },
          filename: { type: "string" },
        },
        required: ["data", "mediaType"],
      },
      Error: {
        type: "object",
        properties: {
          code: { type: "string" },
          message: { type: "string" },
        },
      },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    "/health": {
      get: {
        tags: ["Health"],
        summary: "Health check",
        security: [],
        responses: {
          "200": {
            description: "Server is healthy",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { status: { type: "string", const: "ok" } },
                },
              },
            },
          },
        },
      },
    },

    "/api/auth/session": {
      get: {
        tags: ["Auth"],
        summary: "Check session status",
        description: "Returns whether the caller is authenticated and provides a CSRF token for subsequent mutating requests.",
        security: [],
        responses: {
          "200": {
            description: "Session status",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    authenticated: { type: "boolean" },
                    sessionId: { type: "string" },
                    ownerId: { type: "string" },
                    csrfToken: { type: "string" },
                  },
                  required: ["authenticated"],
                },
              },
            },
          },
        },
      },
    },
    "/api/auth/login": {
      post: {
        tags: ["Auth"],
        summary: "Authenticate with passphrase",
        description: "Creates a session cookie. Only needed for browser-based auth; API clients should use Bearer tokens instead.",
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { passphrase: { type: "string" } },
                required: ["passphrase"],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Login successful",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean" },
                    sessionId: { type: "string" },
                    csrfToken: { type: "string" },
                  },
                },
              },
            },
          },
          "401": {
            description: "Invalid passphrase",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "429": {
            description: "Too many login attempts",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
    },
    "/api/auth/logout": {
      post: {
        tags: ["Auth"],
        summary: "End session",
        responses: {
          "200": {
            description: "Logged out",
            content: {
              "application/json": {
                schema: { type: "object", properties: { ok: { type: "boolean" } } },
              },
            },
          },
        },
      },
    },

    "/api/conversations": {
      get: {
        tags: ["Conversations"],
        summary: "List conversations",
        responses: {
          "200": {
            description: "Conversation list",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    conversations: {
                      type: "array",
                      items: { $ref: "#/components/schemas/ConversationSummary" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        tags: ["Conversations"],
        summary: "Create a conversation",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { title: { type: "string" } },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Conversation created",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { conversation: { $ref: "#/components/schemas/Conversation" } },
                },
              },
            },
          },
        },
      },
    },

    "/api/conversations/{conversationId}": {
      get: {
        tags: ["Conversations"],
        summary: "Get conversation",
        description: "Returns the full conversation including messages and any pending tool approval requests.",
        parameters: [
          { name: "conversationId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "Conversation with messages",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { conversation: { $ref: "#/components/schemas/Conversation" } },
                },
              },
            },
          },
          "404": {
            description: "Conversation not found",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
      patch: {
        tags: ["Conversations"],
        summary: "Rename conversation",
        parameters: [
          { name: "conversationId", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { title: { type: "string" } },
                required: ["title"],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Conversation renamed",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { conversation: { $ref: "#/components/schemas/Conversation" } },
                },
              },
            },
          },
        },
      },
      delete: {
        tags: ["Conversations"],
        summary: "Delete conversation",
        parameters: [
          { name: "conversationId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "Conversation deleted",
            content: {
              "application/json": {
                schema: { type: "object", properties: { ok: { type: "boolean" } } },
              },
            },
          },
        },
      },
    },

    "/api/conversations/{conversationId}/messages": {
      post: {
        tags: ["Messages"],
        summary: "Send a message (streaming)",
        description:
          "Sends a user message and streams the agent's response via Server-Sent Events.\n\n" +
          "### SSE protocol\n\n" +
          "The response is a stream of SSE frames. Each frame has the format:\n\n" +
          "```\nevent: <type>\ndata: <json>\n\n```\n\n" +
          "**Event types:**\n\n" +
          "| Event | Payload | Description |\n" +
          "| --- | --- | --- |\n" +
          "| `run:started` | `{ runId, agentId }` | Agent run has begun |\n" +
          "| `model:chunk` | `{ content }` | Incremental text token from the model |\n" +
          "| `model:response` | `{ usage: { input, output, cached } }` | Model call finished |\n" +
          "| `step:started` | `{ step }` | Agent step started |\n" +
          "| `step:completed` | `{ step, duration }` | Agent step finished |\n" +
          "| `tool:started` | `{ tool, input }` | Tool invocation started |\n" +
          "| `tool:completed` | `{ tool, output, duration }` | Tool finished successfully |\n" +
          "| `tool:error` | `{ tool, error, recoverable }` | Tool returned an error |\n" +
          "| `tool:approval:required` | `{ tool, input, approvalId }` | Tool needs human approval |\n" +
          "| `tool:approval:granted` | `{ approvalId }` | Approval was granted |\n" +
          "| `tool:approval:denied` | `{ approvalId, reason? }` | Approval was denied |\n" +
          "| `run:completed` | `{ runId, result: RunResult }` | Agent finished |\n" +
          "| `run:error` | `{ runId, error: { code, message } }` | Agent failed |\n" +
          "| `run:cancelled` | `{ runId }` | Run was cancelled via stop endpoint |\n\n" +
          "To build the assistant's response, concatenate all `model:chunk` content values.\n\n" +
          "### Reconnection\n\n" +
          "If the SSE connection drops mid-stream, reconnect via " +
          "`GET /api/conversations/{conversationId}/events` to replay buffered events.",
        parameters: [
          { name: "conversationId", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  message: { type: "string", description: "User message text" },
                  parameters: {
                    type: "object",
                    additionalProperties: true,
                    description: "Key-value parameters passed to the agent run",
                  },
                  files: {
                    type: "array",
                    items: { $ref: "#/components/schemas/FileAttachment" },
                    description: "Attached files (base64-encoded)",
                  },
                },
                required: ["message"],
              },
            },
            "multipart/form-data": {
              schema: {
                type: "object",
                properties: {
                  message: { type: "string" },
                  parameters: { type: "string", description: "JSON-encoded parameters object" },
                  files: { type: "array", items: { type: "string", format: "binary" } },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "SSE stream of agent events",
            content: { "text/event-stream": { schema: { type: "string" } } },
          },
          "404": {
            description: "Conversation not found",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
    },

    "/api/conversations/{conversationId}/events": {
      get: {
        tags: ["Messages"],
        summary: "Attach to live event stream",
        description:
          "Connects to the SSE event stream for an in-progress run. " +
          "Replays all buffered events from the current run, then streams live events. " +
          "If no run is active, sends a `stream:end` event and closes.",
        parameters: [
          { name: "conversationId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "SSE stream (same event format as POST /messages)",
            content: { "text/event-stream": { schema: { type: "string" } } },
          },
          "404": {
            description: "Conversation not found",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
    },

    "/api/conversations/{conversationId}/stop": {
      post: {
        tags: ["Messages"],
        summary: "Stop an in-flight run",
        parameters: [
          { name: "conversationId", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  runId: { type: "string", description: "The run ID to cancel (from run:started event)" },
                },
                required: ["runId"],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Stop result",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean" },
                    stopped: { type: "boolean" },
                    runId: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },

    "/api/approvals/{approvalId}": {
      post: {
        tags: ["Approvals"],
        summary: "Resolve a tool approval request",
        description:
          "When an agent run encounters a gated tool, it emits a `tool:approval:required` SSE event " +
          "and pauses. Use this endpoint to approve or deny the tool invocation.",
        parameters: [
          { name: "approvalId", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { approved: { type: "boolean" } },
                required: ["approved"],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Approval resolved",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean" },
                    approvalId: { type: "string" },
                    approved: { type: "boolean" },
                  },
                },
              },
            },
          },
          "404": {
            description: "Approval not found or expired",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
    },

    "/api/uploads/{key}": {
      get: {
        tags: ["Assets"],
        summary: "Retrieve an uploaded file",
        description: "Serves a file previously uploaded during a conversation. The key is returned in file content part references.",
        parameters: [
          {
            name: "key",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Upload key (e.g. filename or storage path)",
          },
        ],
        responses: {
          "200": {
            description: "File content with appropriate Content-Type",
            content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
          },
          "404": {
            description: "Upload not found",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
    },

    "/api/cron/{jobName}": {
      get: {
        tags: ["Cron"],
        summary: "Trigger a cron job",
        description:
          "Triggers a named cron job defined in AGENT.md frontmatter. " +
          "Supports continuation via the `continue` query parameter.",
        parameters: [
          { name: "jobName", in: "path", required: true, schema: { type: "string" } },
          {
            name: "continue",
            in: "query",
            schema: { type: "string" },
            description: "Conversation ID to continue a previous cron run",
          },
        ],
        responses: {
          "200": {
            description: "Cron job result",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    conversationId: { type: "string" },
                    response: { type: "string" },
                    steps: { type: "integer" },
                    status: { type: "string" },
                    continuation: { type: "string", description: "URL to continue this run" },
                  },
                },
              },
            },
          },
          "404": {
            description: "Cron job not found",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
    },
  },
  tags: [
    { name: "Health", description: "Server health check" },
    { name: "Auth", description: "Session and authentication management" },
    { name: "Conversations", description: "Create, list, read, rename, and delete conversations" },
    {
      name: "Messages",
      description: "Send messages and stream agent responses via SSE",
    },
    { name: "Approvals", description: "Resolve gated tool approval requests" },
    { name: "Assets", description: "Retrieve uploaded files" },
    { name: "Cron", description: "Trigger cron jobs defined in AGENT.md" },
  ],
});

export const renderApiDocsHtml = (specUrl: string): string => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>API Documentation</title>
  <style>body { margin: 0; }</style>
</head>
<body>
  <script id="api-reference" data-url="${specUrl}"></script>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</body>
</html>`;
