import type http from "node:http";
import type { Message, ToolDefinition } from "@poncho-ai/sdk";

// ---------------------------------------------------------------------------
// Thread & message primitives
// ---------------------------------------------------------------------------

export interface ThreadRef {
  platformThreadId: string;
  channelId: string;
  /** The specific message ID that triggered this interaction (for reactions). */
  messageId?: string;
}

export interface FileAttachment {
  /** base64-encoded file data */
  data: string;
  mediaType: string;
  filename?: string;
}

export interface IncomingMessage {
  text: string;
  subject?: string;
  files?: FileAttachment[];
  threadRef: ThreadRef;
  sender: { id: string; name?: string };
  platform: string;
  raw: unknown;
}

export type IncomingMessageHandler = (
  message: IncomingMessage,
) => Promise<void>;

// ---------------------------------------------------------------------------
// Route registration (adapter ↔ HTTP server contract)
// ---------------------------------------------------------------------------

export type RouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => Promise<void>;

export type RouteRegistrar = (
  method: "GET" | "POST",
  path: string,
  handler: RouteHandler,
) => void;

// ---------------------------------------------------------------------------
// Messaging adapter interface (one per platform)
// ---------------------------------------------------------------------------

export interface MessagingAdapter {
  readonly platform: string;

  /** When true, the bridge auto-sends the agent's response as a reply. */
  readonly autoReply: boolean;

  /**
   * Whether the adapter's tool has sent at least one message during the
   * current request. Used by the bridge to suppress duplicate error replies.
   */
  readonly hasSentInCurrentRequest: boolean;

  /** Register HTTP routes on the host server for receiving platform events. */
  registerRoutes(router: RouteRegistrar): void;

  /** One-time startup (e.g. validate credentials). */
  initialize(): Promise<void>;

  /** Set the handler that processes incoming messages. */
  onMessage(handler: IncomingMessageHandler): void;

  /** Post a reply back to the originating thread. */
  sendReply(
    threadRef: ThreadRef,
    content: string,
    options?: { files?: FileAttachment[] },
  ): Promise<void>;

  /**
   * Show a processing indicator (e.g. reaction, typing).
   * Returns a cleanup function that removes the indicator.
   */
  indicateProcessing(
    threadRef: ThreadRef,
  ): Promise<() => Promise<void>>;

  /**
   * Optional: return tool definitions the agent can use (e.g. send_email).
   * Called once after initialization to register tools with the harness.
   */
  getToolDefinitions?(): ToolDefinition[];

  /** Reset per-request state (e.g. send counter, hasSentInCurrentRequest). */
  resetRequestState?(): void;
}

// ---------------------------------------------------------------------------
// Agent runner interface (bridge ↔ agent contract)
// ---------------------------------------------------------------------------

export interface AgentRunner {
  getOrCreateConversation(
    conversationId: string,
    meta: {
      platform: string;
      ownerId: string;
      title?: string;
      channelId?: string;
      platformThreadId?: string;
    },
  ): Promise<{ messages: Message[] }>;

  run(
    conversationId: string,
    input: {
      task: string;
      messages: Message[];
      files?: FileAttachment[];
      metadata?: {
        platform: string;
        sender: { id: string; name?: string };
        threadId: string;
      };
    },
  ): Promise<{
    response: string;
    files?: FileAttachment[];
    continuation?: boolean;
    steps?: number;
    maxSteps?: number;
  }>;
}

// ---------------------------------------------------------------------------
// Bridge options
// ---------------------------------------------------------------------------

export interface AgentBridgeOptions {
  adapter: MessagingAdapter;
  runner: AgentRunner;
  /**
   * Optional hook to keep serverless functions alive after the HTTP response.
   * On Vercel, pass the real `waitUntil` from `@vercel/functions`.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
  /**
   * Override the ownerId for conversations created by this bridge.
   * Defaults to the sender's ID. Set to a fixed value (e.g. "local-owner")
   * so messaging conversations appear in the web UI alongside regular ones.
   */
  ownerId?: string;
}
