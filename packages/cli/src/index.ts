import { readFile, writeFile } from "node:fs/promises";
import { watch as fsWatch } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
  AgentHarness,
  TelemetryEmitter,
  createConversationStore,
  createConversationStoreFromEngine,
  createUploadStore,
  deriveUploadKey,
  ensureAgentIdentity,
  loadPonchoConfig,
  parseAgentMarkdown,
  resolveStateConfig,
  type CronJobConfig,
  type PonchoConfig,
  type Conversation,
  type ConversationStore,
  type ConversationSummary,
  verifyTenantToken,
  createSecretsStore,
  computeNextOccurrence,
  loadCanonicalHistory,
  resolveRunRequest,
  createTurnDraftState,
  cloneSections,
  flushTurnDraft,
  buildAssistantMetadata,
  executeConversationTurn,
  normalizeApprovalCheckpoint,
  buildApprovalCheckpoints,
  applyTurnMetadata,
  TOOL_RESULT_ARCHIVE_PARAM,
  withToolResultArchiveParam,
  AgentOrchestrator,
} from "@poncho-ai/harness";
import type { AgentEvent, FileInput, Message, RunInput } from "@poncho-ai/sdk";
import type {
  ApiApprovalResponse,
  ApiCompactResponse,
  ApiCreateThreadResponse,
  ApiSlashCommand,
  ApiStopRunResponse,
  ApiSubagentSummary,
  ApiThreadListResponse,
  ApiThreadSummary,
} from "@poncho-ai/sdk";
import { getTextContent } from "@poncho-ai/sdk";
import {
  AgentBridge,
  ResendAdapter,
  SlackAdapter,
  TelegramAdapter,
  type AgentRunner,
  type MessagingAdapter,
  type RouteRegistrar,
} from "@poncho-ai/messaging";
import { Command } from "commander";
import dotenv from "dotenv";
import {
  LoginRateLimiter,
  SessionStore,
  getRequestIp,
  inferConversationTitle,
  parseCookies,
  renderIconSvg,
  renderManifest,
  renderServiceWorker,
  renderWebUiHtml,
  setCookie,
  verifyPassphrase,
} from "./web-ui.js";
import { buildOpenApiSpec, renderApiDocsHtml } from "./api-docs.js";
import { createLogger, formatError, setLogLevel, url, num } from "./logger.js";
import { getMascotLines } from "./mascot.js";

const log = createLogger("poncho");
const cronLog = createLogger("cron");
const reminderLog = createLogger("reminder");
const messagingLog = createLogger("messaging");
const subagentLog = createLogger("subagent");
const approvalLog = createLogger("approval");
const browserLog = createLogger("browser");
const selfFetchLog = createLogger("self-fetch");
const csrfLog = createLogger("csrf");
const uploadLog = createLogger("upload");

/**
 * Walk a sequence of harness messages and collect all tool-call ids that
 * appear, either as `tool_calls[].id` inside an assistant message's JSON
 * content, or as `toolCallId` inside the rich tool-result entries that make
 * up a tool-role message's JSON content.
 *
 * Used by the thread-fork path to filter `_toolResultArchive` down to entries
 * actually referenced by the snapshot.
 */
const collectToolCallIds = (msgs: Message[]): Set<string> => {
  const ids = new Set<string>();
  for (const m of msgs) {
    if (typeof m.content !== "string") continue;
    if (m.role === "assistant") {
      try {
        const parsed = JSON.parse(m.content) as { tool_calls?: unknown };
        if (Array.isArray(parsed.tool_calls)) {
          for (const tc of parsed.tool_calls) {
            const id = (tc as { id?: unknown } | null)?.id;
            if (typeof id === "string") ids.add(id);
          }
        }
      } catch {
        /* plain text assistant content */
      }
    } else if (m.role === "tool") {
      try {
        const parsed = JSON.parse(m.content);
        const items = Array.isArray(parsed) ? parsed : [];
        for (const it of items) {
          const id = (it as { toolCallId?: unknown } | null)?.toolCallId;
          if (typeof id === "string") ids.add(id);
        }
      } catch {
        /* unparseable tool content */
      }
    }
  }
  return ids;
};
const serverlessLog = createLogger("serverless");
import {
  type DeployTarget,
} from "./init-onboarding.js";
import {
  consumeFirstRunIntro,
} from "./init-feature-context.js";
import {
  exportOpenAICodex,
  loginOpenAICodex,
  logoutOpenAICodex,
  statusOpenAICodex,
} from "./auth-codex.js";

// ── Re-exported modules ──────────────────────────────────────────
export {
  writeJson,
  writeHtml,
  EXT_MIME_MAP,
  extToMime,
  readRequestBody,
  parseTelegramMessageThreadIdFromPlatformThreadId,
  MAX_UPLOAD_SIZE,
  type ParsedMultipart,
  parseMultipartRequest,
  resolveHarnessEnvironment,
  listenOnAvailablePort,
  readJsonFile,
  parseParams,
  formatSseEvent,
} from "./http-utils.js";
export {
  normalizeMessageForClient,
  type CronRunResult,
  runCronAgent,
  buildCronMessages,
  appendCronTurn,
  MAX_PRUNE_PER_RUN,
  pruneCronConversations,
} from "./cron-helpers.js";
export {
  AGENT_TEMPLATE,
  PACKAGE_TEMPLATE,
  README_TEMPLATE,
  ENV_TEMPLATE,
  GITIGNORE_TEMPLATE,
  TEST_TEMPLATE,
  SKILL_TEMPLATE,
  SKILL_TOOL_TEMPLATE,
  resolveLocalPackagesRoot,
  resolveCliDep,
} from "./templates.js";
export {
  ensureFile,
  normalizeDeployTarget,
  readCliVersion,
  readCliDependencyVersion,
  writeScaffoldFile,
  UPLOAD_PROVIDER_DEPS,
  ensureRuntimeCliDependency,
  checkVercelCronDrift,
  scaffoldDeployTarget,
  serializeJs,
  renderConfigFile,
  writeConfigFile,
  ensureEnvPlaceholder,
  removeEnvPlaceholder,
  packageRoot,
} from "./scaffolding.js";
export {
  initProject,
  updateAgentGuidance,
} from "./project-init.js";
export {
  runPnpmInstall,
  runInstallCommand,
  resolveInstalledPackageName,
  resolveSkillRoot,
  normalizeSkillSourceName,
  collectSkillManifests,
  validateSkillPackage,
  selectSkillManifests,
  copySkillsIntoProject,
  copySkillsFromPackage,
  addSkill,
  removeSkillsFromPackage,
  removeSkillPackage,
  listInstalledSkills,
  listSkills,
} from "./skills.js";
export {
  normalizeMcpName,
  mcpAdd,
  mcpList,
  mcpRemove,
  resolveMcpEntry,
  discoverMcpTools,
  mcpToolsList,
  mcpToolsSelect,
} from "./mcp-commands.js";
export {
  runTests,
  buildTarget,
} from "./testing.js";
export {
  runOnce,
  runInteractive,
  listTools,
} from "./run-commands.js";

// ── Internal imports from new modules (used by functions remaining in this file) ──
import {
  writeJson,
  writeHtml,
  readRequestBody,
  parseTelegramMessageThreadIdFromPlatformThreadId,
  parseMultipartRequest,
  resolveHarnessEnvironment,
  listenOnAvailablePort,
  readJsonFile,
  parseParams,
  formatSseEvent,
} from "./http-utils.js";
import {
  normalizeMessageForClient,
  runCronAgent,
  buildCronMessages,
  appendCronTurn,
  pruneCronConversations,
} from "./cron-helpers.js";
import {
  renderConfigFile,
  writeConfigFile,
  ensureEnvPlaceholder,
  removeEnvPlaceholder,
  normalizeDeployTarget,
  checkVercelCronDrift,
  scaffoldDeployTarget,
} from "./scaffolding.js";
import { initProject, updateAgentGuidance } from "./project-init.js";
import {
  addSkill,
  removeSkillPackage,
  listSkills,
} from "./skills.js";
import {
  mcpAdd,
  mcpList,
  mcpRemove,
  mcpToolsList,
  mcpToolsSelect,
} from "./mcp-commands.js";
import { runTests, buildTarget } from "./testing.js";
import { runOnce, runInteractive, listTools } from "./run-commands.js";

const __dirname = dirname(fileURLToPath(import.meta.url));


export type RequestHandler = ((
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<void>) & {
  _harness?: AgentHarness;
  _cronJobs?: Record<string, CronJobConfig>;
  _conversationStore?: ConversationStore;
  _messagingAdapters?: Map<string, MessagingAdapter>;
  _activeConversationRuns?: Map<string, { ownerId: string; abortController: AbortController; runId: string | null }>;
  _pendingCallbackNeeded?: Set<string>;
  _processSubagentCallback?: (conversationId: string, skipLockCheck?: boolean) => Promise<void>;
  _broadcastEvent?: (conversationId: string, event: AgentEvent) => void;
  _finishConversationStream?: (conversationId: string) => void;
  _checkAndFireReminders?: () => Promise<{ fired: string[]; count: number; duration: number }>;
  _reminderPollIntervalMs?: number;
  _buildTurnParameters?: (
    conversation: Conversation,
    opts?: {
      bodyParameters?: Record<string, unknown>;
      messagingMetadata?: { platform: string; sender: { id: string; name?: string | null }; threadId?: string };
    },
  ) => Record<string, unknown>;
};

export const createRequestHandler = async (options?: {
  workingDir?: string;
}): Promise<RequestHandler> => {
  const workingDir = options?.workingDir ?? process.cwd();
  dotenv.config({ path: resolve(workingDir, ".env") });
  const config = await loadPonchoConfig(workingDir);
  let agentName = "Agent";
  let agentModelProvider = "anthropic";
  let agentModelName = "claude-opus-4-5";
  let cronJobs: Record<string, CronJobConfig> = {};
  try {
    const agentMd = await readFile(resolve(workingDir, "AGENT.md"), "utf8");
    const nameMatch = agentMd.match(/^name:\s*(.+)$/m);
    const providerMatch = agentMd.match(/^\s{2}provider:\s*(.+)$/m);
    const modelMatch = agentMd.match(/^\s{2}name:\s*(.+)$/m);
    if (nameMatch?.[1]) {
      agentName = nameMatch[1].trim().replace(/^["']|["']$/g, "");
    }
    if (providerMatch?.[1]) {
      agentModelProvider = providerMatch[1].trim().replace(/^["']|["']$/g, "");
    }
    if (modelMatch?.[1]) {
      agentModelName = modelMatch[1].trim().replace(/^["']|["']$/g, "");
    }
    try {
      const parsed = parseAgentMarkdown(agentMd);
      cronJobs = parsed.frontmatter.cron ?? {};
    } catch {
      // Cron parsing failure should not block the server
    }
  } catch {}
  // Runtime state maps — will be replaced with orchestrator's maps after init.
  // Initialized here so function definitions that reference them don't cause TS errors.
  // These are reassigned to orchestrator.* below after orchestrator creation.
  let runOwners = new Map<string, string>();
  let runConversations = new Map<string, string>();
  let activeConversationRuns = new Map<string, { ownerId: string; abortController: AbortController; runId: string | null }>();
  // Per-conversation event streaming: buffer events and allow SSE subscribers
  type ConversationEventStream = {
    buffer: AgentEvent[];
    subscribers: Set<ServerResponse>;
    finished: boolean;
  };
  const conversationEventStreams = new Map<string, ConversationEventStream>();
  type EventCallback = (event: AgentEvent) => void;
  const conversationEventCallbacks = new Map<string, Set<EventCallback>>();
  // Per-conversation replay-buffer cap. Live subscribers get full events; the
  // buffer is just so a reconnecting client can catch up. Keep the most recent
  // N events to bound memory.
  const MAX_BUFFERED_EVENTS_PER_CONVERSATION = 1000;
  // Deep-clone an event with any string > 4 KB replaced by a placeholder. Used
  // when buffering for replay: a reconnecting client doesn't need fresh
  // screenshots/large blobs (they're persisted in the conversation), and
  // accumulating them caused OOMs (e.g. tool:completed for browser_screenshot
  // carries a ~134 KB base64 JPEG per call).
  const STRIP_LARGE_STRING_BYTES = 4096;
  const stripLargeStringsForBuffer = (value: unknown): unknown => {
    if (typeof value === "string") {
      return value.length > STRIP_LARGE_STRING_BYTES
        ? `[stripped-for-replay len=${value.length}]`
        : value;
    }
    if (Array.isArray(value)) return value.map(stripLargeStringsForBuffer);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = stripLargeStringsForBuffer(v);
      }
      return out;
    }
    return value;
  };
  const broadcastEvent = (conversationId: string, event: AgentEvent): void => {
    let stream = conversationEventStreams.get(conversationId);
    if (!stream) {
      stream = { buffer: [], subscribers: new Set(), finished: false };
      conversationEventStreams.set(conversationId, stream);
    }
    // browser:frame events carry base64 screenshots (~100KB each) at 10+ fps.
    // Buffering them for reconnect replay grew to multi-GB and OOM'd the process;
    // they're ephemeral like browser:status and should never replay.
    if (event.type !== "browser:frame") {
      stream.buffer.push(stripLargeStringsForBuffer(event) as AgentEvent);
      if (stream.buffer.length > MAX_BUFFERED_EVENTS_PER_CONVERSATION) {
        stream.buffer.splice(0, stream.buffer.length - MAX_BUFFERED_EVENTS_PER_CONVERSATION);
      }
    }
    for (const subscriber of stream.subscribers) {
      try {
        subscriber.write(formatSseEvent(event));
      } catch {
        stream.subscribers.delete(subscriber);
      }
    }
    const cbs = conversationEventCallbacks.get(conversationId);
    if (cbs) {
      for (const cb of cbs) {
        try { cb(event); } catch {}
      }
    }
  };
  type BrowserSessionForStatus = {
    isActiveFor: (cid: string) => boolean;
    getUrl: (cid: string) => string | undefined;
  };
  // Write a raw SSE event to all event-stream subscribers for a conversation
  // without buffering it (ephemeral events like browser:status shouldn't replay
  // on reconnect).
  const broadcastRawSse = (conversationId: string, event: string, data: unknown): void => {
    const stream = conversationEventStreams.get(conversationId);
    if (!stream) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const subscriber of stream.subscribers) {
      try {
        subscriber.write(payload);
      } catch {
        stream.subscribers.delete(subscriber);
      }
    }
  };
  const emitBrowserStatusIfActive = (
    conversationId: string,
    event: AgentEvent,
    directResponse?: ServerResponse,
  ): void => {
    const bs = harness.browserSession as BrowserSessionForStatus | undefined;
    if (
      event.type !== "tool:completed" ||
      !event.tool.startsWith("browser_") ||
      !bs?.isActiveFor(conversationId)
    ) return;
    const statusPayload = {
      active: true,
      url: bs.getUrl(conversationId) ?? null,
      interactionAllowed: true,
    };
    const raw = `event: browser:status\ndata: ${JSON.stringify(statusPayload)}\n\n`;
    if (directResponse && !directResponse.destroyed) {
      try { directResponse.write(raw); } catch {}
    }
    broadcastRawSse(conversationId, "browser:status", statusPayload);
  };
  const onConversationEvent = (conversationId: string, cb: EventCallback): (() => void) => {
    let cbs = conversationEventCallbacks.get(conversationId);
    if (!cbs) {
      cbs = new Set();
      conversationEventCallbacks.set(conversationId, cbs);
    }
    cbs.add(cb);
    return () => {
      cbs!.delete(cb);
      if (cbs!.size === 0) conversationEventCallbacks.delete(conversationId);
    };
  };
  const finishConversationStream = (conversationId: string): void => {
    const stream = conversationEventStreams.get(conversationId);
    if (stream) {
      stream.finished = true;
      for (const subscriber of stream.subscribers) {
        try {
          subscriber.write("event: stream:end\ndata: {}\n\n");
          subscriber.end();
        } catch {
          // Already closed.
        }
      }
      stream.subscribers.clear();
      // Keep buffer for a short time so late-joining clients get replay
      setTimeout(() => conversationEventStreams.delete(conversationId), 30_000);
    }
  };
  const clearPendingApprovalsForConversation = async (conversationId: string): Promise<void> => {
    const conversation = await conversationStore.get(conversationId);
    if (!conversation) return;
    if (Array.isArray(conversation.pendingApprovals) && conversation.pendingApprovals.length > 0) {
      conversation.pendingApprovals = [];
      await conversationStore.update(conversation);
    }
  };
  const uploadStore = await createUploadStore(config?.uploads, workingDir);
  const harness = new AgentHarness({
    workingDir,
    environment: resolveHarnessEnvironment(),
    uploadStore,
  });
  await harness.initialize();
  const telemetry = new TelemetryEmitter(config?.telemetry);
  const identity = await ensureAgentIdentity(workingDir);
  const stateConfig = resolveStateConfig(config);
  if (!harness.storageEngine) {
    log.warn(
      "harness.storageEngine is undefined — outdated @poncho-ai/harness (< 0.37.0) likely installed.",
    );
    log.warn("falling back to in-memory storage — conversations will NOT be persisted.");
    log.warn("fix: `pnpm up @poncho-ai/harness@latest` or add a pnpm.overrides entry.");
  }
  const conversationStore = harness.storageEngine
    ? createConversationStoreFromEngine(harness.storageEngine)
    : createConversationStore(stateConfig, { workingDir, agentId: identity.id });

  // ── Orchestrator ──────────────────────────────────────────────────────────
  const orchestrator = new AgentOrchestrator({
    harness,
    conversationStore,
    eventSink: (conversationId, event) => broadcastEvent(conversationId, event),
    telemetry,
    agentId: identity.id,
    workingDir,
    hooks: {
      onContinuationStart(conversationId) {
        const prevStream = conversationEventStreams.get(conversationId);
        if (prevStream) {
          prevStream.finished = false;
          prevStream.buffer = [];
        } else {
          conversationEventStreams.set(conversationId, {
            buffer: [],
            subscribers: new Set(),
            finished: false,
          });
        }
      },
      onContinuationEnd(conversationId) {
        finishConversationStream(conversationId);
      },
      onApprovalCheckpoint(conversationId, approvals) {
        // Telegram approval notification
        const conv = conversationStore.get(conversationId).then(c => {
          if (!c?.channelMeta || c.channelMeta.platform !== "telegram") return;
          const tgAdapter = messagingAdapters.get("telegram") as TelegramAdapter | undefined;
          if (!tgAdapter) return;
          const messageThreadId = parseTelegramMessageThreadIdFromPlatformThreadId(
            c.channelMeta.platformThreadId,
            c.channelMeta.channelId,
          );
          void tgAdapter.sendApprovalRequest(
            c.channelMeta.channelId,
            approvals,
            { message_thread_id: messageThreadId },
          ).catch(() => {});
        });
        void conv;
      },
      // ── Subagent hooks ──
      async createChildHarness() {
        const childHarness = new AgentHarness({
          workingDir,
          environment: resolveHarnessEnvironment(),
          uploadStore,
        });
        await childHarness.initialize();
        return childHarness;
      },
      buildRecallParams: (opts) => buildRecallParams(opts),
      dispatchBackground(type, conversationId) {
        const urlMap = {
          "subagent-run": `/api/internal/subagent/${encodeURIComponent(conversationId)}/run`,
          "subagent-callback": `/api/internal/conversations/${encodeURIComponent(conversationId)}/subagent-callback`,
          "continuation": `/api/internal/continue/${encodeURIComponent(conversationId)}`,
        };
        const work = selfFetchWithRetry(urlMap[type]).catch(err =>
          createLogger("dispatch").error(`${type} self-fetch failed for ${conversationId.slice(0, 8)}: ${formatError(err)}`),
        );
        doWaitUntil(work);
      },
      onStreamEnd(conversationId) {
        finishConversationStream(conversationId);
      },
      onCallbackStreamReset(conversationId) {
        const prevStream = conversationEventStreams.get(conversationId);
        if (prevStream) {
          prevStream.finished = false;
          prevStream.buffer = [];
        } else {
          conversationEventStreams.set(conversationId, {
            buffer: [],
            subscribers: new Set(),
            finished: false,
          });
        }
      },
      onMessagingNotify(conversationId, text) {
        conversationStore.get(conversationId).then(conv => {
          if (!conv?.channelMeta) return;
          const adapter = messagingAdapters.get(conv.channelMeta.platform);
          if (!adapter) return;
          adapter.sendReply(
            {
              channelId: conv.channelMeta.channelId,
              platformThreadId: conv.channelMeta.platformThreadId,
            },
            text,
          ).catch(sendErr =>
            subagentLog.error(`callback messaging notify failed: ${formatError(sendErr)}`),
          );
        });
      },
    },
  });
  // Redirect local aliases to orchestrator-owned maps/methods
  runOwners = orchestrator.runOwners;
  runConversations = orchestrator.runConversations;
  activeConversationRuns = orchestrator.activeConversationRuns;
  const approvalDecisionTracker = orchestrator.approvalDecisionTracker;
  const findPendingApproval = orchestrator.findPendingApproval.bind(orchestrator);
  const resumeRunFromCheckpoint = orchestrator.resumeRunFromCheckpoint.bind(orchestrator);
  const activeSubagentRuns = orchestrator.activeSubagentRuns;
  const pendingSubagentApprovals = orchestrator.pendingSubagentApprovals;
  const pendingCallbackNeeded = orchestrator.pendingCallbackNeeded;
  const processSubagentCallback = orchestrator.processSubagentCallback.bind(orchestrator);
  const hasPendingSubagentWorkForParent = orchestrator.hasPendingSubagentWorkForParent.bind(orchestrator);
  const hasRunningSubagentsForParent = (parentId: string, _owner: string) => orchestrator.hasRunningSubagentsForParent(parentId);

  // Set up SubagentManager
  const subagentManager = orchestrator.createSubagentManager();
  harness.setSubagentManager(subagentManager);

  // ---------------------------------------------------------------------------
  // Conversation recall parameter builders — shared between main and subagent runs
  // ---------------------------------------------------------------------------
  const buildRecallParams = (opts: { ownerId: string; tenantId?: string | null; excludeConversationId: string }) => {
    let cachedRecallCorpus: unknown[] | undefined;
    const lazyRecallCorpus = async () => {
      if (cachedRecallCorpus) return cachedRecallCorpus;
      const _rc0 = performance.now();
      let recallConversations: Conversation[];
      if (typeof conversationStore.listSummaries === "function") {
        const recallSummaries = (await conversationStore.listSummaries(opts.ownerId, opts.tenantId))
          .filter((s) => s.conversationId !== opts.excludeConversationId && !s.parentConversationId)
          .slice(0, 20);
        recallConversations = (
          await Promise.all(recallSummaries.map((s) => conversationStore.get(s.conversationId)))
        ).filter((c): c is NonNullable<typeof c> => c != null);
      } else {
        recallConversations = (await conversationStore.list(opts.ownerId, opts.tenantId))
          .filter((item) => item.conversationId !== opts.excludeConversationId && !item.parentConversationId)
          .slice(0, 20);
      }
      cachedRecallCorpus = recallConversations
        .map((item) => ({
          conversationId: item.conversationId,
          title: item.title,
          updatedAt: item.updatedAt,
          content: item.messages
            .slice(-6)
            .map((message) => `${message.role}: ${typeof message.content === "string" ? message.content : getTextContent(message)}`)
            .join("\n")
            .slice(0, 2000),
        }))
        .filter((item) => item.content.length > 0);
      log.debug(`recall corpus fetched lazily (${cachedRecallCorpus.length} items, ${(performance.now() - _rc0).toFixed(1)}ms)`);
      return cachedRecallCorpus;
    };

    const conversationListFn = async () => {
      const summaries = typeof conversationStore.listSummaries === "function"
        ? await conversationStore.listSummaries(opts.ownerId, opts.tenantId)
        : (await conversationStore.list(opts.ownerId, opts.tenantId)).map((c) => ({
            conversationId: c.conversationId,
            title: c.title,
            updatedAt: c.updatedAt,
            createdAt: c.createdAt,
            ownerId: c.ownerId,
            parentConversationId: c.parentConversationId,
            messageCount: c.messages.length,
          }));
      return summaries
        .filter((s) => s.conversationId !== opts.excludeConversationId && !s.parentConversationId)
        .map((s) => ({
          conversationId: s.conversationId,
          title: s.title,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          messageCount: s.messageCount,
        }));
    };

    const conversationFetchFn = async (targetId: string) => {
      const conv = await conversationStore.get(targetId);
      if (!conv) return undefined;
      return {
        conversationId: conv.conversationId,
        title: conv.title,
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt,
        messages: conv.messages
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({
            role: m.role,
            content: typeof m.content === "string" ? m.content : getTextContent(m),
          })),
      };
    };

    return {
      __conversationRecallCorpus: lazyRecallCorpus,
      __conversationListFn: conversationListFn,
      __conversationFetchFn: conversationFetchFn,
    };
  };

  // ---------------------------------------------------------------------------
  // Single helper for assembling runInput.parameters across every turn entry
  // point (HTTP route, messaging adapter, cron, reminder). All `__`-prefixed
  // context params live here so adding a new one only requires one edit.
  // ---------------------------------------------------------------------------
  const buildTurnParameters = (
    conversation: Conversation,
    opts: {
      bodyParameters?: Record<string, unknown>;
      messagingMetadata?: {
        platform: string;
        sender: { id: string; name?: string | null };
        threadId?: string;
      };
    } = {},
  ): Record<string, unknown> => {
    return withToolResultArchiveParam({
      ...(opts.bodyParameters ?? {}),
      ...buildRecallParams({
        ownerId: conversation.ownerId,
        tenantId: conversation.tenantId,
        excludeConversationId: conversation.conversationId,
      }),
      ...(opts.messagingMetadata ? {
        __messaging_platform: opts.messagingMetadata.platform,
        __messaging_sender_id: opts.messagingMetadata.sender.id,
        __messaging_sender_name: opts.messagingMetadata.sender.name ?? "",
        __messaging_thread_id: opts.messagingMetadata.threadId,
      } : {}),
      __activeConversationId: conversation.conversationId,
      __ownerId: conversation.ownerId,
    }, conversation);
  };

  // Subagent lifecycle extracted to AgentOrchestrator (Phase 5).

  // ---------------------------------------------------------------------------
  // Messaging adapters (Slack, etc.) — routes bypass Poncho auth; each
  // adapter handles its own request verification (e.g. Slack signing secret).
  // ---------------------------------------------------------------------------
  const messagingRoutes = new Map<string, Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>>();
  const messagingRouteRegistrar: RouteRegistrar = (method, path, routeHandler) => {
    let byMethod = messagingRoutes.get(path);
    if (!byMethod) {
      byMethod = new Map();
      messagingRoutes.set(path, byMethod);
    }
    byMethod.set(method, routeHandler);
  };

  const messagingRunner: AgentRunner = {
    async getOrCreateConversation(conversationId, meta) {
      const existing = await conversationStore.get(conversationId);
      if (existing) {
        if (!existing.channelMeta && meta.channelId) {
          existing.channelMeta = {
            platform: meta.platform,
            channelId: meta.channelId,
            platformThreadId: meta.platformThreadId ?? meta.channelId,
          };
          await conversationStore.update(existing);
        }
        return { messages: loadCanonicalHistory(existing).messages };
      }
      const now = Date.now();
      const channelMeta = meta.channelId
        ? {
            platform: meta.platform,
            channelId: meta.channelId,
            platformThreadId: meta.platformThreadId ?? meta.channelId,
          }
        : undefined;
      const conversation = {
        conversationId,
        title: meta.title ?? `${meta.platform} thread`,
        messages: [] as Message[],
        ownerId: meta.ownerId,
        tenantId: null,
        channelMeta,
        createdAt: now,
        updatedAt: now,
      };
      await conversationStore.update(conversation);
      return { messages: [] };
    },
    async run(conversationId, input) {
      // getWithArchive — latestConversation feeds withToolResultArchiveParam.
      const latestConversation = await conversationStore.getWithArchive(conversationId);
      const canonicalHistory = latestConversation
        ? loadCanonicalHistory(latestConversation)
        : { messages: [...input.messages], source: "messages" as const };
      const shouldRebuildCanonical = canonicalHistory.source !== "harness";

      const isContinuation = input.task == null;
      messagingLog.info(
        `run start ${conversationId.slice(0, 8)} ` +
        `${isContinuation ? "(continuation)" : `task="${input.task!.slice(0, 60)}"`} ` +
        `history=${canonicalHistory.source}`,
      );

      const historyMessages = [...canonicalHistory.messages];
      const preRunMessages = [...canonicalHistory.messages];
      const userContent = input.task;

      // Hoist stable ids for this turn — reused across every buildMessages()
      // call so the in-flight assistant message has a stable metadata.id.
      const turnTimestamp = Date.now();
      const userMessage: Message | undefined = userContent != null
        ? {
            role: "user" as const,
            content: userContent,
            metadata: { id: randomUUID(), timestamp: turnTimestamp },
          }
        : undefined;
      const assistantId = randomUUID();

      // Read-modify-write helper: always fetches the latest version from
      // the store before writing, so concurrent writers don't get clobbered.
      const updateConversation = async (
        patch: (conv: Conversation) => void,
      ): Promise<void> => {
        const fresh = await conversationStore.get(conversationId);
        if (!fresh) return;
        patch(fresh);
        fresh.updatedAt = Date.now();
        await conversationStore.update(fresh);
      };

      await updateConversation((c) => {
        if (!isContinuation) {
          c.messages = [...historyMessages, ...(userMessage ? [userMessage] : [])];
        }
        c.runStatus = "running";
      });

      let latestRunId = "";
      const draft = createTurnDraftState();
      let checkpointedRun = false;
      let checkpointTextAlreadySent = false;
      let runContextTokens = 0;
      let runContextWindow = 0;
      let runContinuation = false;
      let runContinuationMessages: Message[] | undefined;
      let runSteps = 0;
      let runMaxSteps: number | undefined;

      const buildMessages = (): Message[] => {
        const draftSections = cloneSections(draft.sections);
        if (draft.currentTools.length > 0) {
          draftSections.push({ type: "tools", content: [...draft.currentTools] });
        }
        if (draft.currentText.length > 0) {
          draftSections.push({ type: "text", content: draft.currentText });
        }
        const userTurn: Message[] = userMessage ? [userMessage] : [];
        const hasDraftContent =
          draft.assistantResponse.length > 0 || draft.toolTimeline.length > 0 || draftSections.length > 0;
        if (!hasDraftContent) {
          return [...historyMessages, ...userTurn];
        }
        return [
          ...historyMessages,
          ...userTurn,
          {
            role: "assistant" as const,
            content: draft.assistantResponse,
            metadata: buildAssistantMetadata(draft, draftSections, { id: assistantId, timestamp: turnTimestamp }),
          },
        ];
      };

      const persistDraftAssistantTurn = async (): Promise<void> => {
        if (draft.assistantResponse.length === 0 && draft.toolTimeline.length === 0) return;
        await updateConversation((c) => {
          c.messages = buildMessages();
        });
      };

      const runInput = {
        task: input.task,
        conversationId,
        tenantId: latestConversation?.tenantId ?? undefined,
        messages: historyMessages,
        files: input.files,
        parameters: latestConversation
          ? buildTurnParameters(latestConversation, {
              messagingMetadata: input.metadata,
            })
          : withToolResultArchiveParam({
              ...(input.metadata ? {
                __messaging_platform: input.metadata.platform,
                __messaging_sender_id: input.metadata.sender.id,
                __messaging_sender_name: input.metadata.sender.name ?? "",
                __messaging_thread_id: input.metadata.threadId,
              } : {}),
              __activeConversationId: conversationId,
            }, { _toolResultArchive: {} } as Conversation),
      };

      try {
        const execution = await executeConversationTurn({
          harness,
          runInput,
          onEvent: async (event, eventDraft) => {
            draft.assistantResponse = eventDraft.assistantResponse;
            draft.toolTimeline = eventDraft.toolTimeline;
            draft.sections = eventDraft.sections;
            draft.currentTools = eventDraft.currentTools;
            draft.currentText = eventDraft.currentText;
            if (event.type === "run:started") {
              latestRunId = event.runId;
              runOwners.set(event.runId, "local-owner");
              runConversations.set(event.runId, conversationId);
            }
          if (event.type === "step:completed") {
            await persistDraftAssistantTurn();
          }
          if (event.type === "tool:approval:required") {
            const toolText = `- approval required \`${event.tool}\``;
            draft.toolTimeline.push(toolText);
            draft.currentTools.push(toolText);
            await persistDraftAssistantTurn();
          }
          if (event.type === "tool:approval:checkpoint") {
            await updateConversation((c) => {
              c.messages = buildMessages();
              c.pendingApprovals = buildApprovalCheckpoints({
                approvals: event.approvals,
                runId: latestRunId,
                checkpointMessages: event.checkpointMessages,
                baseMessageCount: historyMessages.length,
                pendingToolCalls: event.pendingToolCalls,
              });
            });
            checkpointedRun = true;

            const conv = await conversationStore.get(conversationId);
            if (conv?.channelMeta?.platform === "telegram") {
              const tgAdapter = messagingAdapters.get("telegram") as TelegramAdapter | undefined;
              if (tgAdapter) {
                const threadRef: import("@poncho-ai/messaging").ThreadRef = {
                  channelId: conv.channelMeta.channelId,
                  platformThreadId: conv.channelMeta.platformThreadId,
                };

                // Send accumulated text BEFORE approval buttons so Telegram
                // shows them in the natural order (text → approval request).
                const pendingText = draft.assistantResponse.trim();
                if (pendingText) {
                  try {
                    await tgAdapter.sendReply(threadRef, pendingText);
                    checkpointTextAlreadySent = true;
                  } catch (err: unknown) {
                    messagingLog.error(`failed to send pre-approval text: ${formatError(err)}`);
                  }
                }

                const approvals = event.approvals.map(a => ({
                  approvalId: a.approvalId,
                  tool: a.tool,
                  input: a.input,
                }));
                const messageThreadId = parseTelegramMessageThreadIdFromPlatformThreadId(
                  conv.channelMeta.platformThreadId,
                  conv.channelMeta.channelId,
                );
                void tgAdapter.sendApprovalRequest(
                  conv.channelMeta.channelId,
                  approvals,
                  { message_thread_id: messageThreadId },
                ).catch((err: unknown) => {
                  messagingLog.error(`failed to send telegram approval request: ${formatError(err)}`);
                });
              }
            }
          }
          if (event.type === "compaction:completed") {
            if (event.compactedMessages) {
              historyMessages.length = 0;
              historyMessages.push(...event.compactedMessages);

              const preservedFromHistory = historyMessages.length - 1;
              const removedCount = preRunMessages.length - Math.max(0, preservedFromHistory);
              await updateConversation((c) => {
                const existingHistory = c.compactedHistory ?? [];
                c.compactedHistory = [
                  ...existingHistory,
                  ...preRunMessages.slice(0, removedCount),
                ];
              });
            }
          }
            broadcastEvent(conversationId, event);
          },
        });
        runContinuation = execution.runContinuation;
        runContinuationMessages = execution.runContinuationMessages;
        runSteps = execution.runSteps;
        runMaxSteps = execution.runMaxSteps;
        runContextTokens = execution.runContextTokens;
        runContextWindow = execution.runContextWindow;
        latestRunId = execution.latestRunId || latestRunId;
      } catch (err) {
        messagingLog.error(`run failed: ${formatError(err)}`);
        draft.assistantResponse = draft.assistantResponse || `[Error: ${err instanceof Error ? err.message : "Unknown error"}]`;
      }

      flushTurnDraft(draft);

      if (!checkpointedRun) {
        await updateConversation((c) => {
          if (!(runContinuation && runContinuationMessages)) {
            c.messages = buildMessages();
          }
          applyTurnMetadata(c, {
            latestRunId,
            contextTokens: runContextTokens,
            contextWindow: runContextWindow,
            continuation: runContinuation,
            continuationMessages: runContinuationMessages,
            harnessMessages: runContinuationMessages,
            toolResultArchive: harness.getToolResultArchive(conversationId),
          }, { shouldRebuildCanonical: true });
        });
      } else {
        await updateConversation((c) => {
          applyTurnMetadata(c, {
            latestRunId: "",
            contextTokens: 0,
            contextWindow: 0,
            toolResultArchive: harness.getToolResultArchive(conversationId),
          }, {
            clearContinuation: false,
            clearApprovals: false,
            shouldRebuildCanonical: shouldRebuildCanonical && !c._harnessMessages?.length,
          });
        });
      }
      finishConversationStream(conversationId);
      if (latestRunId) {
        runOwners.delete(latestRunId);
        runConversations.delete(latestRunId);
      }

      const response = checkpointTextAlreadySent ? "" : draft.assistantResponse;
      const flags = [
        checkpointTextAlreadySent ? "checkpoint-sent" : null,
        runContinuation ? "continuation" : null,
      ].filter(Boolean).join(", ");
      messagingLog.success(
        `run complete (response ${response.length} chars${flags ? `, ${flags}` : ""})`,
      );

      return {
        response,
        continuation: runContinuation,
        steps: runSteps,
        maxSteps: runMaxSteps,
      };
    },
    async resetConversation(conversationId) {
      const existing = await conversationStore.get(conversationId);
      if (!existing) return;
      // Archive the old conversation under a unique ID so it stays
      // viewable in the web UI. The original ID is freed for a fresh one.
      const archiveId = `${conversationId}_${Date.now()}`;
      const archived = { ...existing, conversationId: archiveId };
      const datePart = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" });
      if (archived.title) archived.title = `${archived.title} (${datePart})`;
      archived.updatedAt = Date.now();
      await conversationStore.update(archived);
      await conversationStore.delete(conversationId);
      messagingLog.item(`conversation archived: ${conversationId.slice(0, 8)} → ${archiveId.slice(0, 16)}`);
    },
  };

  let waitUntilHook: ((promise: Promise<unknown>) => void) | undefined;
  if (process.env.VERCEL) {
    try {
      const modName = "@vercel/functions";
      const mod = await import(/* webpackIgnore: true */ modName);
      waitUntilHook = mod.waitUntil;
    } catch {
      // @vercel/functions not installed -- fall through to no-op.
    }
  }

  const isServerless = !!waitUntilHook;
  // Only provide dispatchBackground in serverless mode so the orchestrator
  // calls methods directly in long-lived mode.
  if (!isServerless && orchestrator.hooks) {
    orchestrator.hooks.dispatchBackground = undefined;
  }
  const configuredInternalSecret = process.env.PONCHO_INTERNAL_SECRET?.trim();
  const vercelDeploymentSecret = process.env.VERCEL_DEPLOYMENT_ID?.trim();
  const fallbackInternalSecret = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  const internalSecret = configuredInternalSecret || vercelDeploymentSecret || fallbackInternalSecret;
  const isUsingEphemeralInternalSecret = !configuredInternalSecret && !vercelDeploymentSecret;
  let selfBaseUrl: string | null = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : null;

  if (!selfBaseUrl && process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    selfBaseUrl = `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (!selfBaseUrl && process.env.PONCHO_SELF_BASE_URL) {
    selfBaseUrl = process.env.PONCHO_SELF_BASE_URL.replace(/\/+$/, "");
  }

  if (isServerless && isUsingEphemeralInternalSecret) {
    serverlessLog.warn(
      "no stable internal secret. Set PONCHO_INTERNAL_SECRET to avoid intermittent internal callback failures.",
    );
  }
  if (isServerless && !selfBaseUrl) {
    serverlessLog.warn(
      "no self base URL available. Set PONCHO_SELF_BASE_URL if internal background callbacks fail.",
    );
  }
  const stateProvider = stateConfig?.provider ?? "local";
  if (isServerless && (stateProvider === "local" || stateProvider === "memory")) {
    serverlessLog.warn(
      `state.provider="${stateProvider}" may lose cross-invocation state. Prefer "upstash", "redis", or "dynamodb".`,
    );
  }

  const doWaitUntil = (promise: Promise<unknown>): void => {
    if (waitUntilHook) waitUntilHook(promise);
  };

  const vercelBypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
  if (process.env.VERCEL && !vercelBypassSecret) {
    log.warn("Vercel Deployment Protection will block subagents and auto-continuation.");
    log.warn("  enable 'Protection Bypass for Automation' in Project Settings > Deployment Protection.");
    log.warn("  the secret is auto-provisioned as VERCEL_AUTOMATION_BYPASS_SECRET.");
  }
  const hasCronJobs = Object.keys(cronJobs).length > 0;
  const authTokenConfigured = !!(process.env[config?.auth?.tokenEnv ?? "PONCHO_AUTH_TOKEN"]) && (config?.auth?.required ?? false);
  if (process.env.VERCEL && hasCronJobs && authTokenConfigured && !process.env.CRON_SECRET) {
    cronLog.warn("CRON_SECRET is not set but cron jobs are configured.");
    cronLog.warn("  Vercel sends CRON_SECRET as a Bearer token when invoking cron endpoints.");
    cronLog.warn("  set CRON_SECRET to match PONCHO_AUTH_TOKEN, or invocations will be rejected with 401.");
  }

  const selfFetchWithRetry = async (path: string, body?: Record<string, unknown>, retries = 3): Promise<Response | void> => {
    if (!selfBaseUrl) {
      selfFetchLog.error(`missing self base URL for ${path}`);
      return;
    }
    let lastError: unknown;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "x-poncho-internal": internalSecret,
        };
        if (vercelBypassSecret) {
          headers["x-vercel-protection-bypass"] = vercelBypassSecret;
        }
        const result = await fetch(`${selfBaseUrl}${path}`, {
          method: "POST",
          headers,
          body: body ? JSON.stringify(body) : undefined,
        });
        if (result.ok) {
          return result;
        }
        const responseText = await result.text().catch(() => "");
        lastError = new Error(
          `HTTP ${result.status}${responseText ? `: ${responseText.slice(0, 200)}` : ""}`,
        );
      } catch (err) {
        lastError = err;
      }
      if (attempt === retries - 1) {
        break;
      }
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 1000 * (attempt + 1)));
    }
    if (lastError) {
      selfFetchLog.error(
        `failed ${path} after ${retries} attempt(s): ${formatError(lastError)}`,
      );
      if (
        lastError instanceof Error
        && (lastError.message.includes("HTTP 403") || lastError.message.includes("HTTP 401"))
      ) {
        if (lastError.message.includes("HTTP 401") && lastError.message.includes("<!doctype")) {
          selfFetchLog.error(
            "blocked by Vercel Deployment Protection. Set VERCEL_AUTOMATION_BYPASS_SECRET in your Vercel project.",
          );
        } else {
          selfFetchLog.error(
            "internal auth failed. Ensure all serverless instances share PONCHO_INTERNAL_SECRET.",
          );
        }
      }
    } else {
      selfFetchLog.error(`failed ${path} after ${retries} attempt(s)`);
    }
  };

  const getInternalRequestHeader = (headers: IncomingMessage["headers"]): string | undefined => {
    const value = headers["x-poncho-internal"];
    return Array.isArray(value) ? value[0] : value;
  };

  const isValidInternalRequest = (headers: IncomingMessage["headers"]): boolean => {
    const headerValue = getInternalRequestHeader(headers);
    return typeof headerValue === "string" && headerValue === internalSecret;
  };

  // ── Unified continuation ──────────────────────────────────────────────
  // runContinuation and runChatContinuation are now handled by the orchestrator.
  // This local function delegates to orchestrator.runContinuation().
  async function runContinuation(
    conversationId: string,
    onYield?: (event: AgentEvent) => void | Promise<void>,
  ): Promise<void> {
    return orchestrator.runContinuation(conversationId, onYield);
  }


  const messagingAdapters = new Map<string, MessagingAdapter>();
  const messagingBridges: AgentBridge[] = [];
  if (config?.messaging && config.messaging.length > 0) {
    for (const channelConfig of config.messaging) {
      if (channelConfig.platform === "slack") {
        const adapter = new SlackAdapter({
          botTokenEnv: channelConfig.botTokenEnv,
          signingSecretEnv: channelConfig.signingSecretEnv,
        });
        const bridge = new AgentBridge({
          adapter,
          runner: messagingRunner,
          waitUntil: waitUntilHook,
          ownerId: "local-owner",
        });
        try {
          await bridge.start();
          adapter.registerRoutes(messagingRouteRegistrar);
          messagingBridges.push(bridge);
          messagingAdapters.set("slack", adapter);
          createLogger("slack").item("enabled at /api/messaging/slack");
        } catch (err) {
          createLogger("slack").warn(`disabled: ${formatError(err)}`);
        }
      } else if (channelConfig.platform === "resend") {
        const adapter = new ResendAdapter({
          apiKeyEnv: channelConfig.apiKeyEnv,
          webhookSecretEnv: channelConfig.webhookSecretEnv,
          fromEnv: channelConfig.fromEnv,
          replyToEnv: channelConfig.replyToEnv,
          allowedSenders: channelConfig.allowedSenders,
          mode: channelConfig.mode,
          allowedRecipients: channelConfig.allowedRecipients,
          maxSendsPerRun: channelConfig.maxSendsPerRun,
        });
        const bridge = new AgentBridge({
          adapter,
          runner: messagingRunner,
          waitUntil: waitUntilHook,
          ownerId: "local-owner",
        });
        try {
          await bridge.start();
          adapter.registerRoutes(messagingRouteRegistrar);
          messagingBridges.push(bridge);
          messagingAdapters.set("resend", adapter);
          const adapterTools = adapter.getToolDefinitions?.() ?? [];
          if (adapterTools.length > 0) {
            harness.registerTools(adapterTools);
          }
          const modeLabel = channelConfig.mode === "tool" ? "tool" : "auto-reply";
          createLogger("resend").item(`enabled at /api/messaging/resend (mode: ${modeLabel})`);
        } catch (err) {
          createLogger("resend").warn(`disabled: ${formatError(err)}`);
        }
      } else if (channelConfig.platform === "telegram") {
        const adapter = new TelegramAdapter({
          botTokenEnv: channelConfig.botTokenEnv,
          webhookSecretEnv: channelConfig.webhookSecretEnv,
          allowedUserIds: channelConfig.allowedUserIds,
        });
        const bridge = new AgentBridge({
          adapter,
          runner: messagingRunner,
          waitUntil: waitUntilHook,
          ownerId: "local-owner",
        });
        adapter.onApprovalDecision(async (approvalId: string, approved: boolean, _chatId: string) => {
          // Check subagent approvals first
          const pendingSubagent = pendingSubagentApprovals.get(approvalId);
          if (pendingSubagent) {
            await adapter.updateApprovalMessage(approvalId, approved ? "approved" : "denied", pendingSubagent.checkpoint.tool);
            await orchestrator.submitSubagentApprovalDecision(approvalId, approved);
            return;
          }

          // Regular (non-subagent) approval
          const found = await findPendingApproval(approvalId, "local-owner");
          let foundConversation = found?.conversation;
          const foundApproval = found?.approval;

          if (!foundConversation || !foundApproval) {
            approvalLog.warn(`telegram approval not found: ${approvalId}`);
            return;
          }

          const approvalDecision = approved ? "approved" as const : "denied" as const;
          await adapter.updateApprovalMessage(approvalId, approvalDecision, foundApproval.tool);

          foundConversation.pendingApprovals = (foundConversation.pendingApprovals ?? []).map((approval) =>
            approval.approvalId === approvalId
              ? { ...normalizeApprovalCheckpoint(approval, foundConversation!.messages), decision: approvalDecision }
              : normalizeApprovalCheckpoint(approval, foundConversation!.messages),
          );
          await conversationStore.update(foundConversation);

          broadcastEvent(foundConversation.conversationId,
            approved
              ? { type: "tool:approval:granted", approvalId }
              : { type: "tool:approval:denied", approvalId },
          );

          const refreshedConversation = await conversationStore.get(foundConversation.conversationId);
          const allApprovals = (refreshedConversation?.pendingApprovals ?? []).map((approval) =>
            normalizeApprovalCheckpoint(approval, refreshedConversation!.messages),
          );
          const allDecided = allApprovals.length > 0 && allApprovals.every(a => a.decision != null);

          if (!allDecided) {
            return;
          }
          foundConversation = refreshedConversation!;

          // All decided — resume the run
          const conversationId = foundConversation.conversationId;
          const checkpointRef = allApprovals[0]!;
          foundConversation.pendingApprovals = [];
          foundConversation.runStatus = "running";
          await conversationStore.update(foundConversation);

          const prevStream = conversationEventStreams.get(conversationId);
          if (prevStream) {
            prevStream.finished = false;
            prevStream.buffer = [];
          } else {
            conversationEventStreams.set(conversationId, {
              buffer: [],
              subscribers: new Set(),
              finished: false,
            });
          }

          const resumeWork = (async () => {
            let stopTyping: (() => Promise<void>) | undefined;
            try {
              const threadRef: import("@poncho-ai/messaging").ThreadRef = {
                platformThreadId: foundConversation!.channelMeta!.platformThreadId,
                channelId: foundConversation!.channelMeta!.channelId,
              };
              stopTyping = await adapter.indicateProcessing(threadRef);

              const toolContext = {
                runId: checkpointRef.runId,
                agentId: identity.id,
                step: 0,
                workingDir,
                parameters: {},
              };

              const approvalToolCallIds = new Set(allApprovals.map(a => a.toolCallId));
              const callsToExecute: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
              const deniedResults: Array<{ callId: string; toolName: string; error: string }> = [];

              for (const a of allApprovals) {
                if (a.decision === "approved" && a.toolCallId) {
                  callsToExecute.push({ id: a.toolCallId, name: a.tool, input: a.input });
                } else if (a.decision === "denied" && a.toolCallId) {
                  deniedResults.push({ callId: a.toolCallId, toolName: a.tool, error: "Tool execution denied by user" });
                }
              }

              const pendingToolCalls = checkpointRef.pendingToolCalls ?? [];
              for (const tc of pendingToolCalls) {
                if (!approvalToolCallIds.has(tc.id)) callsToExecute.push(tc);
              }

              let toolResults: Array<{ callId: string; toolName: string; result?: unknown; error?: string }> = [...deniedResults];
              if (callsToExecute.length > 0) {
                const execResults = await harness.executeTools(callsToExecute, toolContext);
                toolResults.push(...execResults.map(r => ({
                  callId: r.callId,
                  toolName: r.tool,
                  result: r.output,
                  error: r.error,
                })));
              }

              // Capture pre-resume text length so we only send new content
              const preResumeConv = await conversationStore.get(conversationId);
              const preResumeLastMsg = preResumeConv?.messages[preResumeConv.messages.length - 1];
              const preResumeTextLength = preResumeLastMsg?.role === "assistant" && typeof preResumeLastMsg.content === "string"
                ? preResumeLastMsg.content.length
                : 0;

              await resumeRunFromCheckpoint(
                conversationId,
                foundConversation!,
                checkpointRef,
                toolResults,
              );

              // Send only the NEW text produced by the resumed run to Telegram
              const updatedConv = await conversationStore.get(conversationId);
              if (updatedConv?.channelMeta?.platform === "telegram") {
                const lastMsg = updatedConv.messages[updatedConv.messages.length - 1];
                const fullText = lastMsg?.role === "assistant" && typeof lastMsg.content === "string"
                  ? lastMsg.content
                  : "";
                const newText = fullText.slice(preResumeTextLength).trim();
                if (newText) {
                  await adapter.sendReply(threadRef, newText);
                }
              }
            } catch (err) {
              approvalLog.error(`telegram approval resume failed: ${formatError(err)}`);
              const conv = await conversationStore.get(conversationId);
              if (conv) {
                conv.runStatus = "idle";
                conv.updatedAt = Date.now();
                await conversationStore.update(conv);
              }
            } finally {
              if (stopTyping) await stopTyping().catch(() => {});
            }
          })();
          if (waitUntilHook) {
            waitUntilHook(resumeWork);
          }
        });

        try {
          await bridge.start();
          adapter.registerRoutes(messagingRouteRegistrar);
          messagingBridges.push(bridge);
          messagingAdapters.set("telegram", adapter);
          createLogger("telegram").item("enabled at /api/messaging/telegram");
        } catch (err) {
          createLogger("telegram").warn(`disabled: ${formatError(err)}`);
        }
      }
    }
  }

  const sessionStore = new SessionStore();
  const loginRateLimiter = new LoginRateLimiter();

  const authTokenEnv = config?.auth?.tokenEnv ?? "PONCHO_AUTH_TOKEN";
  const authToken = process.env[authTokenEnv] ?? "";
  const authRequired = config?.auth?.required ?? false;
  const requireAuth = authRequired && authToken.length > 0;

  if (requireAuth) {
    sessionStore.setSigningKey(authToken);
  }

  const webUiEnabled = config?.webUi !== false;
  const isProduction = resolveHarnessEnvironment() === "production";
  const secureCookies = isProduction;

  const handler: RequestHandler = async (request: IncomingMessage, response: ServerResponse) => {
    if (!request.url || !request.method) {
      writeJson(response, 404, { error: "Not found" });
      return;
    }
    const [pathname] = request.url.split("?");
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (!selfBaseUrl && request.headers.host) {
      const proto = (request.headers["x-forwarded-proto"] as string | undefined) ?? (isProduction ? "https" : "http");
      selfBaseUrl = `${proto}://${request.headers.host}`;
    }

    if (webUiEnabled) {
      if (request.method === "GET" && (pathname === "/" || pathname.startsWith("/c/"))) {
        writeHtml(response, 200, renderWebUiHtml({ agentName, isDev: !isProduction }));
        return;
      }

      if (pathname === "/manifest.json" && request.method === "GET") {
        response.writeHead(200, { "Content-Type": "application/manifest+json" });
        response.end(renderManifest({ agentName }));
        return;
      }

      if (pathname === "/sw.js" && request.method === "GET") {
        response.writeHead(200, {
          "Content-Type": "application/javascript",
          "Service-Worker-Allowed": "/",
        });
        response.end(renderServiceWorker());
        return;
      }

      if (pathname === "/icon.svg" && request.method === "GET") {
        response.writeHead(200, { "Content-Type": "image/svg+xml" });
        response.end(renderIconSvg({ agentName }));
        return;
      }

      if ((pathname === "/icon-192.png" || pathname === "/icon-512.png") && request.method === "GET") {
        response.writeHead(302, { Location: "/icon.svg" });
        response.end();
        return;
      }
    }

    if (pathname === "/health" && request.method === "GET") {
      writeJson(response, 200, { status: "ok" });
      return;
    }

    if (pathname === "/api/openapi.json" && request.method === "GET") {
      writeJson(response, 200, buildOpenApiSpec({ agentName }));
      return;
    }

    if (pathname === "/api/docs" && request.method === "GET") {
      writeHtml(response, 200, renderApiDocsHtml("/api/openapi.json"));
      return;
    }

    // Messaging adapter routes bypass Poncho auth (they verify requests
    // using platform-specific mechanisms, e.g. Slack signing secret).
    const messagingByMethod = messagingRoutes.get(pathname ?? "");
    if (messagingByMethod) {
      const routeHandler = messagingByMethod.get(request.method ?? "");
      if (routeHandler) {
        const work = routeHandler(request, response);
        if (waitUntilHook) waitUntilHook(work);
        await work;
        return;
      }
    }

    // ── Internal endpoints (self-fetch only, secured by startup secret) ──
    if (pathname?.startsWith("/api/internal/") && request.method === "POST") {
      if (!isValidInternalRequest(request.headers)) {
        writeJson(response, 403, { code: "FORBIDDEN", message: "Internal endpoint" });
        return;
      }

      const subagentRunMatch = pathname.match(/^\/api\/internal\/subagent\/([^/]+)\/run$/);
      if (subagentRunMatch) {
        const subagentId = decodeURIComponent(subagentRunMatch[1]!);
        const body = (await readRequestBody(request)) as { resume?: boolean } | undefined;
        writeJson(response, 202, { ok: true });
        const work = (async () => {
          try {
            const conv = await conversationStore.get(subagentId);
            if (!conv || !conv.parentConversationId) return;
            if (conv.subagentMeta?.status === "stopped") return;

            if (body?.resume) {
              await orchestrator.resumeSubagentFromCheckpoint(subagentId);
              return;
            }

            const task = (conv.messages.find(m => m.role === "user")?.content as string) ?? conv.subagentMeta?.task ?? "";
            await orchestrator.runSubagent(subagentId, conv.parentConversationId, task, conv.ownerId);
          } catch (err) {
            subagentLog.error(`run error for ${subagentId}: ${formatError(err)}`);
          }
        })();
        doWaitUntil(work);
        if (!waitUntilHook) await work;
        return;
      }

      const callbackMatch = pathname.match(/^\/api\/internal\/conversations\/([^/]+)\/subagent-callback$/);
      if (callbackMatch) {
        const conversationId = decodeURIComponent(callbackMatch[1]!);
        writeJson(response, 202, { ok: true });
        const work = processSubagentCallback(conversationId);
        doWaitUntil(work);
        if (!waitUntilHook) await work;
        return;
      }

      const continueMatch = pathname.match(/^\/api\/internal\/continue\/([^/]+)$/);
      if (continueMatch) {
        const conversationId = decodeURIComponent(continueMatch[1]!);
        writeJson(response, 202, { ok: true });
        const work = (async () => {
          try {
            await runContinuation(conversationId);
            // Chain: if another continuation is needed, fire next self-fetch
            const conv = await conversationStore.get(conversationId);
            if (conv?._continuationMessages?.length) {
              await selfFetchWithRetry(`/api/internal/continue/${encodeURIComponent(conversationId)}`);
            }
          } catch (err) {
            createLogger("continuation").error(`error for ${conversationId.slice(0, 8)}: ${formatError(err)}`);
          }
        })();
        doWaitUntil(work);
        if (!waitUntilHook) await work;
        return;
      }

      writeJson(response, 404, { error: "Not found" });
      return;
    }

    // --- Resolve request context (auth type, tenant scope, owner) ---
    type RequestContext = {
      authType: "builder" | "tenant" | "anonymous";
      ownerId: string;
      /**
       * undefined = builder/admin (no tenant filter, sees everything)
       * null = legacy single-user mode
       * string = tenant-scoped
       */
      tenantId: string | undefined | null;
      session?: ReturnType<typeof sessionStore.get>;
    };

    const resolveRequestContext = async (req: IncomingMessage): Promise<RequestContext> => {
      const authHeader = req.headers.authorization;
      const bearer = typeof authHeader === "string"
        ? authHeader.match(/^Bearer\s+(.+)$/i)?.[1]
        : undefined;

      // 1. Builder Bearer token (exact match against PONCHO_AUTH_TOKEN)
      if (bearer && authToken && verifyPassphrase(bearer, authToken)) {
        return { authType: "builder", ownerId: "local-owner", tenantId: undefined };
      }

      // 2. Tenant JWT (HS256 signed with PONCHO_AUTH_TOKEN)
      if (bearer && authToken) {
        const tenantPayload = await verifyTenantToken(authToken, bearer);
        if (tenantPayload) {
          return {
            authType: "tenant",
            ownerId: tenantPayload.tenantId,
            tenantId: tenantPayload.tenantId,
          };
        }
      }

      // 3. Session cookie (passphrase login — builder auth)
      const cookies = parseCookies(req);
      const cookieValue = cookies.poncho_session;
      const sess = cookieValue
        ? (sessionStore.get(cookieValue) ?? sessionStore.restoreFromSigned(cookieValue))
        : undefined;
      if (sess) {
        return {
          authType: "builder",
          ownerId: sess.ownerId ?? "local-owner",
          tenantId: undefined,
          session: sess,
        };
      }

      // 4. Anonymous / legacy
      return { authType: "anonymous", ownerId: "local-owner", tenantId: null };
    };

    const ctx = await resolveRequestContext(request);
    const ownerId = ctx.ownerId;
    const session = ctx.session;
    const requiresCsrfValidation =
      request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS";

    /** Check if ctx has access to a conversation. Builder (tenantId=undefined) sees everything. */
    const canAccessConversation = (conv: { ownerId: string; tenantId?: string | null }): boolean => {
      if (ctx.tenantId === undefined) return true; // builder/admin
      return conv.ownerId === ownerId && (conv.tenantId ?? null) === (ctx.tenantId ?? null);
    };

    if (pathname === "/api/auth/session" && request.method === "GET") {
      if (!requireAuth) {
        writeJson(response, 200, { authenticated: true, csrfToken: "" });
        return;
      }
      // Tenant JWT auth — already authenticated, no session needed
      if (ctx.authType === "tenant") {
        const tenantSecrets = config?.tenantSecrets;
        writeJson(response, 200, {
          authenticated: true,
          authType: "tenant",
          tenantId: ctx.tenantId,
          ...(tenantSecrets && Object.keys(tenantSecrets).length > 0
            ? { tenantSecrets }
            : {}),
        });
        return;
      }
      // Builder Bearer auth
      if (ctx.authType === "builder" && !session) {
        writeJson(response, 200, { authenticated: true, authType: "builder" });
        return;
      }
      if (!session) {
        writeJson(response, 200, { authenticated: false });
        return;
      }
      writeJson(response, 200, {
        authenticated: true,
        authType: "builder",
        sessionId: session.sessionId,
        ownerId: session.ownerId,
        csrfToken: session.csrfToken,
      });
      return;
    }

    if (pathname === "/api/auth/login" && request.method === "POST") {
      if (!requireAuth) {
        writeJson(response, 200, { authenticated: true, csrfToken: "" });
        return;
      }
      const ip = getRequestIp(request);
      const canAttempt = loginRateLimiter.canAttempt(ip);
      if (!canAttempt.allowed) {
        writeJson(response, 429, {
          code: "AUTH_RATE_LIMIT",
          message: "Too many failed login attempts. Try again later.",
          retryAfterSeconds: canAttempt.retryAfterSeconds,
        });
        return;
      }
      const body = (await readRequestBody(request)) as { passphrase?: string };
      const provided = body.passphrase ?? "";
      if (!verifyPassphrase(provided, authToken)) {
        const failure = loginRateLimiter.registerFailure(ip);
        writeJson(response, 401, {
          code: "AUTH_ERROR",
          message: "Invalid passphrase",
          retryAfterSeconds: failure.retryAfterSeconds,
        });
        return;
      }
      loginRateLimiter.registerSuccess(ip);
      const createdSession = sessionStore.create(ownerId);
      const signedValue = sessionStore.signSession(createdSession);
      setCookie(response, "poncho_session", signedValue ?? createdSession.sessionId, {
        httpOnly: true,
        secure: secureCookies,
        sameSite: "Lax",
        path: "/",
        maxAge: 60 * 60 * 8,
      });
      writeJson(response, 200, {
        authenticated: true,
        csrfToken: createdSession.csrfToken,
      });
      return;
    }

    if (pathname === "/api/auth/logout" && request.method === "POST") {
      if (session?.sessionId) {
        sessionStore.delete(session.sessionId);
      }
      setCookie(response, "poncho_session", "", {
        httpOnly: true,
        secure: secureCookies,
        sameSite: "Lax",
        path: "/",
        maxAge: 0,
      });
      writeJson(response, 200, { ok: true });
      return;
    }

    if (pathname.startsWith("/api/")) {
      // Internal self-fetch requests bypass user-facing auth
      const isInternalPath = pathname.startsWith("/api/internal/") || pathname.startsWith("/api/cron/") || pathname === "/api/reminders/check";
      const isInternal = isInternalPath && request.method === "POST" && isValidInternalRequest(request.headers);

      // Check authentication: either valid session (Web UI), valid Bearer token (API), tenant JWT, or valid internal request
      const hasBearerToken = request.headers.authorization?.startsWith("Bearer ");
      const isAuthenticated = isInternal || !requireAuth || ctx.authType !== "anonymous";

      if (!isAuthenticated) {
        writeJson(response, 401, {
          code: "AUTH_ERROR",
          message: "Authentication required",
        });
        return;
      }

      // CSRF validation only for session-based requests (not Bearer token requests)
      if (
        requireAuth &&
        session &&
        !hasBearerToken &&
        requiresCsrfValidation &&
        pathname !== "/api/auth/login" &&
        pathname !== "/api/auth/logout" &&
        request.headers["x-csrf-token"] !== session?.csrfToken
      ) {
        csrfLog.warn(
          `blocked ${request.method} ${pathname} (session=${session.sessionId.slice(0, 8)})`,
        );
        writeJson(response, 403, {
          code: "CSRF_ERROR",
          message: "Invalid CSRF token",
        });
        return;
      }
    }

    // --- Secrets API endpoints ---
    const secretsMatch = pathname.match(/^\/api\/secrets(?:\/([^/]+))?$/);
    if (secretsMatch) {
      const envName = secretsMatch[1] ? decodeURIComponent(secretsMatch[1]) : undefined;
      const tenantSecrets = config?.tenantSecrets;

      if (request.method === "GET" && !envName) {
        // GET /api/secrets — list secrets
        if (ctx.authType === "tenant" && ctx.tenantId) {
          // Tenant: return tenantSecrets entries with set/unset status
          if (!tenantSecrets || Object.keys(tenantSecrets).length === 0) {
            writeJson(response, 200, { secrets: [] });
            return;
          }
          const setNames = harness.secretsStore
            ? new Set(await harness.secretsStore.list(ctx.tenantId))
            : new Set<string>();
          const secrets = Object.entries(tenantSecrets).map(([name, label]) => ({
            name,
            label,
            isSet: setNames.has(name),
          }));
          writeJson(response, 200, { secrets });
          return;
        }
        if (ctx.authType === "builder") {
          // Builder: list all secrets for a specific tenant
          const tenantParam = requestUrl.searchParams.get("tenant");
          if (!tenantParam) {
            writeJson(response, 400, { code: "BAD_REQUEST", message: "?tenant= query parameter required for builder access" });
            return;
          }
          const names = harness.secretsStore
            ? await harness.secretsStore.list(tenantParam)
            : [];
          writeJson(response, 200, { tenant: tenantParam, secrets: names.map((n) => ({ name: n, isSet: true })) });
          return;
        }
        writeJson(response, 403, { code: "FORBIDDEN", message: "Not authorized" });
        return;
      }

      if (request.method === "PUT" && envName) {
        // PUT /api/secrets/:envName — set a secret value
        const body = (await readRequestBody(request)) as { value?: string };
        const value = typeof body.value === "string" ? body.value : "";
        if (!value) {
          writeJson(response, 400, { code: "BAD_REQUEST", message: "value is required" });
          return;
        }
        let targetTenant: string | undefined;
        if (ctx.authType === "tenant" && ctx.tenantId) {
          // Tenants can only set keys listed in tenantSecrets
          if (!tenantSecrets || !(envName in tenantSecrets)) {
            writeJson(response, 403, { code: "FORBIDDEN", message: "Not allowed to set this secret" });
            return;
          }
          targetTenant = ctx.tenantId;
        } else if (ctx.authType === "builder") {
          const tenantParam = requestUrl.searchParams.get("tenant");
          if (!tenantParam) {
            writeJson(response, 400, { code: "BAD_REQUEST", message: "?tenant= required" });
            return;
          }
          targetTenant = tenantParam;
        }
        if (!targetTenant || !harness.secretsStore) {
          writeJson(response, 400, { code: "BAD_REQUEST", message: "Secrets store not available" });
          return;
        }
        await harness.secretsStore.set(targetTenant, envName, value);
        writeJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "DELETE" && envName) {
        // DELETE /api/secrets/:envName — remove a secret override
        let targetTenant: string | undefined;
        if (ctx.authType === "tenant" && ctx.tenantId) {
          if (!tenantSecrets || !(envName in tenantSecrets)) {
            writeJson(response, 403, { code: "FORBIDDEN", message: "Not allowed to delete this secret" });
            return;
          }
          targetTenant = ctx.tenantId;
        } else if (ctx.authType === "builder") {
          const tenantParam = requestUrl.searchParams.get("tenant");
          if (!tenantParam) {
            writeJson(response, 400, { code: "BAD_REQUEST", message: "?tenant= required" });
            return;
          }
          targetTenant = tenantParam;
        }
        if (!targetTenant || !harness.secretsStore) {
          writeJson(response, 400, { code: "BAD_REQUEST", message: "Secrets store not available" });
          return;
        }
        await harness.secretsStore.delete(targetTenant, envName);
        writeJson(response, 200, { ok: true });
        return;
      }
    }

    // --- Browser endpoints (single session, routed by conversationId) ---

    type BrowserSessionTyped = {
      isLaunched: boolean;
      isActiveFor: (cid: string) => boolean;
      getUrl: (cid: string) => string | undefined;
      onFrame: (cid: string, cb: (f: { data: string; width: number; height: number; timestamp: number }) => void) => () => void;
      onStatus: (cid: string, cb: (s: { active: boolean; url?: string; interactionAllowed: boolean }) => void) => () => void;
      startScreencast: (cid: string, opts?: Record<string, unknown>) => Promise<void>;
      screenshot: (cid: string) => Promise<string>;
      injectMouse: (cid: string, e: { type: string; x: number; y: number; button?: string; clickCount?: number; deltaX?: number; deltaY?: number }) => Promise<void>;
      injectKeyboard: (cid: string, e: { type: string; key: string; code?: string }) => Promise<void>;
      injectScroll: (cid: string, e: { deltaX: number; deltaY: number; x?: number; y?: number }) => Promise<void>;
      injectPaste: (cid: string, text: string) => Promise<void>;
      navigate: (cid: string, action: string) => Promise<void>;
    };

    const browserSession = harness.browserSession as BrowserSessionTyped | undefined;

    const resolveBrowserSession = (cid: string): BrowserSessionTyped | undefined => {
      if (browserSession?.isActiveFor(cid)) return browserSession;
      const subRun = activeSubagentRuns.get(cid);
      if (subRun) {
        const childSession = subRun.harness.browserSession as BrowserSessionTyped | undefined;
        if (childSession?.isActiveFor(cid)) return childSession;
      }
      return undefined;
    };

    if (pathname === "/api/browser/status" && request.method === "GET") {
      const cid = requestUrl.searchParams.get("conversationId") ?? "";
      const session = cid ? resolveBrowserSession(cid) : undefined;
      writeJson(response, 200, {
        active: !!session,
        url: session ? session.getUrl(cid) ?? null : null,
        conversationId: cid || null,
      });
      return;
    }

    if (pathname === "/api/browser/stream" && request.method === "GET") {
      const cid = requestUrl.searchParams.get("conversationId");
      const streamSession = cid ? resolveBrowserSession(cid) : undefined;
      if (!cid || !streamSession) {
        writeJson(response, 404, { error: "No browser session available" });
        return;
      }

      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      response.flushHeaders();

      let draining = false;
      let pendingFrame: { data: string; width: number; height: number; timestamp: number } | null = null;

      const sendSse = (event: string, data: unknown) => {
        if (response.destroyed) return;
        response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      const sendFrame = (frame: { data: string; width: number; height: number; timestamp: number }) => {
        if (response.destroyed) return;
        if (draining) {
          pendingFrame = frame;
          return;
        }
        const ok = response.write(`event: browser:frame\ndata: ${JSON.stringify(frame)}\n\n`);
        if (!ok) {
          draining = true;
          response.once("drain", () => {
            draining = false;
            if (pendingFrame && !response.destroyed) {
              const f = pendingFrame;
              pendingFrame = null;
              sendFrame(f);
            }
          });
        }
      };

      sendSse("browser:status", {
        active: streamSession.isActiveFor(cid),
        url: streamSession.getUrl(cid),
        interactionAllowed: streamSession.isActiveFor(cid),
      });

      const removeFrame = streamSession.onFrame(cid, (frame) => {
        sendFrame(frame);
      });
      const removeStatus = streamSession.onStatus(cid, (status) => {
        sendSse("browser:status", status);
      });

      if (streamSession.isActiveFor(cid)) {
        streamSession.screenshot(cid).then((data) => {
          if (!response.destroyed) {
            sendFrame({ data, width: 1280, height: 720, timestamp: Date.now() });
          }
          return streamSession.startScreencast(cid);
        }).catch((err: unknown) => {
          browserLog.error(`initial frame/screencast failed: ${formatError(err)}`);
        });
      }

      request.on("close", () => {
        removeFrame();
        removeStatus();
        pendingFrame = null;
      });
      return;
    }

    if (pathname === "/api/browser/input" && request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const cid = body.conversationId as string;
      const inputSession = cid ? resolveBrowserSession(cid) : undefined;
      if (!cid || !inputSession) {
        writeJson(response, 404, { error: "No active browser session" });
        return;
      }
      try {
        if (body.kind === "mouse") {
          await inputSession.injectMouse(cid, body.event);
        } else if (body.kind === "keyboard") {
          await inputSession.injectKeyboard(cid, body.event);
        } else if (body.kind === "scroll") {
          await inputSession.injectScroll(cid, body.event);
        } else if (body.kind === "paste") {
          await inputSession.injectPaste(cid, body.text ?? body.event?.text ?? "");
        } else {
          writeJson(response, 400, { error: "Unknown input kind" });
          return;
        }
        writeJson(response, 200, { ok: true });
      } catch (err) {
        writeJson(response, 500, { error: (err as Error)?.message ?? "Input injection failed" });
      }
      return;
    }

    if (pathname === "/api/browser/navigate" && request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const cid = body.conversationId as string;
      const navSession = cid ? resolveBrowserSession(cid) : undefined;
      if (!cid || !navSession) {
        writeJson(response, 400, { error: "No active browser session" });
        return;
      }
      try {
        await navSession.navigate(cid, body.action);
        writeJson(response, 200, { ok: true });
      } catch (err) {
        writeJson(response, 500, { error: (err as Error)?.message ?? "Navigation failed" });
      }
      return;
    }

    if (pathname === "/api/conversations" && request.method === "GET") {
      const allSummaries = await conversationStore.listSummaries(ownerId, ctx.tenantId);
      const conversations = allSummaries.filter((c) => !c.parentConversationId);
      // Derive parent-has-subagent-approvals from the in-memory map (no disk I/O)
      const parentHasSubagentApprovals = new Set<string>();
      for (const [, pa] of pendingSubagentApprovals) {
        parentHasSubagentApprovals.add(pa.parentConversationId);
      }
      writeJson(response, 200, {
        conversations: conversations.map((c) => ({
          conversationId: c.conversationId,
          title: c.title,
          ownerId: c.ownerId,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
          messageCount: c.messageCount ?? 0,
          hasPendingApprovals:
            !!c.hasPendingApprovals || parentHasSubagentApprovals.has(c.conversationId),
        })),
      });
      return;
    }

    if (pathname === "/api/conversations" && request.method === "POST") {
      const body = (await readRequestBody(request)) as { title?: string };
      const conversation = await conversationStore.create(ownerId, body.title, ctx.tenantId ?? null);
      const introMessage = await consumeFirstRunIntro(workingDir, {
        agentName,
        provider: agentModelProvider,
        model: agentModelName,
        config,
      });
      if (introMessage) {
        conversation.messages = [{ role: "assistant", content: introMessage }];
        await conversationStore.update(conversation);
      }
      writeJson(response, 201, { conversation });
      return;
    }

    const approvalMatch = pathname.match(/^\/api\/approvals\/([^/]+)$/);
    if (approvalMatch && request.method === "POST") {
      const approvalId = decodeURIComponent(approvalMatch[1] ?? "");
      const body = (await readRequestBody(request)) as { approved?: boolean; conversationId?: string };
      const approved = body.approved === true;
      const hintedConversationId = typeof body.conversationId === "string" && body.conversationId.trim().length > 0
        ? body.conversationId.trim()
        : undefined;

      // Check if this is a pending subagent approval (handled inline by runSubagent)
      const subagentResult = await orchestrator.submitSubagentApprovalDecision(approvalId, approved);
      if (subagentResult.found) {
        writeJson(response, 200, { ok: true, approvalId, approved } satisfies ApiApprovalResponse);
        return;
      }

      // Find the approval in the conversation store (checkpoint-based flow)
      let foundConversation: Conversation | undefined;
      let foundApproval: NonNullable<Conversation["pendingApprovals"]>[number] | undefined;
      if (hintedConversationId) {
        const hintedConversation = await conversationStore.get(hintedConversationId);
        if (hintedConversation && hintedConversation.ownerId === ownerId && Array.isArray(hintedConversation.pendingApprovals)) {
          const hintedMatch = hintedConversation.pendingApprovals.find((approval) => approval.approvalId === approvalId);
          if (hintedMatch) {
            foundConversation = hintedConversation;
            foundApproval = hintedMatch;
          }
        }
      }
      if (!foundConversation || !foundApproval) {
        const found = await findPendingApproval(approvalId, ownerId);
        foundConversation = found?.conversation;
        foundApproval = found?.approval;
      }

      if (!foundConversation || !foundApproval) {
        writeJson(response, 404, {
          code: "APPROVAL_NOT_FOUND",
          message: "Approval request not found",
        });
        return;
      }

      const conversationId = foundConversation.conversationId;
      foundApproval = normalizeApprovalCheckpoint(foundApproval, foundConversation.messages);

      if (!foundApproval.checkpointMessages || !foundApproval.toolCallId) {
        writeJson(response, 409, {
          code: "APPROVAL_NOT_READY",
          message: "Approval checkpoint is not ready yet. Please retry shortly.",
        });
        return;
      }

      const approvalDecision = approved ? "approved" : "denied";
      foundConversation.pendingApprovals = (foundConversation.pendingApprovals ?? []).map((approval) =>
        approval.approvalId === approvalId
          ? { ...normalizeApprovalCheckpoint(approval, foundConversation!.messages), decision: approvalDecision }
          : normalizeApprovalCheckpoint(approval, foundConversation!.messages),
      );
      await conversationStore.update(foundConversation);

      broadcastEvent(conversationId,
        approved
          ? { type: "tool:approval:granted", approvalId }
          : { type: "tool:approval:denied", approvalId },
      );

      const refreshedConversation = await conversationStore.get(conversationId);
      const allApprovals = (refreshedConversation?.pendingApprovals ?? []).map((approval) =>
        normalizeApprovalCheckpoint(approval, refreshedConversation!.messages),
      );
      const allDecided = allApprovals.length > 0 &&
        allApprovals.every(a => a.decision != null);

      if (!allDecided) {
        writeJson(response, 200, { ok: true, approvalId, approved, batchComplete: false } satisfies ApiApprovalResponse);
        return;
      }

      approvalDecisionTracker.delete(conversationId);

      foundConversation.pendingApprovals = [];
      foundConversation.runStatus = "running";
      await conversationStore.update(foundConversation);

      // Use the first approval as the checkpoint reference (all share the same checkpoint data)
      const checkpointRef = allApprovals[0]!;

      // Reset the event stream so new SSE subscribers can connect to the
      // resumed run (the previous run's stream was marked finished).
      const prevStream = conversationEventStreams.get(conversationId);
      if (prevStream) {
        prevStream.finished = false;
        prevStream.buffer = [];
      } else {
        conversationEventStreams.set(conversationId, {
          buffer: [],
          subscribers: new Set(),
          finished: false,
        });
      }

      const resumeWork = (async () => {
        try {
          const toolContext = {
            runId: checkpointRef.runId,
            agentId: identity.id,
            step: 0,
            workingDir,
            parameters: {},
          };

          // Collect tool calls to execute: approved approval-gated tools + auto-approved deferred tools
          const approvalToolCallIds = new Set(allApprovals.map(a => a.toolCallId));
          const callsToExecute: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
          const deniedResults: Array<{ callId: string; toolName: string; error: string }> = [];

          for (const a of allApprovals) {
            if (a.decision === "approved" && a.toolCallId) {
              callsToExecute.push({ id: a.toolCallId, name: a.tool, input: a.input });
            } else if (a.decision === "denied" && a.toolCallId) {
              deniedResults.push({ callId: a.toolCallId, toolName: a.tool, error: "Tool execution denied by user" });
            }
          }

          // Auto-approved tools that were deferred alongside the approval-needing ones
          const pendingToolCalls = checkpointRef.pendingToolCalls ?? [];
          for (const tc of pendingToolCalls) {
            if (!approvalToolCallIds.has(tc.id)) {
              callsToExecute.push(tc);
            }
          }

          let toolResults: Array<{ callId: string; toolName: string; result?: unknown; error?: string }> = [...deniedResults];
          if (callsToExecute.length > 0) {
            const execResults = await harness.executeTools(callsToExecute, toolContext);
            toolResults.push(...execResults.map(r => ({
              callId: r.callId,
              toolName: r.tool,
              result: r.output,
              error: r.error,
            })));
          }

          // If approved tools activated the browser, notify connected clients
          const bs = harness.browserSession as BrowserSessionForStatus | undefined;
          if (bs?.isActiveFor(conversationId)) {
            broadcastRawSse(conversationId, "browser:status", {
              active: true,
              url: bs.getUrl(conversationId) ?? null,
              interactionAllowed: true,
            });
          }

          // Capture pre-resume text so Telegram reply only includes new content
          const preConv = await conversationStore.get(conversationId);
          const preLast = preConv?.messages[preConv.messages.length - 1];
          const preLen = preLast?.role === "assistant" && typeof preLast.content === "string"
            ? preLast.content.length : 0;

          await resumeRunFromCheckpoint(
            conversationId,
            foundConversation!,
            checkpointRef,
            toolResults,
          );

          // If the conversation originated from a messaging channel, send the new response text
          const postConv = await conversationStore.get(conversationId);
          if (postConv?.channelMeta) {
            const adapter = messagingAdapters.get(postConv.channelMeta.platform);
            if (adapter) {
              const lastMsg = postConv.messages[postConv.messages.length - 1];
              const full = lastMsg?.role === "assistant" && typeof lastMsg.content === "string"
                ? lastMsg.content : "";
              const newText = full.slice(preLen).trim();
              if (newText) {
                try {
                  await adapter.sendReply(
                    {
                      platformThreadId: postConv.channelMeta.platformThreadId,
                      channelId: postConv.channelMeta.channelId,
                    },
                    newText,
                  );
                } catch (sendErr) {
                  approvalLog.error(`resume messaging notify failed: ${formatError(sendErr)}`);
                }
              }
            }
          }

          // If this conversation is a subagent, handle completion (write result to parent)
          if (foundConversation!.parentConversationId) {
            await orchestrator.handleSubagentCompletion(conversationId);
          }
        } catch (err) {
          approvalLog.error(`resume failed: ${formatError(err)}`);
          const conv = await conversationStore.get(conversationId);
          if (conv) {
            conv.runStatus = "idle";
            conv.updatedAt = Date.now();
            await conversationStore.update(conv);
          }
        }
      })();
      if (waitUntilHook) {
        waitUntilHook(resumeWork);
      } else {
        await resumeWork;
      }

      writeJson(response, 200, { ok: true, approvalId, approved, batchComplete: true } satisfies ApiApprovalResponse);
      return;
    }

    const conversationEventsMatch = pathname.match(
      /^\/api\/conversations\/([^/]+)\/events$/,
    );
    if (conversationEventsMatch && request.method === "GET") {
      const conversationId = decodeURIComponent(conversationEventsMatch[1] ?? "");
      const conversation = await conversationStore.get(conversationId);
      if (!conversation || !canAccessConversation(conversation)) {
        writeJson(response, 404, {
          code: "CONVERSATION_NOT_FOUND",
          message: "Conversation not found",
        });
        return;
      }
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const stream = conversationEventStreams.get(conversationId);
      if (!stream) {
        response.write("event: stream:end\ndata: {}\n\n");
        response.end();
        return;
      }
      const liveOnly = (request.url ?? "").includes("live_only=true");
      if (!liveOnly) {
        for (const bufferedEvent of stream.buffer) {
          try {
            response.write(formatSseEvent(bufferedEvent));
          } catch {
            response.end();
            return;
          }
        }
      }
      if (stream.finished) {
        response.write("event: stream:end\ndata: {}\n\n");
        response.end();
        return;
      }
      // Subscribe to live events
      stream.subscribers.add(response);
      request.on("close", () => {
        stream.subscribers.delete(response);
      });
      return;
    }

    const subagentsMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/subagents$/);
    if (subagentsMatch && request.method === "GET") {
      const parentId = decodeURIComponent(subagentsMatch[1] ?? "");
      // Use summaries to find child IDs, then only load those child files
      const allSummaries = await conversationStore.listSummaries(ownerId, ctx.tenantId);
      const childSummaries = allSummaries.filter((s) => s.parentConversationId === parentId);
      const subagents: ApiSubagentSummary[] = [];
      for (const s of childSummaries) {
        const c = await conversationStore.get(s.conversationId);
        if (c) {
          subagents.push({
            conversationId: c.conversationId,
            title: c.title,
            task: c.subagentMeta?.task ?? c.title,
            status: c.subagentMeta?.status ?? "stopped",
            messageCount: c.messages.length,
            hasPendingApprovals: Array.isArray(c.pendingApprovals) && c.pendingApprovals.length > 0,
            createdAt: String(c.createdAt),
            updatedAt: String(c.updatedAt),
          });
        }
      }
      writeJson(response, 200, { subagents });
      return;
    }

    const threadsMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/threads$/);
    if (threadsMatch && request.method === "GET") {
      const parentId = decodeURIComponent(threadsMatch[1] ?? "");
      const parent = await conversationStore.get(parentId);
      if (!parent || !canAccessConversation(parent)) {
        writeJson(response, 404, { code: "CONVERSATION_NOT_FOUND", message: "Conversation not found" });
        return;
      }
      const summaries = await conversationStore.listThreads(parentId);
      const threads: ApiThreadSummary[] = [];
      for (const s of summaries) {
        const child = await conversationStore.get(s.conversationId);
        if (!child || !child.parentMessageId) continue;
        const snapshotLength = child.threadMeta?.snapshotLength ?? child.messages.length;
        const replyCount = Math.max(0, child.messages.length - snapshotLength);
        threads.push({
          conversationId: child.conversationId,
          parentConversationId: parentId,
          parentMessageId: child.parentMessageId,
          title: child.title,
          parentMessageSummary: child.threadMeta?.parentMessageSummary,
          messageCount: child.messages.length,
          replyCount,
          snapshotLength,
          createdAt: child.createdAt,
          updatedAt: child.updatedAt,
          lastReplyAt: child.updatedAt,
        });
      }
      const payload: ApiThreadListResponse = { threads };
      writeJson(response, 200, payload);
      return;
    }

    if (threadsMatch && request.method === "POST") {
      const parentId = decodeURIComponent(threadsMatch[1] ?? "");
      const parent = await conversationStore.getWithArchive(parentId);
      if (!parent || !canAccessConversation(parent)) {
        writeJson(response, 404, { code: "CONVERSATION_NOT_FOUND", message: "Conversation not found" });
        return;
      }
      const body = (await readRequestBody(request)) as { parentMessageId?: string; title?: string } | undefined;
      const parentMessageId = body?.parentMessageId;
      if (typeof parentMessageId !== "string" || parentMessageId.length === 0) {
        writeJson(response, 400, { code: "BAD_REQUEST", message: "parentMessageId is required" });
        return;
      }

      // Reconstruct the user-visible sequence: pre-compaction history +
      // current messages (drop the model-facing compactionSummary).
      const compactedHistory = parent.compactedHistory ?? [];
      const visibleFromMessages = parent.messages.filter(
        (m) => !m.metadata?.isCompactionSummary,
      );
      const visible: Message[] = compactedHistory.length > 0
        ? [...compactedHistory, ...visibleFromMessages]
        : visibleFromMessages;

      const idx = visible.findIndex((m) => m.metadata?.id === parentMessageId);
      if (idx < 0) {
        // Distinguish "we found a message at that array slot but it has no id"
        // from "no such id exists at all". Both are 4xx but the SPA renders
        // them differently.
        const anyMissingId = visible.some((m) => !m.metadata?.id);
        if (anyMissingId) {
          writeJson(response, 409, {
            code: "MESSAGE_ID_REQUIRED",
            message: "Anchor message lacks a stable id (legacy row).",
          });
        } else {
          writeJson(response, 404, {
            code: "PARENT_MESSAGE_NOT_FOUND",
            message: "parentMessageId not found in parent conversation",
          });
        }
        return;
      }

      // Block forking on the actively-streaming tail message of a live run.
      // Prior messages are already persisted and stable.
      if (parent.runStatus === "running") {
        const isInFlightTail =
          idx === visible.length - 1 &&
          visible[idx]?.role === "assistant" &&
          visible[idx]?.metadata?.id === parentMessageId;
        if (isInFlightTail) {
          writeJson(response, 409, {
            code: "ANCHOR_IN_FLIGHT",
            message: "Cannot fork on the currently-streaming message",
          });
          return;
        }
      }

      const anchor = visible[idx]!;
      const anchorIsPreCompaction = idx < compactedHistory.length;
      const snapshot: Message[] = visible.slice(0, idx + 1).map((m) => structuredClone(m));
      const anchorText = getTextContent(anchor);
      const derivedTitle = (body?.title?.trim()) ||
        (anchorText.trim().length > 0
          ? `Thread: ${anchorText.slice(0, 60).replace(/\s+/g, " ").trim()}`
          : "Thread");

      const thread = await conversationStore.create(
        parent.ownerId,
        derivedTitle,
        parent.tenantId,
        {
          parentConversationId: parent.conversationId,
          parentMessageId,
          messages: snapshot,
          threadMeta: {
            parentMessageSummary: anchorText.slice(0, 200),
            snapshotLength: snapshot.length,
          },
        },
      );

      // Trim _harnessMessages by id-match. Pre-compaction anchors get
      // _harnessMessages=undefined so the harness rebuilds from `messages`.
      if (anchorIsPreCompaction) {
        thread._harnessMessages = undefined;
      } else {
        const snapshotIds = new Set(
          snapshot.map((m) => m.metadata?.id).filter((x): x is string => typeof x === "string"),
        );
        const parentHarness = parent._harnessMessages ?? [];
        let cutoff = -1;
        for (let i = 0; i < parentHarness.length; i++) {
          const id = parentHarness[i]?.metadata?.id;
          if (id && snapshotIds.has(id)) cutoff = i;
        }
        thread._harnessMessages = cutoff >= 0
          ? parentHarness.slice(0, cutoff + 1).map((m) => structuredClone(m))
          : undefined;
      }

      // Filter _toolResultArchive by toolCallIds referenced in the (already
      // trimmed) thread._harnessMessages — that is where tool-call ids live,
      // since `messages` carries only display-friendly assistant text.
      const referencedToolCallIds = collectToolCallIds(thread._harnessMessages ?? []);
      const parentArchive = parent._toolResultArchive;
      if (parentArchive && referencedToolCallIds.size > 0) {
        const filtered: NonNullable<Conversation["_toolResultArchive"]> = {};
        for (const [k, v] of Object.entries(parentArchive)) {
          if (v && referencedToolCallIds.has(v.toolCallId)) {
            filtered[k] = structuredClone(v);
          }
        }
        thread._toolResultArchive = Object.keys(filtered).length > 0 ? filtered : undefined;
      } else {
        thread._toolResultArchive = undefined;
      }

      // Reset all run-specific state so the thread starts clean.
      thread._continuationMessages = undefined;
      thread.runtimeRunId = undefined;
      thread.runStatus = "idle";
      thread.pendingApprovals = undefined;
      thread.pendingSubagentResults = undefined;
      thread.subagentCallbackCount = undefined;
      thread.runningCallbackSince = undefined;
      thread.lastActivityAt = Date.now();
      thread.channelMeta = undefined;
      thread.subagentMeta = undefined;
      thread.contextTokens = anchorIsPreCompaction ? undefined : parent.contextTokens;
      thread.contextWindow = parent.contextWindow;

      await conversationStore.update(thread);

      const summary: ApiThreadSummary = {
        conversationId: thread.conversationId,
        parentConversationId: parent.conversationId,
        parentMessageId,
        title: thread.title,
        parentMessageSummary: thread.threadMeta?.parentMessageSummary,
        messageCount: thread.messages.length,
        replyCount: 0,
        snapshotLength: snapshot.length,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        lastReplyAt: thread.updatedAt,
      };
      const payload: ApiCreateThreadResponse = {
        thread: summary,
        conversationId: thread.conversationId,
      };
      writeJson(response, 201, payload);
      return;
    }

    const todosMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/todos$/);
    if (todosMatch && request.method === "GET") {
      const conversationId = decodeURIComponent(todosMatch[1] ?? "");
      const conversation = await conversationStore.get(conversationId);
      if (!conversation || !canAccessConversation(conversation)) {
        writeJson(response, 404, { code: "CONVERSATION_NOT_FOUND", message: "Conversation not found" });
        return;
      }
      const todos = await harness.getTodos(conversationId);
      writeJson(response, 200, { todos });
      return;
    }

    // Cheap status endpoint — column-only reads + in-memory state. Used by
    // the web UI poll loop to check whether the full conversation needs to
    // be refetched. Intentionally kept minimal: returning extra fields here
    // re-creates the egress problem the endpoint exists to avoid.
    const conversationStatusMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/status$/);
    if (conversationStatusMatch && request.method === "GET") {
      const conversationId = decodeURIComponent(conversationStatusMatch[1] ?? "");
      const snapshot = await conversationStore.getStatusSnapshot(conversationId);
      if (!snapshot || !canAccessConversation(snapshot)) {
        writeJson(response, 404, {
          code: "CONVERSATION_NOT_FOUND",
          message: "Conversation not found",
        });
        return;
      }
      const activeStream = conversationEventStreams.get(conversationId);
      const hasActiveRun =
        (!!activeStream && !activeStream.finished) || snapshot.runStatus === "running";
      const hasRunningSubagents = !snapshot.parentConversationId
        ? hasRunningSubagentsForParent(conversationId, snapshot.ownerId)
        : false;
      let subagentPendingApprovalsCount = 0;
      if (!snapshot.parentConversationId) {
        for (const [, pa] of pendingSubagentApprovals) {
          if (pa.parentConversationId === conversationId) subagentPendingApprovalsCount += 1;
        }
      }
      const needsContinuation =
        !hasActiveRun && snapshot.hasContinuationMessages && !snapshot.hasPendingApprovals;
      writeJson(response, 200, {
        conversationId,
        updatedAt: snapshot.updatedAt,
        messageCount: snapshot.messageCount,
        hasPendingApprovals: snapshot.hasPendingApprovals,
        subagentPendingApprovalsCount,
        hasActiveRun,
        hasRunningSubagents,
        needsContinuation,
      });
      return;
    }

    const conversationPathMatch = pathname.match(/^\/api\/conversations\/([^/]+)$/);
    if (conversationPathMatch) {
      const conversationId = decodeURIComponent(conversationPathMatch[1] ?? "");
      const conversation = await conversationStore.get(conversationId);
      if (!conversation || !canAccessConversation(conversation)) {
        writeJson(response, 404, {
          code: "CONVERSATION_NOT_FOUND",
          message: "Conversation not found",
        });
        return;
      }
      if (request.method === "GET") {
        const storedPending = Array.isArray(conversation.pendingApprovals)
          ? conversation.pendingApprovals.map(a => ({
              approvalId: a.approvalId,
              runId: a.runId,
              tool: a.tool,
              input: a.input,
              decision: a.decision,
            }))
          : [];
        // Collect pending approvals from subagent conversations (in-memory map, no disk I/O)
        const subagentPending: Array<{ approvalId: string; tool: string; input: unknown; subagentId: string }> = [];
        if (!conversation.parentConversationId) {
          for (const [aid, pa] of pendingSubagentApprovals) {
            if (pa.parentConversationId === conversationId) {
              subagentPending.push({
                approvalId: aid,
                tool: pa.checkpoint.tool,
                input: pa.checkpoint.input,
                subagentId: pa.childConversationId,
              });
            }
          }
        }
        const activeStream = conversationEventStreams.get(conversationId);
        const hasActiveRun = (!!activeStream && !activeStream.finished) || conversation.runStatus === "running";
        const hasRunningSubagents = !conversation.parentConversationId
          ? hasRunningSubagentsForParent(conversationId, conversation.ownerId)
          : false;
        const hasPendingCallbackResults = Array.isArray(conversation.pendingSubagentResults)
          && conversation.pendingSubagentResults.length > 0;
        const hasPendingApprovals = Array.isArray(conversation.pendingApprovals)
          && conversation.pendingApprovals.length > 0;
        const needsContinuation = !hasActiveRun
          && Array.isArray(conversation._continuationMessages)
          && conversation._continuationMessages.length > 0
          && !hasPendingApprovals;
        writeJson(response, 200, {
          conversation: {
            ...conversation,
            messages: conversation.messages.map(normalizeMessageForClient).filter((m): m is Message => m !== null),
            pendingApprovals: storedPending,
            _continuationMessages: undefined,
            _harnessMessages: undefined,
            // The browser has no use for the archive; make sure we never ship
            // it back even if the conversation was loaded via getWithArchive.
            _toolResultArchive: undefined,
          },
          subagentPendingApprovals: subagentPending,
          hasActiveRun: hasActiveRun || hasPendingCallbackResults,
          hasRunningSubagents,
          needsContinuation,
        });
        return;
      }
      if (request.method === "PATCH") {
        const body = (await readRequestBody(request)) as { title?: string };
        if (!body.title || body.title.trim().length === 0) {
          writeJson(response, 400, {
            code: "VALIDATION_ERROR",
            message: "title is required",
          });
          return;
        }
        const updated = await conversationStore.rename(conversationId, body.title);
        writeJson(response, 200, { conversation: updated });
        return;
      }
      if (request.method === "DELETE") {
        // Cascade: stop and delete all child subagent conversations
        const allSummaries = await conversationStore.listSummaries(ownerId, ctx.tenantId);
        const childIds = allSummaries
          .filter((s) => s.parentConversationId === conversationId)
          .map((s) => s.conversationId);
        for (const childId of childIds) {
          const activeChild = activeSubagentRuns.get(childId);
          if (activeChild) activeChild.abortController.abort();
          activeSubagentRuns.delete(childId);
          activeConversationRuns.delete(childId);
          await conversationStore.delete(childId);
        }
        await conversationStore.delete(conversationId);
        writeJson(response, 200, { ok: true });
        return;
      }
    }

    const conversationStopMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/stop$/);
    if (conversationStopMatch && request.method === "POST") {
      const conversationId = decodeURIComponent(conversationStopMatch[1] ?? "");
      const body = (await readRequestBody(request)) as { runId?: string };
      const requestedRunId = typeof body.runId === "string" ? body.runId.trim() : "";
      const conversation = await conversationStore.get(conversationId);
      if (!conversation || !canAccessConversation(conversation)) {
        writeJson(response, 404, {
          code: "CONVERSATION_NOT_FOUND",
          message: "Conversation not found",
        });
        return;
      }
      const activeRun = activeConversationRuns.get(conversationId);
      if (!activeRun || (ctx.tenantId !== undefined && activeRun.ownerId !== ownerId)) {
        writeJson(response, 200, {
          ok: true,
          stopped: false,
        } satisfies ApiStopRunResponse);
        return;
      }
      if (activeRun.abortController.signal.aborted) {
        activeConversationRuns.delete(conversationId);
        writeJson(response, 200, {
          ok: true,
          stopped: false,
        } satisfies ApiStopRunResponse);
        return;
      }
      if (requestedRunId && activeRun.runId !== requestedRunId) {
        writeJson(response, 200, {
          ok: true,
          stopped: false,
          runId: activeRun.runId ?? undefined,
        } satisfies ApiStopRunResponse);
        return;
      }
      if (!requestedRunId) {
        writeJson(response, 200, {
          ok: true,
          stopped: false,
          runId: activeRun.runId ?? undefined,
        } satisfies ApiStopRunResponse);
        return;
      }
      activeRun.abortController.abort();
      await clearPendingApprovalsForConversation(conversationId);
      writeJson(response, 200, {
        ok: true,
        stopped: true,
        runId: activeRun.runId ?? undefined,
      } satisfies ApiStopRunResponse);
      return;
    }

    const uploadMatch = pathname.match(/^\/api\/uploads\/(.+)$/);
    if (uploadMatch && request.method === "GET") {
      const key = decodeURIComponent(uploadMatch[1] ?? "");
      try {
        const data = await uploadStore.get(key);
        const ext = key.split(".").pop() ?? "";
        const mimeMap: Record<string, string> = {
          jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
          gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
          pdf: "application/pdf", mp4: "video/mp4", webm: "video/webm",
          mp3: "audio/mpeg", wav: "audio/wav", txt: "text/plain",
          json: "application/json", csv: "text/csv", html: "text/html",
        };
        response.writeHead(200, {
          "Content-Type": mimeMap[ext] ?? "application/octet-stream",
          "Content-Length": data.length,
          "Cache-Control": "public, max-age=86400",
        });
        response.end(data);
      } catch {
        writeJson(response, 404, { code: "NOT_FOUND", message: "Upload not found" });
      }
      return;
    }

    const vfsMatch = pathname.match(/^\/api\/vfs\/(.+)$/);
    if (vfsMatch && request.method === "GET") {
      const vfsPath = "/" + decodeURIComponent(vfsMatch[1] ?? "");
      const tenantId = ctx.tenantId ?? "__default__";
      const engine = harness.storageEngine;
      if (!engine) {
        writeJson(response, 500, { code: "NO_ENGINE", message: "Storage engine not available" });
        return;
      }
      try {
        const stat = await engine.vfs.stat(tenantId, vfsPath);
        if (!stat || stat.type !== "file") {
          writeJson(response, 404, { code: "NOT_FOUND", message: "File not found in VFS" });
          return;
        }
        const data = await engine.vfs.readFile(tenantId, vfsPath);
        const ext = vfsPath.split(".").pop()?.toLowerCase() ?? "";
        const mimeMap: Record<string, string> = {
          jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
          gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
          pdf: "application/pdf", mp4: "video/mp4", webm: "video/webm",
          mp3: "audio/mpeg", wav: "audio/wav", txt: "text/plain",
          json: "application/json", csv: "text/csv", html: "text/html",
          xml: "application/xml", zip: "application/zip",
          doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        };
        const contentType = stat.mimeType ?? mimeMap[ext] ?? "application/octet-stream";
        const filename = vfsPath.split("/").pop() ?? "download";
        const inline = contentType.startsWith("image/") || contentType.startsWith("text/") || contentType === "application/pdf";
        response.writeHead(200, {
          "Content-Type": contentType,
          "Content-Length": data.length,
          "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${filename}"`,
          "Cache-Control": "no-cache",
        });
        response.end(Buffer.from(data));
      } catch {
        writeJson(response, 404, { code: "NOT_FOUND", message: "File not found in VFS" });
      }
      return;
    }

    if (pathname === "/api/slash-commands" && request.method === "GET") {
      const skills: ApiSlashCommand[] = harness.listSkills().map((s) => ({
        command: "/" + s.name,
        description: s.description,
        type: "skill" as const,
      }));
      const builtIn: ApiSlashCommand[] = [
        { command: "/compact", description: "Compact conversation context", type: "command" as const },
      ];
      writeJson(response, 200, { commands: [...builtIn, ...skills] });
      return;
    }

    const conversationCompactMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/compact$/);
    if (conversationCompactMatch && request.method === "POST") {
      const conversationId = decodeURIComponent(conversationCompactMatch[1] ?? "");
      const conversation = await conversationStore.get(conversationId);
      if (!conversation || !canAccessConversation(conversation)) {
        writeJson(response, 404, {
          code: "CONVERSATION_NOT_FOUND",
          message: "Conversation not found",
        });
        return;
      }
      const activeRun = activeConversationRuns.get(conversationId);
      if (activeRun && activeRun.ownerId === ownerId && !activeRun.abortController.signal.aborted) {
        writeJson(response, 409, {
          code: "RUN_IN_PROGRESS",
          message: "Cannot compact while a run is active",
        });
        return;
      }
      const body = (await readRequestBody(request)) as { instructions?: string };
      const instructions = typeof body.instructions === "string" ? body.instructions.trim() || undefined : undefined;
      const result = await harness.compact(
        conversation.messages,
        instructions ? { instructions } : undefined,
      );
      if (result.compacted) {
        const existingHistory = conversation.compactedHistory ?? [];
        const preservedCount = result.messages.length - 1; // exclude summary
        const removedCount = conversation.messages.length - preservedCount;
        conversation.compactedHistory = [
          ...existingHistory,
          ...conversation.messages.slice(0, removedCount),
        ];
        conversation.messages = result.messages;
        conversation._harnessMessages = undefined;
        await conversationStore.update(conversation);
      }
      writeJson(response, 200, {
        compacted: result.compacted,
        messagesBefore: result.messagesBefore ?? 0,
        messagesAfter: result.messagesAfter ?? 0,
        warning: result.warning,
      } satisfies ApiCompactResponse);
      return;
    }

    // ── Public continuation endpoint (SSE) ──
    const conversationContinueMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/continue$/);
    if (conversationContinueMatch && request.method === "POST") {
      const conversationId = decodeURIComponent(conversationContinueMatch[1] ?? "");
      const conversation = await conversationStore.get(conversationId);
      if (!conversation || !canAccessConversation(conversation)) {
        writeJson(response, 404, {
          code: "CONVERSATION_NOT_FOUND",
          message: "Conversation not found",
        });
        return;
      }
      if (conversation.subagentMeta) {
        writeJson(response, 403, {
          code: "SUBAGENT_READ_ONLY",
          message: "Subagent conversations are read-only.",
        });
        return;
      }

      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      const unsubSubagentEvents = onConversationEvent(conversationId, (evt) => {
        if (evt.type.startsWith("subagent:")) {
          try { response.write(formatSseEvent(evt)); } catch {}
        }
      });

      let eventCount = 0;
      try {
        await runContinuation(conversationId, async (event) => {
          eventCount++;
          let sseEvent: AgentEvent = event;
          if (sseEvent.type === "run:completed") {
            const hasPendingSubagents = await hasPendingSubagentWorkForParent(conversationId, ownerId);
            const stripped = { ...sseEvent, result: { ...sseEvent.result, continuationMessages: undefined } };
            sseEvent = hasPendingSubagents ? { ...stripped, pendingSubagents: true } : stripped;
          }
          try {
            response.write(formatSseEvent(sseEvent));
          } catch {
            // Client disconnected — continue processing so the run completes
          }
          emitBrowserStatusIfActive(conversationId, event, response);
        });
      } catch (err) {
        const errorEvent: AgentEvent = {
          type: "run:error",
          runId: "",
          error: { code: "CONTINUATION_ERROR", message: err instanceof Error ? err.message : String(err) },
        };
        try { response.write(formatSseEvent(errorEvent)); } catch {}
      } finally {
        unsubSubagentEvents();
      }

      if (eventCount === 0) {
        try { response.write("event: stream:end\ndata: {}\n\n"); } catch {}
      } else {
        // If the run produced events and another continuation is needed,
        // fire a delayed safety net in case the client disconnects before
        // POSTing the next /continue.
        const freshConv = await conversationStore.get(conversationId);
        if (
          freshConv?._continuationMessages?.length &&
          (!Array.isArray(freshConv.pendingApprovals) || freshConv.pendingApprovals.length === 0)
        ) {
          doWaitUntil(
            new Promise(r => setTimeout(r, 3000)).then(() =>
              selfFetchWithRetry(`/api/internal/continue/${encodeURIComponent(conversationId)}`),
            ),
          );
        }
      }
      response.end();
      return;
    }

    const conversationMessageMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
    if (conversationMessageMatch && request.method === "POST") {
      const conversationId = decodeURIComponent(conversationMessageMatch[1] ?? "");
      // getWithArchive — conversation feeds withToolResultArchiveParam when
      // the turn below calls executeConversationTurn.
      const conversation = await conversationStore.getWithArchive(conversationId);
      if (!conversation || !canAccessConversation(conversation)) {
        writeJson(response, 404, {
          code: "CONVERSATION_NOT_FOUND",
          message: "Conversation not found",
        });
        return;
      }
      if (conversation.subagentMeta) {
        writeJson(response, 403, {
          code: "SUBAGENT_READ_ONLY",
          message: "Subagent conversations are read-only. Only the parent agent can send messages.",
        });
        return;
      }
      let messageText = "";
      let bodyParameters: Record<string, unknown> | undefined;
      let files: FileInput[] = [];

      const contentType = request.headers["content-type"] ?? "";
      if (contentType.includes("multipart/form-data")) {
        const parsed = await parseMultipartRequest(request);
        messageText = parsed.message.trim();
        bodyParameters = parsed.parameters;
        files = parsed.files;
      } else {
        const body = (await readRequestBody(request)) as {
          message?: string;
          parameters?: Record<string, unknown>;
          files?: Array<{ data?: string; mediaType?: string; filename?: string }>;
        };
        messageText = body.message?.trim() ?? "";
        bodyParameters = body.parameters;
        if (Array.isArray(body.files)) {
          files = body.files
            .filter((f): f is { data: string; mediaType: string; filename?: string } =>
              typeof f.data === "string" && typeof f.mediaType === "string",
            );
        }
      }
      if (!messageText) {
        writeJson(response, 400, {
          code: "VALIDATION_ERROR",
          message: "message is required",
        });
        return;
      }
      const activeRun = activeConversationRuns.get(conversationId);
      if (activeRun && activeRun.ownerId === ownerId) {
        if (activeRun.abortController.signal.aborted) {
          activeConversationRuns.delete(conversationId);
        } else {
          writeJson(response, 409, {
            code: "RUN_IN_PROGRESS",
            message: "A run is already active for this conversation",
          });
          return;
        }
      }
      const abortController = new AbortController();
      activeConversationRuns.set(conversationId, {
        ownerId,
        abortController,
        runId: null,
      });
      if (
        conversation.messages.length === 0 &&
        (conversation.title === "New conversation" || conversation.title.trim().length === 0)
      ) {
        conversation.title = inferConversationTitle(messageText);
      }
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const canonicalHistory = resolveRunRequest(conversation, {
        conversationId,
        messages: conversation.messages,
      });
      const shouldRebuildCanonical = canonicalHistory.shouldRebuildCanonical;
      const harnessMessages = [...canonicalHistory.messages];
      const historyMessages = [...conversation.messages];
      const preRunMessages = [...conversation.messages];
      log.debug(
        `conversation=${conversationId.slice(0, 8)} history=${canonicalHistory.source}`,
      );
      let latestRunId = conversation.runtimeRunId ?? "";
      let userContent: Message["content"] | undefined = messageText;
      if (files.length > 0) {
        try {
          const uploadedParts = await Promise.all(
            files.map(async (f) => {
              const buf = Buffer.from(f.data, "base64");
              const key = deriveUploadKey(buf, f.mediaType);
              const ref = await uploadStore.put(key, buf, f.mediaType);
              return {
                type: "file" as const,
                data: ref,
                mediaType: f.mediaType,
                filename: f.filename,
              };
            }),
          );
          userContent = [
            { type: "text" as const, text: messageText },
            ...uploadedParts,
          ];
        } catch (uploadErr) {
          const errMsg = uploadErr instanceof Error ? uploadErr.message : String(uploadErr);
          uploadLog.error(`file upload failed: ${errMsg}`);
          const errorEvent: AgentEvent = {
            type: "run:error",
            runId: "",
            error: { code: "UPLOAD_ERROR", message: `File upload failed: ${errMsg}` },
          };
          broadcastEvent(conversationId, errorEvent);
          finishConversationStream(conversationId);
          activeConversationRuns.delete(conversationId);
          response.end();
          return;
        }
      }
      const unsubSubagentEvents = onConversationEvent(conversationId, (evt) => {
        if (evt.type.startsWith("subagent:")) {
          try { response.write(formatSseEvent(evt)); } catch {}
        }
      });

      const draft = createTurnDraftState();
      let checkpointedRun = false;
      let runCancelled = false;
      let runContinuationMessages: Message[] | undefined;

      // Hoist stable ids for this turn. The same userMessage / assistantId is
      // reused across every buildMessages() call so the in-flight assistant
      // bubble keeps a stable metadata.id from its very first persisted byte.
      const turnTimestamp = Date.now();
      const userMessage: Message | undefined = userContent != null
        ? {
            role: "user" as const,
            content: userContent,
            metadata: { id: randomUUID(), timestamp: turnTimestamp },
          }
        : undefined;
      const assistantId = randomUUID();

      const buildMessages = (): Message[] => {
        const draftSections = cloneSections(draft.sections);
        if (draft.currentTools.length > 0) {
          draftSections.push({ type: "tools", content: [...draft.currentTools] });
        }
        if (draft.currentText.length > 0) {
          draftSections.push({ type: "text", content: draft.currentText });
        }
        const userTurn: Message[] = userMessage ? [userMessage] : [];
        const hasDraftContent =
          draft.assistantResponse.length > 0 || draft.toolTimeline.length > 0 || draftSections.length > 0;
        if (!hasDraftContent) {
          return [...historyMessages, ...userTurn];
        }
        return [
          ...historyMessages,
          ...userTurn,
          {
            role: "assistant" as const,
            content: draft.assistantResponse,
            metadata: buildAssistantMetadata(draft, draftSections, { id: assistantId, timestamp: turnTimestamp }),
          },
        ];
      };

      const persistDraftAssistantTurn = async (): Promise<void> => {
        if (draft.assistantResponse.length === 0 && draft.toolTimeline.length === 0) return;
        conversation.messages = buildMessages();
        conversation.updatedAt = Date.now();
        await conversationStore.update(conversation);
      };

      try {
        {
          conversation.messages = [
            ...historyMessages,
            ...(userMessage ? [userMessage] : []),
          ];
          conversation.subagentCallbackCount = 0;
          conversation._continuationCount = undefined;
          conversation.updatedAt = Date.now();
          conversationStore.update(conversation).catch((err) => {
            log.error(`failed to persist user turn: ${formatError(err)}`);
          });
        }

        const execution = await executeConversationTurn({
          harness,
          runInput: {
            task: messageText,
            conversationId,
            tenantId: ctx.tenantId ?? undefined,
            parameters: buildTurnParameters(conversation, { bodyParameters }),
            messages: harnessMessages,
            files: files.length > 0 ? files : undefined,
            abortSignal: abortController.signal,
          },
          initialContextTokens: conversation.contextTokens ?? 0,
          initialContextWindow: conversation.contextWindow ?? 0,
          onEvent: async (event, eventDraft) => {
            draft.assistantResponse = eventDraft.assistantResponse;
            draft.toolTimeline = eventDraft.toolTimeline;
            draft.sections = eventDraft.sections;
            draft.currentTools = eventDraft.currentTools;
            draft.currentText = eventDraft.currentText;

            if (event.type === "run:started") {
              latestRunId = event.runId;
              runOwners.set(event.runId, ownerId);
              runConversations.set(event.runId, conversationId);
              const active = activeConversationRuns.get(conversationId);
              if (active && active.abortController === abortController) {
                active.runId = event.runId;
              }
            }
            if (event.type === "run:cancelled") {
              runCancelled = true;
            }
            if (event.type === "compaction:completed") {
              if (event.compactedMessages) {
                historyMessages.length = 0;
                historyMessages.push(...event.compactedMessages);

                const preservedFromHistory = historyMessages.length - 1;
                const removedCount = preRunMessages.length - Math.max(0, preservedFromHistory);
                const existingHistory = conversation.compactedHistory ?? [];
                conversation.compactedHistory = [
                  ...existingHistory,
                  ...preRunMessages.slice(0, removedCount),
                ];
              }
            }
            if (event.type === "step:completed") {
              await persistDraftAssistantTurn();
            }
            if (event.type === "tool:approval:required") {
              const toolText = `- approval required \`${event.tool}\``;
              draft.toolTimeline.push(toolText);
              draft.currentTools.push(toolText);
              const existingApprovals = Array.isArray(conversation.pendingApprovals)
                ? conversation.pendingApprovals
                : [];
              if (!existingApprovals.some((approval) => approval.approvalId === event.approvalId)) {
                conversation.pendingApprovals = [
                  ...existingApprovals,
                  {
                    approvalId: event.approvalId,
                    runId: latestRunId || conversation.runtimeRunId || "",
                    tool: event.tool,
                    toolCallId: undefined,
                    input: (event.input ?? {}) as Record<string, unknown>,
                    checkpointMessages: undefined,
                    baseMessageCount: historyMessages.length,
                    pendingToolCalls: [],
                  },
                ];
                conversation.updatedAt = Date.now();
                await conversationStore.update(conversation);
              }
              await persistDraftAssistantTurn();
            }
            if (event.type === "tool:approval:checkpoint") {
              conversation.messages = buildMessages();
              conversation.pendingApprovals = buildApprovalCheckpoints({
                approvals: event.approvals,
                runId: latestRunId,
                checkpointMessages: event.checkpointMessages,
                baseMessageCount: historyMessages.length,
                pendingToolCalls: event.pendingToolCalls,
              });
              conversation._toolResultArchive = harness.getToolResultArchive(conversationId);
              conversation.updatedAt = Date.now();
              await conversationStore.update(conversation);
              checkpointedRun = true;
            }
            if (event.type === "run:completed") {
              if (event.result.continuation && event.result.continuationMessages) {
                runContinuationMessages = event.result.continuationMessages;

                conversation.messages = buildMessages();
                conversation._continuationMessages = runContinuationMessages;
                conversation._harnessMessages = runContinuationMessages;
                conversation._toolResultArchive = harness.getToolResultArchive(conversationId);
                conversation.runtimeRunId = latestRunId || conversation.runtimeRunId;
                if (!checkpointedRun) {
                  conversation.pendingApprovals = [];
                }
                if ((event.result.contextTokens ?? 0) > 0) conversation.contextTokens = event.result.contextTokens!;
                if ((event.result.contextWindow ?? 0) > 0) conversation.contextWindow = event.result.contextWindow!;
                conversation.updatedAt = Date.now();
                await conversationStore.update(conversation);

                if (!checkpointedRun) {
                  doWaitUntil(
                    new Promise(r => setTimeout(r, 3000)).then(() =>
                      selfFetchWithRetry(`/api/internal/continue/${encodeURIComponent(conversationId)}`),
                    ),
                  );
                }
              }
            }

            await telemetry.emit(event);
            let sseEvent: AgentEvent = event.type === "compaction:completed" && event.compactedMessages
              ? { ...event, compactedMessages: undefined }
              : event;
            if (sseEvent.type === "run:completed") {
              const hasPendingSubagents = await hasPendingSubagentWorkForParent(conversationId, ownerId);
              const stripped = { ...sseEvent, result: { ...sseEvent.result, continuationMessages: undefined } };
              if (hasPendingSubagents) {
                sseEvent = { ...stripped, pendingSubagents: true };
              } else {
                sseEvent = stripped;
              }
            }
            broadcastEvent(conversationId, sseEvent);
            try {
              response.write(formatSseEvent(sseEvent));
            } catch {
              // Client disconnected — continue processing so the run completes.
            }
            emitBrowserStatusIfActive(conversationId, event, response);
          },
        });

        flushTurnDraft(draft);
        latestRunId = execution.latestRunId || latestRunId;

        if (!checkpointedRun && !runContinuationMessages) {
          conversation.messages = buildMessages();
          applyTurnMetadata(conversation, {
            latestRunId,
            contextTokens: execution.runContextTokens,
            contextWindow: execution.runContextWindow,
            harnessMessages: execution.runHarnessMessages,
            toolResultArchive: harness.getToolResultArchive(conversationId),
          }, { shouldRebuildCanonical });
          await conversationStore.update(conversation);
        }
      } catch (error) {
        flushTurnDraft(draft);
        if (abortController.signal.aborted || runCancelled) {
          if (draft.assistantResponse.length > 0 || draft.toolTimeline.length > 0 || draft.sections.length > 0) {
            conversation.messages = buildMessages();
            conversation.updatedAt = Date.now();
            await conversationStore.update(conversation);
          }
          if (!checkpointedRun) {
            await clearPendingApprovalsForConversation(conversationId);
          }
          return;
        }
        try {
          response.write(
            formatSseEvent({
              type: "run:error",
              runId: latestRunId || "run_unknown",
              error: {
                code: "RUN_ERROR",
                message: error instanceof Error ? error.message : "Unknown error",
              },
            }),
          );
        } catch {
          if (draft.assistantResponse.length > 0 || draft.toolTimeline.length > 0 || draft.sections.length > 0) {
            conversation.messages = buildMessages();
            conversation.updatedAt = Date.now();
            await conversationStore.update(conversation);
          }
        }
      } finally {
        unsubSubagentEvents();
        const active = activeConversationRuns.get(conversationId);
        if (active && active.abortController === abortController) {
          activeConversationRuns.delete(conversationId);
        }
        if (latestRunId) {
          runOwners.delete(latestRunId);
          runConversations.delete(latestRunId);
        }

        const hadDeferred = pendingCallbackNeeded.delete(conversationId);
        const freshConv = await conversationStore.get(conversationId);
        const needsCallback = hadDeferred || !!freshConv?.pendingSubagentResults?.length;
        const hasRunningChildren = Array.from(activeSubagentRuns.values()).some(
          (run) => run.parentConversationId === conversationId,
        );

        if (!needsCallback && !hasRunningChildren) {
          finishConversationStream(conversationId);
        }

        try {
          response.end();
        } catch {
          // Already closed.
        }
        if (needsCallback) {
          processSubagentCallback(conversationId, true).catch(err =>
            subagentLog.error(`post-run callback failed: ${formatError(err)}`),
          );
        }
      }
      return;
    }

    // ── Cron job endpoint ──────────────────────────────────────────
    const cronMatch = pathname.match(/^\/api\/cron\/([^/]+)$/);
    if (cronMatch && (request.method === "GET" || request.method === "POST")) {
      const jobName = decodeURIComponent(cronMatch[1] ?? "");
      const cronJob = cronJobs[jobName];
      if (!cronJob) {
        writeJson(response, 404, {
          code: "CRON_JOB_NOT_FOUND",
          message: `Cron job "${jobName}" is not defined in AGENT.md`,
        });
        return;
      }

      const urlObj = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

      const cronOwnerId = ownerId;
      const start = Date.now();

      if (cronJob.channel) {
        const adapter = messagingAdapters.get(cronJob.channel);
        if (!adapter) {
          writeJson(response, 200, {
            status: "skipped",
            reason: `${cronJob.channel} adapter not available`,
            duration: Date.now() - start,
          });
          return;
        }

        try {
          const summaries = await conversationStore.listSummaries(cronOwnerId);
          const targetSummaries = new Map<string, ConversationSummary>();
          for (const s of summaries) {
            if (s.channelMeta?.platform !== cronJob.channel) continue;
            const key = s.channelMeta.channelId;
            const existing = targetSummaries.get(key);
            if (!existing || s.updatedAt > (existing.updatedAt ?? 0)) {
              targetSummaries.set(key, s);
            }
          }

          if (targetSummaries.size === 0) {
            writeJson(response, 200, {
              status: "skipped",
              reason: `no known ${cronJob.channel} chats`,
              duration: Date.now() - start,
            });
            return;
          }

          const chatResults: Array<{ chatId: string; status: string; steps?: number }> = [];
          for (const [chatId, summary] of targetSummaries) {
            // getWithArchive — conv feeds runCronAgent below which needs the
            // archive to reseed the harness.
            const conv = await conversationStore.getWithArchive(summary.conversationId);
            if (!conv) continue;

            const task = `[Scheduled: ${jobName}]\n${cronJob.task}`;
            const historySelection = resolveRunRequest(conv, {
              conversationId: conv.conversationId,
              messages: conv.messages,
            });
            const historyMessages = [...historySelection.messages];
            try {
              const result = await runCronAgent(harness, task, conv.conversationId, historyMessages,
                conv._toolResultArchive,
                async (event) => { await telemetry.emit(event); },
                buildTurnParameters(conv),
                conv.tenantId,
              );

              const freshConv = await conversationStore.get(conv.conversationId);
              if (freshConv) {
                appendCronTurn(freshConv, task, result);
                applyTurnMetadata(freshConv, result, {
                  clearContinuation: false,
                  clearApprovals: false,
                  setIdle: false,
                  shouldRebuildCanonical: historySelection.shouldRebuildCanonical,
                });
                await conversationStore.update(freshConv);
              }

              if (result.response) {
                try {
                  await adapter.sendReply(
                    {
                      channelId: chatId,
                      platformThreadId: (freshConv ?? conv).channelMeta?.platformThreadId ?? chatId,
                    },
                    result.response,
                  );
                } catch (sendError) {
                  cronLog.child(jobName).error(`send to ${chatId} failed: ${formatError(sendError)}`);
                }
              }
              chatResults.push({ chatId, status: "completed", steps: result.steps });
            } catch (runError) {
              chatResults.push({ chatId, status: "error" });
              cronLog.child(jobName).error(`run for chat ${chatId} failed: ${formatError(runError)}`);
            }
          }

          writeJson(response, 200, {
            status: "completed",
            chats: chatResults.length,
            results: chatResults,
            duration: Date.now() - start,
          });
        } catch (error) {
          writeJson(response, 500, {
            code: "CRON_RUN_ERROR",
            message: error instanceof Error ? error.message : "Unknown error",
          });
        }
        return;
      }

      try {
        const timestamp = new Date().toISOString();
        const conversation = await conversationStore.create(
          cronOwnerId,
          `[cron] ${jobName} ${timestamp}`,
        );

        const convId = conversation.conversationId;
        activeConversationRuns.set(convId, {
          ownerId: conversation.ownerId,
          abortController: new AbortController(),
          runId: null,
        });

        try {
          const result = await runCronAgent(harness, cronJob.task, convId, [],
            conversation._toolResultArchive,
            async (event) => {
              broadcastEvent(convId, event);
              await telemetry.emit(event);
            },
            buildTurnParameters(conversation),
            conversation.tenantId,
          );
          finishConversationStream(convId);

          const freshConv = await conversationStore.get(convId);
          if (freshConv) {
            freshConv.messages = buildCronMessages(cronJob.task, [], result);
            applyTurnMetadata(freshConv, result, {
              clearApprovals: false,
              setIdle: false,
            });
            await conversationStore.update(freshConv);
          }

          const pruneWork = pruneCronConversations(
            conversationStore, cronOwnerId, jobName, cronJob.maxRuns ?? 5,
          ).then(n => {
            if (n > 0) cronLog.child(jobName).item(`pruned ${n} old conversation${n === 1 ? "" : "s"}`);
          }).catch(err =>
            cronLog.child(jobName).error(`prune failed: ${formatError(err)}`),
          );
          doWaitUntil(pruneWork);

          if (result.continuation) {
            const work = selfFetchWithRetry(`/api/internal/continue/${encodeURIComponent(convId)}`).catch(err =>
              cronLog.child(jobName).error(`continuation self-fetch failed: ${formatError(err)}`),
            );
            doWaitUntil(work);
            writeJson(response, 200, {
              conversationId: convId,
              status: "continued",
              duration: Date.now() - start,
            });
            return;
          }

          writeJson(response, 200, {
            conversationId: convId,
            status: "completed",
            response: result.response.slice(0, 500),
            duration: Date.now() - start,
            steps: result.steps,
          });
        } finally {
          activeConversationRuns.delete(convId);
          const hadDeferred = pendingCallbackNeeded.delete(convId);
          const checkConv = await conversationStore.get(convId);
          if (hadDeferred || checkConv?.pendingSubagentResults?.length) {
            if (isServerless) {
              selfFetchWithRetry(`/api/internal/conversations/${encodeURIComponent(convId)}/subagent-callback`).catch(err =>
                cronLog.error(`subagent callback self-fetch failed: ${formatError(err)}`),
              );
            } else {
              processSubagentCallback(convId, true).catch(err =>
                cronLog.error(`subagent callback failed: ${formatError(err)}`),
              );
            }
          }
        }
      } catch (error) {
        writeJson(response, 500, {
          code: "CRON_RUN_ERROR",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
      return;
    }

    // ── Reminders check endpoint ────────────────────────────────────
    if (pathname === "/api/reminders/check" && (request.method === "GET" || request.method === "POST")) {
      const result = await checkAndFireReminders();
      writeJson(response, 200, result);
      return;
    }

    writeJson(response, 404, { error: "Not found" });
  };

  // ── Reminder polling logic ──────────────────────────────────────
  const DEFAULT_POLL_SCHEDULE = "*/10 * * * *";

  const pollScheduleToMs = (schedule: string): number => {
    const m = schedule.match(/^\*\/(\d+)\s/);
    if (m) return Number(m[1]) * 60 * 1000;
    return 10 * 60 * 1000;
  };

  const reminderPollSchedule = config?.reminders?.pollSchedule ?? DEFAULT_POLL_SCHEDULE;
  const reminderPollWindowMs = pollScheduleToMs(reminderPollSchedule);

  const checkAndFireReminders = async (): Promise<{
    fired: string[];
    count: number;
    duration: number;
  }> => {
    const reminderStore = harness.reminderStore;
    if (!reminderStore) return { fired: [], count: 0, duration: 0 };

    const start = Date.now();
    const firedIds: string[] = [];

    try {
      const reminders = await reminderStore.list();
      const cutoff = Date.now() + reminderPollWindowMs;
      const due = reminders.filter((r) => r.status === "pending" && r.scheduledAt <= cutoff);

      for (const reminder of due) {
        try {
          // For recurring reminders, compute the next occurrence before any
          // state changes so we can reschedule. For one-off reminders, delete.
          const nextScheduledAt = computeNextOccurrence(reminder);
          if (nextScheduledAt) {
            await reminderStore.update(reminder.id, {
              scheduledAt: nextScheduledAt,
              occurrenceCount: (reminder.occurrenceCount ?? 0) + 1,
            });
          } else {
            await reminderStore.delete(reminder.id);
          }

          const originConv = reminder.conversationId
            // getWithArchive — originConv feeds runCronAgent below which
            // needs the archive to reseed the harness.
            ? await conversationStore.getWithArchive(reminder.conversationId)
            : undefined;
          const channelMeta = originConv?.channelMeta;

          const isRecurring = !!reminder.recurrence;
          const recurrenceNote = isRecurring && nextScheduledAt
            ? `\nNext occurrence: ${new Date(nextScheduledAt).toISOString()}`
            : isRecurring
              ? "\nThis was the final occurrence."
              : "";

          const framedMessage =
            `[Reminder] A reminder you previously set has fired.\n` +
            `Task: "${reminder.task}"\n` +
            `Originally set at: ${new Date(reminder.createdAt).toISOString()}\n` +
            `Scheduled for: ${new Date(reminder.scheduledAt).toISOString()}` +
            recurrenceNote;

          if (channelMeta) {
            const adapter = messagingAdapters.get(channelMeta.platform);
            if (adapter && originConv) {
              const result = await runCronAgent(
                harness, framedMessage, originConv.conversationId,
                originConv.messages ?? [],
                originConv._toolResultArchive,
                undefined,
                buildTurnParameters(originConv),
                originConv.tenantId,
              );
              if (result.response) {
                try {
                  await adapter.sendReply(
                    {
                      channelId: channelMeta.channelId,
                      platformThreadId: channelMeta.platformThreadId ?? channelMeta.channelId,
                    },
                    result.response,
                  );
                } catch (sendError) {
                  reminderLog.error(`send to ${channelMeta.platform} failed: ${formatError(sendError)}`);
                }
              }
              const freshConv = await conversationStore.get(originConv.conversationId);
              if (freshConv) {
                appendCronTurn(freshConv, framedMessage, result);
                applyTurnMetadata(freshConv, result, {
                  clearContinuation: false,
                  clearApprovals: false,
                  setIdle: false,
                });
                await conversationStore.update(freshConv);
              }
            }
          } else {
            const timestamp = new Date().toISOString();
            const conversation = await conversationStore.create(
              reminder.ownerId ?? "local-owner",
              `[reminder] ${reminder.task.slice(0, 80)} ${timestamp}`,
            );
            const convId = conversation.conversationId;
            const result = await runCronAgent(
              harness, framedMessage, convId, [],
              undefined,
              undefined,
              buildTurnParameters(conversation),
              conversation.tenantId,
            );
            const freshConv = await conversationStore.get(convId);
            if (freshConv) {
              freshConv.messages = buildCronMessages(framedMessage, [], result);
              applyTurnMetadata(freshConv, result, {
                clearContinuation: false,
                clearApprovals: false,
                setIdle: false,
              });
              await conversationStore.update(freshConv);
            }
          }

          firedIds.push(reminder.id);
        } catch (err) {
          reminderLog.error(`failed to fire reminder "${reminder.id}": ${formatError(err)}`);
        }
      }
    } catch (err) {
      reminderLog.error(`error checking reminders: ${formatError(err)}`);
    }

    return { fired: firedIds, count: firedIds.length, duration: Date.now() - start };
  };

  handler._harness = harness;
  handler._cronJobs = cronJobs;
  handler._conversationStore = conversationStore;
  handler._messagingAdapters = messagingAdapters;
  handler._activeConversationRuns = activeConversationRuns;
  handler._pendingCallbackNeeded = pendingCallbackNeeded;
  handler._processSubagentCallback = processSubagentCallback;
  handler._broadcastEvent = broadcastEvent;
  handler._finishConversationStream = finishConversationStream;
  handler._checkAndFireReminders = checkAndFireReminders;
  handler._reminderPollIntervalMs = reminderPollWindowMs;
  handler._buildTurnParameters = buildTurnParameters;

  // Recover stale subagent runs that were "running" when the server last stopped
  orchestrator.recoverStaleSubagents().catch(err =>
    subagentLog.warn(`failed to recover stale subagent runs: ${formatError(err)}`),
  );

  return handler;
};

export const startDevServer = async (
  port: number,
  options?: { workingDir?: string },
): Promise<Server> => {
  const workingDir = options?.workingDir ?? process.cwd();
  const handler = await createRequestHandler(options);
  const server = createServer(handler);
  const actualPort = await listenOnAvailablePort(server, port);
  if (actualPort !== port) {
    log.warn(`port ${port} in use, switched to ${num(actualPort)}`);
  }
  log.ready(`dev server ready at ${url(`http://localhost:${actualPort}`)}`);

  await checkVercelCronDrift(workingDir);

  // ── Cron scheduler ─────────────────────────────────────────────
  const { Cron } = await import("croner");
  type CronJob = InstanceType<typeof Cron>;
  let activeJobs: CronJob[] = [];

  const scheduleCronJobs = (jobs: Record<string, CronJobConfig>): void => {
    for (const job of activeJobs) {
      job.stop();
    }
    activeJobs = [];

    const entries = Object.entries(jobs);
    if (entries.length === 0) return;

    const harnessRef = handler._harness;
    const store = handler._conversationStore;
    const adapters = handler._messagingAdapters;
    const activeRuns = handler._activeConversationRuns;
    const deferredCallbacks = handler._pendingCallbackNeeded;
    const runCallback = handler._processSubagentCallback;
    const buildParams = handler._buildTurnParameters;
    if (!harnessRef || !store) return;

    for (const [jobName, config] of entries) {
      const job = new Cron(
        config.schedule,
        { timezone: config.timezone ?? "UTC" },
        async () => {
          const jobLog = cronLog.child(jobName);
          const timestamp = new Date().toISOString();
          jobLog.info(`started`);
          const start = Date.now();

          if (config.channel) {
            const adapter = adapters?.get(config.channel);
            if (!adapter) {
              jobLog.warn(`${config.channel} adapter not available, skipping`);
              return;
            }
            try {
              const summaries = await store.listSummaries("local-owner");
              const targetSummaries = new Map<string, ConversationSummary>();
              for (const s of summaries) {
                if (s.channelMeta?.platform !== config.channel) continue;
                const key = s.channelMeta.channelId;
                const existing = targetSummaries.get(key);
                if (!existing || s.updatedAt > (existing.updatedAt ?? 0)) {
                  targetSummaries.set(key, s);
                }
              }

              if (targetSummaries.size === 0) {
                jobLog.item(`no known ${config.channel} chats, skipping`);
                return;
              }

              let totalChats = 0;
              for (const [chatId, summary] of targetSummaries) {
                // getWithArchive — conversation feeds runCronAgent below
                // which needs the archive to reseed the harness.
                const conversation = await store.getWithArchive(summary.conversationId);
                if (!conversation) continue;

                const task = `[Scheduled: ${jobName}]\n${config.task}`;
                const historySelection = resolveRunRequest(conversation, {
                  conversationId: conversation.conversationId,
                  messages: conversation.messages,
                });
                const historyMessages = [...historySelection.messages];
                const convId = conversation.conversationId;

                activeRuns?.set(convId, {
                  ownerId: "local-owner",
                  abortController: new AbortController(),
                  runId: null,
                });
                try {
                  const broadcastCh = handler._broadcastEvent;
                  const result = await runCronAgent(harnessRef, task, convId, historyMessages,
                    conversation._toolResultArchive,
                    broadcastCh ? (ev) => broadcastCh(convId, ev) : undefined,
                    buildParams?.(conversation),
                    conversation.tenantId,
                  );
                  handler._finishConversationStream?.(convId);

                  const freshConv = await store.get(convId);
                  if (freshConv) {
                    appendCronTurn(freshConv, task, result);
                    applyTurnMetadata(freshConv, result, {
                      clearContinuation: false,
                      clearApprovals: false,
                      setIdle: false,
                      shouldRebuildCanonical: historySelection.shouldRebuildCanonical,
                    });
                    await store.update(freshConv);

                    if (result.response) {
                      try {
                        await adapter.sendReply(
                          {
                            channelId: chatId,
                            platformThreadId: freshConv.channelMeta?.platformThreadId ?? chatId,
                          },
                          result.response,
                        );
                      } catch (sendError) {
                        jobLog.error(`send to ${chatId} failed: ${formatError(sendError)}`);
                      }
                    }
                  }
                  totalChats++;
                } catch (runError) {
                  jobLog.error(`run for chat ${chatId} failed: ${formatError(runError)}`);
                } finally {
                  activeRuns?.delete(convId);
                  const hadDeferred = deferredCallbacks?.delete(convId) ?? false;
                  const checkConv = await store.get(convId);
                  if (hadDeferred || checkConv?.pendingSubagentResults?.length) {
                    runCallback?.(convId, true).catch((err: unknown) =>
                      jobLog.error(`subagent callback for ${chatId} failed: ${formatError(err)}`),
                    );
                  }
                }
              }

              const elapsed = ((Date.now() - start) / 1000).toFixed(1);
              jobLog.success(`completed in ${elapsed}s (${totalChats} chats)`);
            } catch (error) {
              const elapsed = ((Date.now() - start) / 1000).toFixed(1);
              jobLog.error(`failed after ${elapsed}s: ${formatError(error)}`);
            }
            return;
          }

          let cronConvId: string | undefined;
          try {
            const conversation = await store.create(
              "local-owner",
              `[cron] ${jobName} ${timestamp}`,
            );
            cronConvId = conversation.conversationId;
            activeRuns?.set(cronConvId, {
              ownerId: "local-owner",
              abortController: new AbortController(),
              runId: null,
            });
            const broadcast = handler._broadcastEvent;
            const result = await runCronAgent(harnessRef, config.task, cronConvId, [],
              conversation._toolResultArchive,
              broadcast ? (ev) => broadcast(cronConvId!, ev) : undefined,
              buildParams?.(conversation),
              conversation.tenantId,
            );
            handler._finishConversationStream?.(cronConvId);
            const freshConv = await store.get(cronConvId);
            if (freshConv) {
              freshConv.messages = buildCronMessages(config.task, [], result);
              applyTurnMetadata(freshConv, result, {
                clearContinuation: false,
                clearApprovals: false,
                setIdle: false,
              });
              await store.update(freshConv);
            }
            pruneCronConversations(store, "local-owner", jobName, config.maxRuns ?? 5).then(n => {
              if (n > 0) jobLog.item(`pruned ${n} old conversation${n === 1 ? "" : "s"}`);
            }).catch(err =>
              jobLog.error(`prune failed: ${formatError(err)}`),
            );
            const elapsed = ((Date.now() - start) / 1000).toFixed(1);
            jobLog.success(`completed in ${elapsed}s (${result.steps} steps)`);
          } catch (error) {
            const elapsed = ((Date.now() - start) / 1000).toFixed(1);
            jobLog.error(`failed after ${elapsed}s: ${formatError(error)}`);
          } finally {
            if (cronConvId) {
              activeRuns?.delete(cronConvId);
              const hadDeferred = deferredCallbacks?.delete(cronConvId) ?? false;
              const checkConv = await store.get(cronConvId);
              if (hadDeferred || checkConv?.pendingSubagentResults?.length) {
                runCallback?.(cronConvId, true).catch((err: unknown) =>
                  jobLog.error(`subagent callback failed: ${formatError(err)}`),
                );
              }
            }
          }
        },
      );
      activeJobs.push(job);
    }
    cronLog.item(
      `scheduled ${entries.length} job${entries.length === 1 ? "" : "s"}: ${entries.map(([n]) => n).join(", ")}`,
    );
  };

  const initialCronJobs = handler._cronJobs ?? {};
  scheduleCronJobs(initialCronJobs);

  // Hot-reload cron config when AGENT.md changes
  const agentMdPath = resolve(workingDir, "AGENT.md");
  let reloadDebounce: ReturnType<typeof setTimeout> | null = null;
  const watcher = fsWatch(agentMdPath, () => {
    if (reloadDebounce) clearTimeout(reloadDebounce);
    reloadDebounce = setTimeout(async () => {
      try {
        const agentMd = await readFile(agentMdPath, "utf8");
        const parsed = parseAgentMarkdown(agentMd);
        const newJobs = parsed.frontmatter.cron ?? {};
        handler._cronJobs = newJobs;
        scheduleCronJobs(newJobs);
        cronLog.item(`reloaded: ${Object.keys(newJobs).length} jobs scheduled`);
      } catch {
        // Parse errors during editing are expected; ignore
      }
    }, 500);
  });

  // ── Reminder polling ─────────────────────────────────────────────
  let reminderInterval: ReturnType<typeof setInterval> | null = null;
  if (handler._checkAndFireReminders && handler._reminderPollIntervalMs) {
    const pollMs = handler._reminderPollIntervalMs;
    const check = handler._checkAndFireReminders;
    reminderInterval = setInterval(async () => {
      try {
        const result = await check();
        if (result.count > 0) {
          reminderLog.success(
            `fired ${result.count} reminder${result.count === 1 ? "" : "s"} (${result.duration}ms)`,
          );
        }
      } catch (err) {
        reminderLog.error(`poll error: ${formatError(err)}`);
      }
    }, pollMs);
    reminderLog.item(`polling every ${Math.round(pollMs / 1000)}s`);
  }

  const shutdown = () => {
    watcher.close();
    if (reminderInterval) clearInterval(reminderInterval);
    for (const job of activeJobs) {
      job.stop();
    }
    server.close();
    server.closeAllConnections?.();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return server;
};


export const buildCli = (): Command => {
  const program = new Command();
  program
    .name("poncho")
    .description("CLI for building and running Poncho agents")
    .version("0.1.0");

  program
    .command("init")
    .argument("<name>", "project name")
    .option("--yes", "accept defaults and skip prompts", false)
    .description("Scaffold a new Poncho project")
    .action(async (name: string, options: { yes: boolean }) => {
      await initProject(name, {
        onboarding: {
          yes: options.yes,
          interactive:
            !options.yes && process.stdin.isTTY === true && process.stdout.isTTY === true,
        },
      });
    });

  program
    .command("dev")
    .description("Run local development server")
    .option("--port <port>", "server port", "3000")
    .option("-v, --verbose", "show debug logs (model:chunk events, per-step cost, MCP catalogs, etc.)")
    .option("-q, --quiet", "only show warnings and errors")
    .option("--log-level <level>", "explicit log level (debug|info|warn|error|silent)")
    .action(async (options: { port: string; verbose?: boolean; quiet?: boolean; logLevel?: string }) => {
      // Re-exec ourselves with V8 flags that capture a heap snapshot on OOM
      // and bump the max heap, so OOMs in `poncho dev` produce evidence
      // rather than just a stack trace. Skips if the user already set
      // NODE_OPTIONS, or after one re-exec hop (PONCHO_DEV_REEXECED guard).
      const wantedNodeOpts = ["--heapsnapshot-near-heap-limit=2", "--max-old-space-size=4096"];
      const currentNodeOpts = (process.env.NODE_OPTIONS ?? "").trim();
      const hasHeapSnap = currentNodeOpts.includes("--heapsnapshot-near-heap-limit");
      const hasMaxOld = currentNodeOpts.includes("--max-old-space-size");
      const needsReexec = !process.env.PONCHO_DEV_REEXECED && (!hasHeapSnap || !hasMaxOld);
      if (needsReexec) {
        const merged = [
          currentNodeOpts,
          ...(hasHeapSnap ? [] : [wantedNodeOpts[0]]),
          ...(hasMaxOld ? [] : [wantedNodeOpts[1]]),
        ].filter(Boolean).join(" ");
        const { spawn } = await import("node:child_process");
        const child = spawn(process.execPath, process.argv.slice(1), {
          stdio: "inherit",
          env: { ...process.env, NODE_OPTIONS: merged, PONCHO_DEV_REEXECED: "1" },
        });
        child.on("exit", (code, signal) => {
          if (signal) process.kill(process.pid, signal);
          else process.exit(code ?? 0);
        });
        return;
      }

      const level = options.logLevel
        ?? (options.verbose ? "debug" : options.quiet ? "warn" : undefined);
      if (level) {
        const valid = ["debug", "info", "warn", "error", "silent"] as const;
        if (!valid.includes(level as typeof valid[number])) {
          throw new Error(`Invalid --log-level "${level}". Use one of: ${valid.join(", ")}.`);
        }
        setLogLevel(level as typeof valid[number]);
      }
      if (process.stdout.isTTY && !process.env.NO_COLOR) {
        process.stdout.write("\n");
        for (const line of getMascotLines()) process.stdout.write(`${line}\n`);
        process.stdout.write(`\x1b[1m\x1b[36m                             poncho\x1b[0m\n\n`);
        process.stdout.write(`\x1b[2mheap snapshot on OOM enabled — dumps Heap.<ts>.heapsnapshot to ${process.cwd()}\x1b[0m\n\n`);
      }
      const port = Number.parseInt(options.port, 10);
      await startDevServer(Number.isNaN(port) ? 3000 : port);
    });

  program
    .command("run")
    .argument("[task]", "task to run")
    .description("Execute the agent once")
    .option("--param <keyValue>", "parameter key=value", (value, all: string[]) => {
      all.push(value);
      return all;
    }, [] as string[])
    .option("--file <path>", "include file contents", (value, all: string[]) => {
      all.push(value);
      return all;
    }, [] as string[])
    .option("--json", "output json", false)
    .option("--interactive", "run in interactive mode", false)
    .action(
      async (
        task: string | undefined,
        options: { param: string[]; file: string[]; json: boolean; interactive: boolean },
      ) => {
        const params = parseParams(options.param);
        if (options.interactive) {
          await runInteractive(process.cwd(), params);
          return;
        }
        if (!task) {
          throw new Error("Task is required unless --interactive is used.");
        }
        await runOnce(task, {
          params,
          json: options.json,
          filePaths: options.file,
        });
      },
    );

  program
    .command("tools")
    .description("List all tools available to the agent")
    .action(async () => {
      await listTools(process.cwd());
    });

  const authCommand = program.command("auth").description("Manage model provider authentication");
  authCommand
    .command("login")
    .requiredOption("--provider <provider>", "provider id (currently: openai-codex)")
    .option("--device", "use device auth flow", true)
    .action(async (options: { provider: string; device: boolean }) => {
      if (options.provider !== "openai-codex") {
        throw new Error(`Unsupported provider "${options.provider}". Try --provider openai-codex.`);
      }
      await loginOpenAICodex({ device: options.device });
    });

  authCommand
    .command("status")
    .requiredOption("--provider <provider>", "provider id (currently: openai-codex)")
    .action(async (options: { provider: string }) => {
      if (options.provider !== "openai-codex") {
        throw new Error(`Unsupported provider "${options.provider}". Try --provider openai-codex.`);
      }
      await statusOpenAICodex();
    });

  authCommand
    .command("logout")
    .requiredOption("--provider <provider>", "provider id (currently: openai-codex)")
    .action(async (options: { provider: string }) => {
      if (options.provider !== "openai-codex") {
        throw new Error(`Unsupported provider "${options.provider}". Try --provider openai-codex.`);
      }
      await logoutOpenAICodex();
    });

  authCommand
    .command("export")
    .requiredOption("--provider <provider>", "provider id (currently: openai-codex)")
    .option("--format <format>", "env|json", "env")
    .action(async (options: { provider: string; format: string }) => {
      if (options.provider !== "openai-codex") {
        throw new Error(`Unsupported provider "${options.provider}". Try --provider openai-codex.`);
      }
      if (options.format !== "env" && options.format !== "json") {
        throw new Error(`Unsupported export format "${options.format}". Use env or json.`);
      }
      await exportOpenAICodex(options.format);
    });

  authCommand
    .command("create-token")
    .description("Create a tenant-scoped JWT for development/testing")
    .requiredOption("--tenant <tenantId>", "tenant identifier (becomes JWT sub claim)")
    .option("--ttl <duration>", "token lifetime, e.g. 1h, 7d (default: no expiration)")
    .option("--meta <json>", "JSON metadata to embed in the token")
    .action(async (options: { tenant: string; ttl?: string; meta?: string }) => {
      dotenv.config();
      const tokenEnv = "PONCHO_AUTH_TOKEN";
      const signingKey = process.env[tokenEnv];
      if (!signingKey) {
        console.error(`Error: ${tokenEnv} is not set. Set it in .env or environment.`);
        process.exit(1);
      }
      const { SignJWT } = await import("jose");
      const secret = new TextEncoder().encode(signingKey);
      let metaObj: Record<string, unknown> | undefined;
      if (options.meta) {
        try {
          metaObj = JSON.parse(options.meta) as Record<string, unknown>;
        } catch {
          console.error("Error: --meta must be valid JSON");
          process.exit(1);
        }
      }
      let builder = new SignJWT(metaObj ? { meta: metaObj } : {})
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(options.tenant)
        .setIssuedAt();
      if (options.ttl) {
        builder = builder.setExpirationTime(options.ttl);
      }
      const token = await builder.sign(secret);
      console.log(token);
    });

  const secretsCommand = program.command("secrets").description("Manage per-tenant secrets");

  secretsCommand
    .command("set")
    .description("Set a secret for a tenant")
    .requiredOption("--tenant <tenantId>", "tenant identifier")
    .argument("<envName>", "environment variable name")
    .argument("<value>", "secret value")
    .action(async (envName: string, value: string, options: { tenant: string }) => {
      dotenv.config();
      const authToken = process.env.PONCHO_AUTH_TOKEN;
      if (!authToken) {
        console.error("Error: PONCHO_AUTH_TOKEN is not set");
        process.exit(1);
      }
      const config = await loadPonchoConfig(process.cwd());
      const stateConfig = resolveStateConfig(config);
      const agentId = (await ensureAgentIdentity(process.cwd())).id;
      const store = createSecretsStore(agentId, authToken, stateConfig, { workingDir: process.cwd() });
      await store.set(options.tenant, envName, value);
      console.log(`Secret ${envName} set for tenant ${options.tenant}`);
    });

  secretsCommand
    .command("list")
    .description("List secrets for a tenant (names only)")
    .requiredOption("--tenant <tenantId>", "tenant identifier")
    .action(async (options: { tenant: string }) => {
      dotenv.config();
      const authToken = process.env.PONCHO_AUTH_TOKEN;
      if (!authToken) {
        console.error("Error: PONCHO_AUTH_TOKEN is not set");
        process.exit(1);
      }
      const config = await loadPonchoConfig(process.cwd());
      const stateConfig = resolveStateConfig(config);
      const agentId = (await ensureAgentIdentity(process.cwd())).id;
      const store = createSecretsStore(agentId, authToken, stateConfig, { workingDir: process.cwd() });
      const names = await store.list(options.tenant);
      if (names.length === 0) {
        console.log("No secrets set for this tenant.");
      } else {
        for (const name of names) {
          console.log(`${name} (set)`);
        }
      }
    });

  secretsCommand
    .command("delete")
    .description("Delete a tenant secret override")
    .requiredOption("--tenant <tenantId>", "tenant identifier")
    .argument("<envName>", "environment variable name to remove")
    .action(async (envName: string, options: { tenant: string }) => {
      dotenv.config();
      const authToken = process.env.PONCHO_AUTH_TOKEN;
      if (!authToken) {
        console.error("Error: PONCHO_AUTH_TOKEN is not set");
        process.exit(1);
      }
      const config = await loadPonchoConfig(process.cwd());
      const stateConfig = resolveStateConfig(config);
      const agentId = (await ensureAgentIdentity(process.cwd())).id;
      const store = createSecretsStore(agentId, authToken, stateConfig, { workingDir: process.cwd() });
      await store.delete(options.tenant, envName);
      console.log(`Secret ${envName} deleted for tenant ${options.tenant}`);
    });

  const skillsCommand = program.command("skills").description("Manage installed skills");
  skillsCommand
    .command("add")
    .argument("<source>", "skill package name/path")
    .argument("[skillPath]", "optional path to one specific skill within source")
    .description("Install and copy skills into ./skills/<source>/...")
    .action(async (source: string, skillPath?: string) => {
      await addSkill(process.cwd(), source, { path: skillPath });
    });

  skillsCommand
    .command("remove")
    .argument("<source>", "skill package name/path")
    .argument("[skillPath]", "optional path to one specific skill within source")
    .description("Remove installed skills from ./skills/<source>/...")
    .action(async (source: string, skillPath?: string) => {
      await removeSkillPackage(process.cwd(), source, { path: skillPath });
    });

  skillsCommand
    .command("list")
    .argument("[source]", "optional source package/folder")
    .description("List installed skills")
    .action(async (source?: string) => {
      await listSkills(process.cwd(), source);
    });

  program
    .command("add")
    .argument("<packageOrPath>", "skill package name/path")
    .option("--path <relativePath>", "only copy a specific skill path from the package")
    .description("Alias for `poncho skills add <source> [skillPath]`")
    .action(async (packageOrPath: string, options: { path?: string }) => {
      await addSkill(process.cwd(), packageOrPath, { path: options.path });
    });

  program
    .command("remove")
    .argument("<packageOrPath>", "skill package name/path")
    .option("--path <relativePath>", "only remove a specific skill path from the package")
    .description("Alias for `poncho skills remove <source> [skillPath]`")
    .action(async (packageOrPath: string, options: { path?: string }) => {
      await removeSkillPackage(process.cwd(), packageOrPath, { path: options.path });
    });

  program
    .command("update-agent")
    .description("Remove deprecated embedded local guidance from AGENT.md")
    .action(async () => {
      await updateAgentGuidance(process.cwd());
    });

  program
    .command("test")
    .argument("[file]", "test file path (yaml)")
    .description("Run yaml-defined agent tests")
    .action(async (file?: string) => {
      const testFile = file ? resolve(process.cwd(), file) : undefined;
      const result = await runTests(process.cwd(), testFile);
      if (result.failed > 0) {
        process.exitCode = 1;
      }
    });

  program
    .command("build")
    .argument("[target]", "vercel|docker|lambda|fly")
    .option("--force", "overwrite existing deployment files")
    .description("Scaffold deployment files for a target")
    .action(async (target: string | undefined, options: { force?: boolean }) => {
      if (!target) {
        // No-op when called without a target (e.g. from Vercel build scripts).
        // Scaffolding is done locally via `poncho build <target>`.
        return;
      }
      await buildTarget(process.cwd(), target, { force: options.force });
    });

  const mcpCommand = program.command("mcp").description("Manage MCP servers");
  mcpCommand
    .command("add")
    .requiredOption("--url <url>", "remote MCP url")
    .option("--name <name>", "server name")
    .option(
      "--auth-bearer-env <name>",
      "env var name containing bearer token for this MCP server",
    )
    .option("--env <name>", "env variable (repeatable)", (value, all: string[]) => {
      all.push(value);
      return all;
    }, [] as string[])
    .option("--header <header>", "custom header as 'Name: value' (repeatable)", (value, all: string[]) => {
      all.push(value);
      return all;
    }, [] as string[])
    .action(
      async (
        options: {
          url?: string;
          name?: string;
          authBearerEnv?: string;
          env: string[];
          header: string[];
        },
      ) => {
        await mcpAdd(process.cwd(), {
          url: options.url,
          name: options.name,
          envVars: options.env,
          authBearerEnv: options.authBearerEnv,
          headers: options.header,
        });
      },
    );

  mcpCommand
    .command("list")
    .description("List configured MCP servers")
    .action(async () => {
      await mcpList(process.cwd());
    });

  mcpCommand
    .command("remove")
    .argument("<name>", "server name")
    .description("Remove an MCP server by name")
    .action(async (name: string) => {
      await mcpRemove(process.cwd(), name);
    });

  const mcpToolsCommand = mcpCommand
    .command("tools")
    .description("Discover and curate tools for a configured MCP server");

  mcpToolsCommand
    .command("list")
    .argument("<name>", "server name")
    .description("Discover and list tools from a configured MCP server")
    .action(async (name: string) => {
      await mcpToolsList(process.cwd(), name);
    });

  mcpToolsCommand
    .command("select")
    .argument("<name>", "server name")
    .description("Select MCP tools and print frontmatter allowed-tools entries")
    .option("--all", "select all discovered tools", false)
    .option("--tools <csv>", "comma-separated discovered tool names")
    .action(
      async (
        name: string,
        options: {
          all: boolean;
          tools?: string;
        },
      ) => {
        await mcpToolsSelect(process.cwd(), name, {
          all: options.all,
          toolsCsv: options.tools,
        });
      },
    );

  return program;
};

export const main = async (argv: string[] = process.argv): Promise<void> => {
  try {
    await buildCli().parseAsync(argv);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "EADDRINUSE"
    ) {
      const message = "Port is already in use. Try `poncho dev --port 3001` or stop the process using port 3000.";
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`${error instanceof Error ? error.message : "Unknown CLI error"}\n`);
    process.exitCode = 1;
  }
};


