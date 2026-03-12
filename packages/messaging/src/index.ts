export type {
  AgentBridgeOptions,
  AgentRunner,
  FileAttachment,
  IncomingMessage,
  IncomingMessageHandler,
  MessagingAdapter,
  RouteHandler,
  RouteRegistrar,
  ThreadRef,
} from "./types.js";

export { AgentBridge, conversationIdFromThread } from "./bridge.js";
export { SlackAdapter } from "./adapters/slack/index.js";
export type { SlackAdapterOptions } from "./adapters/slack/index.js";
export { ResendAdapter } from "./adapters/resend/index.js";
export type { ResendAdapterOptions } from "./adapters/resend/index.js";
export { TelegramAdapter } from "./adapters/telegram/index.js";
export type { TelegramAdapterOptions } from "./adapters/telegram/index.js";

export {
  buildReplyHeaders,
  buildReplySubject,
  deriveRootMessageId,
  extractDisplayName,
  extractEmailAddress,
  markdownToEmailHtml,
  matchesSenderPattern,
  parseReferences,
  stripQuotedReply,
} from "./adapters/email/utils.js";
