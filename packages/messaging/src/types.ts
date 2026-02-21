import type http from "node:http";
import type { Message } from "@poncho-ai/sdk";

// ---------------------------------------------------------------------------
// Thread & message primitives
// ---------------------------------------------------------------------------

export interface ThreadRef {
  platformThreadId: string;
  channelId: string;
  /** The specific message ID that triggered this interaction (for reactions). */
  messageId?: string;
}

export interface IncomingMessage {
  text: string;
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

  /** Register HTTP routes on the host server for receiving platform events. */
  registerRoutes(router: RouteRegistrar): void;

  /** One-time startup (e.g. validate credentials). */
  initialize(): Promise<void>;

  /** Set the handler that processes incoming messages. */
  onMessage(handler: IncomingMessageHandler): void;

  /** Post a reply back to the originating thread. */
  sendReply(threadRef: ThreadRef, content: string): Promise<void>;

  /**
   * Show a processing indicator (e.g. reaction, typing).
   * Returns a cleanup function that removes the indicator.
   */
  indicateProcessing(
    threadRef: ThreadRef,
  ): Promise<() => Promise<void>>;
}

// ---------------------------------------------------------------------------
// Agent runner interface (bridge ↔ agent contract)
// ---------------------------------------------------------------------------

export interface AgentRunner {
  getOrCreateConversation(
    conversationId: string,
    meta: { platform: string; ownerId: string; title?: string },
  ): Promise<{ messages: Message[] }>;

  run(
    conversationId: string,
    input: { task: string; messages: Message[] },
  ): Promise<{ response: string }>;
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
}
