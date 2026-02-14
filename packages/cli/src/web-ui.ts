import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Message } from "@agentl/sdk";

export interface WebUiConversation {
  conversationId: string;
  title: string;
  messages: Message[];
  runtimeRunId?: string;
  ownerId: string;
  tenantId: string | null;
  createdAt: number;
  updatedAt: number;
}

type ConversationStoreFile = {
  conversations: WebUiConversation[];
};

const DEFAULT_OWNER = "local-owner";

const getStateDirectory = (): string => {
  const cwd = process.cwd();
  const home = homedir();
  // On serverless platforms (Vercel, AWS Lambda), only /tmp is writable
  const isServerless =
    process.env.VERCEL === "1" ||
    process.env.VERCEL_ENV !== undefined ||
    process.env.VERCEL_URL !== undefined ||
    process.env.AWS_LAMBDA_FUNCTION_NAME !== undefined ||
    process.env.AWS_EXECUTION_ENV?.includes("AWS_Lambda") === true ||
    process.env.LAMBDA_TASK_ROOT !== undefined ||
    process.env.NOW_REGION !== undefined ||
    cwd.startsWith("/var/task") ||
    home.startsWith("/var/task") ||
    process.env.SERVERLESS === "1";
  if (isServerless) {
    return "/tmp/.agentl/state";
  }
  return resolve(homedir(), ".agentl", "state");
};

export class FileConversationStore {
  private readonly filePath: string;
  private readonly conversations = new Map<string, WebUiConversation>();
  private loaded = false;
  private writing = Promise.resolve();

  constructor(workingDir: string) {
    const projectName = basename(workingDir).replace(/[^a-zA-Z0-9_-]+/g, "-") || "project";
    const projectHash = createHash("sha256")
      .update(workingDir)
      .digest("hex")
      .slice(0, 12);
    this.filePath = resolve(
      getStateDirectory(),
      `${projectName}-${projectHash}-web-ui-state.json`,
    );
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    try {
      const content = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(content) as ConversationStoreFile;
      for (const conversation of parsed.conversations ?? []) {
        this.conversations.set(conversation.conversationId, conversation);
      }
    } catch {
      // File does not exist yet or contains invalid JSON.
    }
  }

  private async persist(): Promise<void> {
    const payload: ConversationStoreFile = {
      conversations: Array.from(this.conversations.values()),
    };
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, JSON.stringify(payload, null, 2), "utf8");
    });
    await this.writing;
  }

  async list(ownerId = DEFAULT_OWNER): Promise<WebUiConversation[]> {
    await this.ensureLoaded();
    return Array.from(this.conversations.values())
      .filter((conversation) => conversation.ownerId === ownerId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(conversationId: string): Promise<WebUiConversation | undefined> {
    await this.ensureLoaded();
    return this.conversations.get(conversationId);
  }

  async create(ownerId = DEFAULT_OWNER, title?: string): Promise<WebUiConversation> {
    await this.ensureLoaded();
    const now = Date.now();
    const conversation: WebUiConversation = {
      conversationId: randomUUID(),
      title: title && title.trim().length > 0 ? title.trim() : "New conversation",
      messages: [],
      ownerId,
      tenantId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.conversations.set(conversation.conversationId, conversation);
    await this.persist();
    return conversation;
  }

  async update(conversation: WebUiConversation): Promise<void> {
    await this.ensureLoaded();
    this.conversations.set(conversation.conversationId, {
      ...conversation,
      updatedAt: Date.now(),
    });
    await this.persist();
  }

  async rename(conversationId: string, title: string): Promise<WebUiConversation | undefined> {
    await this.ensureLoaded();
    const existing = this.conversations.get(conversationId);
    if (!existing) {
      return undefined;
    }
    const updated = {
      ...existing,
      title: title.trim().length > 0 ? title.trim() : existing.title,
      updatedAt: Date.now(),
    };
    this.conversations.set(conversationId, updated);
    await this.persist();
    return updated;
  }

  async delete(conversationId: string): Promise<boolean> {
    await this.ensureLoaded();
    const removed = this.conversations.delete(conversationId);
    if (removed) {
      await this.persist();
    }
    return removed;
  }
}

type SessionRecord = {
  sessionId: string;
  ownerId: string;
  csrfToken: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
};

export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly ttlMs: number;

  constructor(ttlMs = 1000 * 60 * 60 * 8) {
    this.ttlMs = ttlMs;
  }

  create(ownerId = DEFAULT_OWNER): SessionRecord {
    const now = Date.now();
    const session: SessionRecord = {
      sessionId: randomUUID(),
      ownerId,
      csrfToken: randomUUID(),
      createdAt: now,
      expiresAt: now + this.ttlMs,
      lastSeenAt: now,
    };
    this.sessions.set(session.sessionId, session);
    return session;
  }

  get(sessionId: string): SessionRecord | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return undefined;
    }
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(sessionId);
      return undefined;
    }
    session.lastSeenAt = Date.now();
    return session;
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

type LoginAttemptState = {
  count: number;
  firstFailureAt: number;
  lockedUntil?: number;
};

export class LoginRateLimiter {
  private readonly attempts = new Map<string, LoginAttemptState>();

  constructor(
    private readonly maxAttempts = 5,
    private readonly windowMs = 1000 * 60 * 5,
    private readonly lockoutMs = 1000 * 60 * 10,
  ) {}

  canAttempt(key: string): { allowed: boolean; retryAfterSeconds?: number } {
    const current = this.attempts.get(key);
    if (!current) {
      return { allowed: true };
    }
    if (current.lockedUntil && Date.now() < current.lockedUntil) {
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil((current.lockedUntil - Date.now()) / 1000),
      };
    }
    return { allowed: true };
  }

  registerFailure(key: string): { locked: boolean; retryAfterSeconds?: number } {
    const now = Date.now();
    const current = this.attempts.get(key);
    if (!current || now - current.firstFailureAt > this.windowMs) {
      this.attempts.set(key, { count: 1, firstFailureAt: now });
      return { locked: false };
    }
    const count = current.count + 1;
    const next: LoginAttemptState = {
      ...current,
      count,
    };
    if (count >= this.maxAttempts) {
      next.lockedUntil = now + this.lockoutMs;
      this.attempts.set(key, next);
      return { locked: true, retryAfterSeconds: Math.ceil(this.lockoutMs / 1000) };
    }
    this.attempts.set(key, next);
    return { locked: false };
  }

  registerSuccess(key: string): void {
    this.attempts.delete(key);
  }
}

export const parseCookies = (request: IncomingMessage): Record<string, string> => {
  const cookieHeader = request.headers.cookie ?? "";
  const pairs = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  const cookies: Record<string, string> = {};
  for (const pair of pairs) {
    const index = pair.indexOf("=");
    if (index <= 0) {
      continue;
    }
    const key = pair.slice(0, index);
    const value = pair.slice(index + 1);
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      // Ignore malformed cookie encoding instead of throwing.
      cookies[key] = value;
    }
  }
  return cookies;
};

export const setCookie = (
  response: ServerResponse,
  name: string,
  value: string,
  options: {
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "Lax" | "Strict" | "None";
    path?: string;
    maxAge?: number;
  },
): void => {
  const segments = [`${name}=${encodeURIComponent(value)}`];
  segments.push(`Path=${options.path ?? "/"}`);
  if (typeof options.maxAge === "number") {
    segments.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  }
  if (options.httpOnly) {
    segments.push("HttpOnly");
  }
  if (options.secure) {
    segments.push("Secure");
  }
  if (options.sameSite) {
    segments.push(`SameSite=${options.sameSite}`);
  }
  const previous = response.getHeader("Set-Cookie");
  const serialized = segments.join("; ");
  if (!previous) {
    response.setHeader("Set-Cookie", serialized);
    return;
  }
  if (Array.isArray(previous)) {
    response.setHeader("Set-Cookie", [...previous, serialized]);
    return;
  }
  response.setHeader("Set-Cookie", [String(previous), serialized]);
};

export const verifyPassphrase = (provided: string, expected: string): boolean => {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length) {
    const zero = Buffer.alloc(expectedBuffer.length);
    return timingSafeEqual(expectedBuffer, zero) && false;
  }
  return timingSafeEqual(providedBuffer, expectedBuffer);
};

export const getRequestIp = (request: IncomingMessage): string => {
  // Trust direct socket peer by default to avoid spoofable forwarded headers.
  // Reverse-proxy deployments can map trusted client IPs before this layer.
  return request.socket.remoteAddress ?? "unknown";
};

export const inferConversationTitle = (text: string): string => {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "New conversation";
  }
  return normalized.length <= 48 ? normalized : `${normalized.slice(0, 48)}...`;
};

// ---------------------------------------------------------------------------
// PWA assets
// ---------------------------------------------------------------------------

export const renderManifest = (options?: { agentName?: string }): string => {
  const name = options?.agentName ?? "Agent";
  return JSON.stringify({
    name,
    short_name: name,
    description: `${name} — AI agent powered by AgentL`,
    start_url: "/",
    display: "standalone",
    background_color: "#000000",
    theme_color: "#000000",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  });
};

export const renderIconSvg = (options?: { agentName?: string }): string => {
  const letter = (options?.agentName ?? "A").charAt(0).toUpperCase();
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="96" fill="#000"/>
  <text x="256" y="256" dy=".35em" text-anchor="middle"
        font-family="-apple-system,BlinkMacSystemFont,sans-serif"
        font-size="280" font-weight="700" fill="#fff">${letter}</text>
</svg>`;
};

export const renderServiceWorker = (): string => `
const CACHE_NAME = "agentl-shell-v1";
const SHELL_URLS = ["/"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Only cache GET requests for the app shell; let API calls pass through
  if (event.request.method !== "GET" || url.pathname.startsWith("/api/")) {
    return;
  }
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
`;

export const renderWebUiHtml = (options?: { agentName?: string }): string => {
  const agentInitial = (options?.agentName ?? "A").charAt(0).toUpperCase();
  const agentName = options?.agentName ?? "Agent";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
  <meta name="theme-color" content="#000000">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="${agentName}">
  <link rel="manifest" href="/manifest.json">
  <link rel="icon" href="/icon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/icon-192.png">
  <title>${agentName}</title>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css?family=Inconsolata:400,700">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; overflow: hidden; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", "Helvetica Neue", sans-serif;
      background: #000;
      color: #ededed;
      font-size: 14px;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }
    button, input, textarea { font: inherit; color: inherit; }
    .hidden { display: none !important; }
    a { color: #ededed; }

    /* Auth */
    .auth {
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 20px;
      background: #000;
    }
    .auth-card {
      width: min(380px, 90vw);
      background: #0a0a0a;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 12px;
      padding: 32px;
      display: grid;
      gap: 20px;
    }
    .auth-brand {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .auth-brand svg { width: 20px; height: 20px; }
    .auth-title {
      font-size: 16px;
      font-weight: 500;
      letter-spacing: -0.01em;
    }
    .auth-text { color: #666; font-size: 13px; line-height: 1.5; }
    .auth-input {
      width: 100%;
      background: #000;
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 6px;
      color: #ededed;
      padding: 10px 12px;
      font-size: 14px;
      outline: none;
      transition: border-color 0.15s;
    }
    .auth-input:focus { border-color: rgba(255,255,255,0.3); }
    .auth-input::placeholder { color: #555; }
    .auth-submit {
      background: #ededed;
      color: #000;
      border: 0;
      border-radius: 6px;
      padding: 10px 16px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s;
    }
    .auth-submit:hover { background: #fff; }
    .error { color: #ff4444; font-size: 13px; min-height: 16px; }
    .message-error {
      background: rgba(255,68,68,0.08);
      border: 1px solid rgba(255,68,68,0.25);
      border-radius: 10px;
      color: #ff6b6b;
      padding: 12px 16px;
      font-size: 13px;
      line-height: 1.5;
      max-width: 600px;
    }
    .message-error strong { color: #ff4444; }

    /* Layout */
    .shell { height: 100vh; height: 100dvh; height: var(--app-height, 100dvh); display: flex; overflow: hidden; }
    .sidebar {
      width: 260px;
      background: #000;
      border-right: 1px solid rgba(255,255,255,0.06);
      display: flex;
      flex-direction: column;
      padding: 12px 8px;
    }
    .new-chat-btn {
      background: transparent;
      border: 0;
      color: #888;
      border-radius: 12px;
      height: 36px;
      padding: 0 10px;
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      cursor: pointer;
      transition: background 0.15s, color 0.15s;
    }
    .new-chat-btn:hover { color: #ededed; }
    .new-chat-btn svg { width: 16px; height: 16px; }
    .conversation-list {
      flex: 1;
      overflow-y: auto;
      margin-top: 12px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .conversation-item {
      padding: 7px 28px 7px 10px;
      border-radius: 12px;
      cursor: pointer;
      font-size: 13px;
      color: #555;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      position: relative;
      transition: color 0.15s;
    }
    .conversation-item:hover { color: #999; }
    .conversation-item.active {
      color: #ededed;
    }
    .conversation-item .delete-btn {
      position: absolute;
      right: 0;
      top: 0;
      bottom: 0;
      opacity: 0;
      background: #000;
      border: 0;
      color: #444;
      padding: 0 8px;
      border-radius: 0 4px 4px 0;
      cursor: pointer;
      font-size: 16px;
      line-height: 1;
      display: grid;
      place-items: center;
      transition: opacity 0.15s, color 0.15s;
    }
    .conversation-item:hover .delete-btn { opacity: 1; }
    .conversation-item.active .delete-btn { background: rgba(0,0,0,1); }
    .conversation-item .delete-btn::before {
      content: "";
      position: absolute;
      right: 100%;
      top: 0;
      bottom: 0;
      width: 24px;
      background: linear-gradient(to right, transparent, #000);
      pointer-events: none;
    }
    .conversation-item.active .delete-btn::before {
      background: linear-gradient(to right, transparent, rgba(0,0,0,1));
    }
    .conversation-item .delete-btn:hover { color: #888; }
    .conversation-item .delete-btn.confirming {
      opacity: 1;
      width: auto;
      padding: 0 8px;
      font-size: 11px;
      color: #ff4444;
      border-radius: 3px;
    }
    .conversation-item .delete-btn.confirming:hover {
      color: #ff6666;
    }
    .sidebar-footer {
      margin-top: auto;
      padding-top: 8px;
    }
    .logout-btn {
      background: transparent;
      border: 0;
      color: #555;
      width: 100%;
      padding: 8px 10px;
      text-align: left;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      transition: color 0.15s, background 0.15s;
    }
    .logout-btn:hover { color: #888; }

    /* Main */
    .main { flex: 1; display: flex; flex-direction: column; min-width: 0; background: #000; }
    .topbar {
      height: 52px;
      padding-top: env(safe-area-inset-top, 0px);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      font-weight: 500;
      color: #888;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      position: relative;
      flex-shrink: 0;
    }
    .topbar-title {
      max-width: 400px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      letter-spacing: -0.01em;
    }
    .sidebar-toggle {
      display: none;
      position: absolute;
      left: 12px;
      background: transparent;
      border: 0;
      color: #666;
      width: 32px;
      height: 32px;
      border-radius: 6px;
      cursor: pointer;
      transition: color 0.15s, background 0.15s;
      font-size: 18px;
    }
    .sidebar-toggle:hover { color: #ededed; }

    /* Messages */
    .messages { flex: 1; overflow-y: auto; padding: 24px 24px; }
    .messages-column { max-width: 680px; margin: 0 auto; }
    .message-row { margin-bottom: 24px; display: flex; }
    .message-row.user { justify-content: flex-end; }
    .assistant-wrap { display: flex; gap: 12px; max-width: 100%; }
    .assistant-avatar {
      width: 24px;
      height: 24px;
      background: #ededed;
      color: #000;
      border-radius: 6px;
      display: grid;
      place-items: center;
      font-size: 11px;
      font-weight: 600;
      flex-shrink: 0;
      margin-top: 2px;
    }
    .assistant-content {
      line-height: 1.65;
      color: #ededed;
      font-size: 14px;
      min-width: 0;
      margin-top: 2px;
    }
    .assistant-content p { margin: 0 0 12px; }
    .assistant-content p:last-child { margin-bottom: 0; }
    .assistant-content ul, .assistant-content ol { margin: 8px 0; padding-left: 20px; }
    .assistant-content li { margin: 4px 0; }
    .assistant-content strong { font-weight: 600; color: #fff; }
    .assistant-content h2 {
      font-size: 16px;
      font-weight: 600;
      letter-spacing: -0.02em;
      margin: 20px 0 8px;
      color: #fff;
    }
    .assistant-content h3 {
      font-size: 14px;
      font-weight: 600;
      letter-spacing: -0.01em;
      margin: 16px 0 6px;
      color: #fff;
    }
    .assistant-content code {
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.06);
      padding: 2px 5px;
      border-radius: 4px;
      font-family: ui-monospace, "SF Mono", "Fira Code", monospace;
      font-size: 0.88em;
    }
    .assistant-content pre {
      background: #0a0a0a;
      border: 1px solid rgba(255,255,255,0.06);
      padding: 14px 16px;
      border-radius: 8px;
      overflow-x: auto;
      margin: 14px 0;
    }
    .assistant-content pre code {
      background: none;
      border: 0;
      padding: 0;
      font-size: 13px;
      line-height: 1.5;
    }
    .tool-activity {
      margin-top: 12px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.03);
      border-radius: 10px;
      font-size: 12px;
      line-height: 1.45;
      color: #bcbcbc;
      max-width: 300px;
    }
    .tool-activity-disclosure {
      display: block;
    }
    .tool-activity-summary {
      list-style: none;
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      padding: 10px 12px;
      user-select: none;
    }
    .tool-activity-summary::-webkit-details-marker {
      display: none;
    }
    .tool-activity-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: #8a8a8a;
      font-weight: 600;
    }
    .tool-activity-caret {
      margin-left: auto;
      color: #8a8a8a;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: transform 120ms ease;
      transform: rotate(0deg);
    }
    .tool-activity-caret svg {
      width: 14px;
      height: 14px;
      display: block;
    }
    .tool-activity-disclosure[open] .tool-activity-caret {
      transform: rotate(90deg);
    }
    .tool-activity-list {
      display: grid;
      gap: 6px;
      padding: 0 12px 10px;
    }
    .tool-activity-item {
      font-family: ui-monospace, "SF Mono", "Fira Code", monospace;
      background: rgba(255,255,255,0.04);
      border-radius: 6px;
      padding: 4px 7px;
      color: #d6d6d6;
    }
    .user-bubble {
      background: #111;
      border: 1px solid rgba(255,255,255,0.08);
      padding: 10px 16px;
      border-radius: 18px;
      max-width: 70%;
      font-size: 14px;
      line-height: 1.5;
    }
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      gap: 16px;
      color: #555;
    }
    .empty-state .assistant-avatar {
      width: 36px;
      height: 36px;
      font-size: 14px;
      border-radius: 8px;
    }
    .empty-state-text {
      font-size: 14px;
      color: #555;
    }
    .thinking-indicator {
      display: inline-block;
      font-family: Inconsolata, monospace;
      font-size: 20px;
      line-height: 1;
      vertical-align: middle;
      color: #ededed;
      opacity: 0.5;
    }

    /* Composer */
    .composer {
      padding: 12px 24px calc(24px + env(safe-area-inset-bottom, 0px));
      position: relative;
    }
    .composer::before {
      content: "";
      position: absolute;
      left: 0;
      right: 0;
      bottom: 100%;
      height: 48px;
      background: linear-gradient(to top, #000 0%, transparent 100%);
      pointer-events: none;
    }
    .composer-inner { max-width: 680px; margin: 0 auto; }
    .composer-shell {
      background: #0a0a0a;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 9999px;
      display: flex;
      align-items: center;
      padding: 4px 6px 4px 18px;
      transition: border-color 0.15s;
    }
    .composer-shell:focus-within { border-color: rgba(255,255,255,0.2); }
    .composer-input {
      flex: 1;
      background: transparent;
      border: 0;
      outline: none;
      color: #ededed;
      min-height: 40px;
      max-height: 200px;
      resize: none;
      padding: 10px 0 8px;
      font-size: 14px;
      line-height: 1.5;
    }
    .composer-input::placeholder { color: #444; }
    .send-btn {
      width: 32px;
      height: 32px;
      background: #ededed;
      border: 0;
      border-radius: 50%;
      color: #000;
      cursor: pointer;
      display: grid;
      place-items: center;
      flex-shrink: 0;
      margin-bottom: 2px;
      transition: background 0.15s, opacity 0.15s;
    }
    .send-btn:hover { background: #fff; }
    .send-btn:disabled { opacity: 0.2; cursor: default; }
    .send-btn:disabled:hover { background: #ededed; }
    .disclaimer {
      text-align: center;
      color: #333;
      font-size: 12px;
      margin-top: 10px;
    }

    /* Scrollbar */
    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.16); }

    /* Mobile */
    @media (max-width: 768px) {
      .sidebar {
        position: fixed;
        inset: 0 auto 0 0;
        z-index: 100;
        transform: translateX(-100%);
        transition: transform 0.2s ease;
      }
      .shell.sidebar-open .sidebar { transform: translateX(0); }
      .sidebar-toggle { display: grid; place-items: center; }
      .sidebar-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.6);
        z-index: 50;
        backdrop-filter: blur(2px);
        -webkit-backdrop-filter: blur(2px);
      }
      .shell:not(.sidebar-open) .sidebar-backdrop { display: none; }
      .messages { padding: 16px; }
      .composer { padding: 8px 16px 16px; }
    }

    /* Reduced motion */
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.01ms !important;
        transition-duration: 0.01ms !important;
      }
    }
  </style>
</head>
<body data-agent-initial="${agentInitial}" data-agent-name="${agentName}">
  <div id="auth" class="auth hidden">
    <form id="login-form" class="auth-card">
      <div class="auth-brand">
        <svg viewBox="0 0 24 24" fill="none"><path d="M12 2L2 19.5h20L12 2z" fill="currentColor"/></svg>
        <h2 class="auth-title">AgentL</h2>
      </div>
      <p class="auth-text">Enter the passphrase to continue.</p>
      <input id="passphrase" class="auth-input" type="password" placeholder="Passphrase" required>
      <button class="auth-submit" type="submit">Continue</button>
      <div id="login-error" class="error"></div>
    </form>
  </div>

  <div id="app" class="shell hidden">
    <aside class="sidebar">
      <button id="new-chat" class="new-chat-btn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
      </button>
      <div id="conversation-list" class="conversation-list"></div>
      <div class="sidebar-footer">
        <button id="logout" class="logout-btn">Log out</button>
      </div>
    </aside>
    <div id="sidebar-backdrop" class="sidebar-backdrop"></div>
    <main class="main">
      <div class="topbar">
        <button id="sidebar-toggle" class="sidebar-toggle">&#9776;</button>
        <div id="chat-title" class="topbar-title"></div>
      </div>
      <div id="messages" class="messages">
        <div class="empty-state">
          <div class="assistant-avatar">${agentInitial}</div>
          <div class="empty-state-text">How can I help you today?</div>
        </div>
      </div>
      <form id="composer" class="composer">
        <div class="composer-inner">
          <div class="composer-shell">
            <textarea id="prompt" class="composer-input" placeholder="Send a message..." rows="1"></textarea>
            <button id="send" class="send-btn" type="submit">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 12V4M4 7l4-4 4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
          </div>
        </div>
      </form>
    </main>
  </div>

    <script>
      const state = {
        csrfToken: "",
        conversations: [],
        activeConversationId: null,
        isStreaming: false,
        confirmDeleteId: null
      };

      const agentInitial = document.body.dataset.agentInitial || "A";
      const $ = (id) => document.getElementById(id);
      const elements = {
        auth: $("auth"),
        app: $("app"),
        loginForm: $("login-form"),
        passphrase: $("passphrase"),
        loginError: $("login-error"),
        list: $("conversation-list"),
        newChat: $("new-chat"),
        messages: $("messages"),
        chatTitle: $("chat-title"),
        logout: $("logout"),
        composer: $("composer"),
        prompt: $("prompt"),
        send: $("send"),
        shell: $("app"),
        sidebarToggle: $("sidebar-toggle"),
        sidebarBackdrop: $("sidebar-backdrop")
      };

      const pushConversationUrl = (conversationId) => {
        const target = conversationId ? "/c/" + encodeURIComponent(conversationId) : "/";
        if (window.location.pathname !== target) {
          history.pushState({ conversationId: conversationId || null }, "", target);
        }
      };

      const replaceConversationUrl = (conversationId) => {
        const target = conversationId ? "/c/" + encodeURIComponent(conversationId) : "/";
        if (window.location.pathname !== target) {
          history.replaceState({ conversationId: conversationId || null }, "", target);
        }
      };

      const getConversationIdFromUrl = () => {
        const match = window.location.pathname.match(/^\\/c\\/([^\\/]+)/);
        return match ? decodeURIComponent(match[1]) : null;
      };

      const mutatingMethods = new Set(["POST", "PATCH", "PUT", "DELETE"]);

      const api = async (path, options = {}) => {
        const method = (options.method || "GET").toUpperCase();
        const headers = { ...(options.headers || {}) };
        if (mutatingMethods.has(method) && state.csrfToken) {
          headers["x-csrf-token"] = state.csrfToken;
        }
        if (options.body && !headers["Content-Type"]) {
          headers["Content-Type"] = "application/json";
        }
        const response = await fetch(path, { credentials: "include", ...options, method, headers });
        if (!response.ok) {
          let payload = {};
          try { payload = await response.json(); } catch {}
          const error = new Error(payload.message || ("Request failed: " + response.status));
          error.status = response.status;
          error.payload = payload;
          throw error;
        }
        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          return await response.json();
        }
        return await response.text();
      };

      const escapeHtml = (value) =>
        String(value || "")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");

      const renderInlineMarkdown = (value) => {
        let html = escapeHtml(value);
        html = html.replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>");
        html = html.replace(/\\x60([^\\x60]+)\\x60/g, "<code>$1</code>");
        return html;
      };

      const renderMarkdownBlock = (value) => {
        const lines = String(value || "").split("\\n");
        let html = "";
        let inList = false;

        for (const rawLine of lines) {
          const line = rawLine.trimEnd();
          const trimmed = line.trim();
          const headingMatch = trimmed.match(/^(#{1,3})\\s+(.+)$/);

          if (headingMatch) {
            if (inList) {
              html += "</ul>";
              inList = false;
            }
            const level = Math.min(3, headingMatch[1].length);
            const tag = level === 1 ? "h2" : level === 2 ? "h3" : "p";
            html += "<" + tag + ">" + renderInlineMarkdown(headingMatch[2]) + "</" + tag + ">";
            continue;
          }

          if (/^\\s*-\\s+/.test(line)) {
            if (!inList) {
              html += "<ul>";
              inList = true;
            }
            html += "<li>" + renderInlineMarkdown(line.replace(/^\\s*-\\s+/, "")) + "</li>";
            continue;
          }
          if (inList) {
            html += "</ul>";
            inList = false;
          }
          if (trimmed.length === 0) {
            continue;
          }
          html += "<p>" + renderInlineMarkdown(line) + "</p>";
        }

        if (inList) {
          html += "</ul>";
        }
        return html;
      };

      const renderAssistantMarkdown = (value) => {
        const source = String(value || "");
        const fenceRegex = /\\x60\\x60\\x60([\\s\\S]*?)\\x60\\x60\\x60/g;
        let html = "";
        let lastIndex = 0;
        let match;

        while ((match = fenceRegex.exec(source))) {
          const before = source.slice(lastIndex, match.index);
          html += renderMarkdownBlock(before);
          const codeText = String(match[1] || "").replace(/^\\n+|\\n+$/g, "");
          html += "<pre><code>" + escapeHtml(codeText) + "</code></pre>";
          lastIndex = match.index + match[0].length;
        }

        html += renderMarkdownBlock(source.slice(lastIndex));
        return html || "<p></p>";
      };

      const extractToolActivity = (value) => {
        const source = String(value || "");
        let markerIndex = source.lastIndexOf("\\n### Tool activity\\n");
        if (markerIndex < 0 && source.startsWith("### Tool activity\\n")) {
          markerIndex = 0;
        }
        if (markerIndex < 0) {
          return { content: source, activities: [] };
        }
        const content = markerIndex === 0 ? "" : source.slice(0, markerIndex).trimEnd();
        const rawSection = markerIndex === 0 ? source : source.slice(markerIndex + 1);
        const afterHeading = rawSection.replace(/^### Tool activity\\s*\\n?/, "");
        const activities = afterHeading
          .split("\\n")
          .map((line) => line.trim())
          .filter((line) => line.startsWith("- "))
          .map((line) => line.slice(2).trim())
          .filter(Boolean);
        return { content, activities };
      };

      const renderToolActivity = (items) => {
        if (!items || !items.length) {
          return "";
        }
        const chips = items
          .map((item) => '<div class="tool-activity-item">' + escapeHtml(item) + "</div>")
          .join("");
        return (
          '<div class="tool-activity">' +
          '<details class="tool-activity-disclosure">' +
          '<summary class="tool-activity-summary">' +
          '<span class="tool-activity-label">Tool activity</span>' +
          '<span class="tool-activity-caret" aria-hidden="true"><svg viewBox="0 0 12 12" fill="none"><path d="M4.5 2.75L8 6L4.5 9.25" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path></svg></span>' +
          "</summary>" +
          '<div class="tool-activity-list">' +
          chips +
          "</div>" +
          "</details>" +
          "</div>"
        );
      };

      const formatDate = (epoch) => {
        try {
          const date = new Date(epoch);
          const now = new Date();
          const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
          const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
          const dayDiff = Math.floor((startOfToday - startOfDate) / 86400000);
          if (dayDiff === 0) {
            return "Today";
          }
          if (dayDiff === 1) {
            return "Yesterday";
          }
          if (dayDiff < 7 && dayDiff > 1) {
            return date.toLocaleDateString(undefined, { weekday: "short" });
          }
          return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
        } catch {
          return "";
        }
      };

      const isMobile = () => window.matchMedia("(max-width: 900px)").matches;

      const setSidebarOpen = (open) => {
        if (!isMobile()) {
          elements.shell.classList.remove("sidebar-open");
          return;
        }
        elements.shell.classList.toggle("sidebar-open", open);
      };

      const renderConversationList = () => {
        elements.list.innerHTML = "";
        for (const c of state.conversations) {
          const item = document.createElement("div");
          item.className = "conversation-item" + (c.conversationId === state.activeConversationId ? " active" : "");
          item.textContent = c.title;

          const isConfirming = state.confirmDeleteId === c.conversationId;
          const deleteBtn = document.createElement("button");
          deleteBtn.className = "delete-btn" + (isConfirming ? " confirming" : "");
          deleteBtn.textContent = isConfirming ? "sure?" : "\\u00d7";
          deleteBtn.onclick = async (e) => {
            e.stopPropagation();
            if (!isConfirming) {
              state.confirmDeleteId = c.conversationId;
              renderConversationList();
              return;
            }
            await api("/api/conversations/" + c.conversationId, { method: "DELETE" });
            if (state.activeConversationId === c.conversationId) {
              state.activeConversationId = null;
              pushConversationUrl(null);
              elements.chatTitle.textContent = "";
              renderMessages([]);
            }
            state.confirmDeleteId = null;
            await loadConversations();
          };
          item.appendChild(deleteBtn);

          item.onclick = async () => {
            if (state.confirmDeleteId) {
              state.confirmDeleteId = null;
              renderConversationList();
              return;
            }
            state.activeConversationId = c.conversationId;
            pushConversationUrl(c.conversationId);
            renderConversationList();
            await loadConversation(c.conversationId);
            if (isMobile()) setSidebarOpen(false);
          };

          elements.list.appendChild(item);
        }
      };

      const renderMessages = (messages, isStreaming = false) => {
        elements.messages.innerHTML = "";
        if (!messages || !messages.length) {
          elements.messages.innerHTML = '<div class="empty-state"><div class="assistant-avatar">' + agentInitial + '</div><div>How can I help you today?</div></div>';
          return;
        }
        const col = document.createElement("div");
        col.className = "messages-column";
        messages.forEach((m, i) => {
          const row = document.createElement("div");
          row.className = "message-row " + m.role;
          if (m.role === "assistant") {
            const wrap = document.createElement("div");
            wrap.className = "assistant-wrap";
            wrap.innerHTML = '<div class="assistant-avatar">' + agentInitial + '</div>';
            const content = document.createElement("div");
            content.className = "assistant-content";
            const text = String(m.content || "");
            const parsed = extractToolActivity(text);
            const metadataToolActivity =
              m.metadata && Array.isArray(m.metadata.toolActivity)
                ? m.metadata.toolActivity
                : [];
            const toolActivity =
              Array.isArray(m._toolActivity) && m._toolActivity.length > 0
                ? m._toolActivity
                : metadataToolActivity.length > 0
                  ? metadataToolActivity
                  : parsed.activities;
            if (m._error) {
              const errorEl = document.createElement("div");
              errorEl.className = "message-error";
              errorEl.innerHTML = "<strong>Error</strong><br>" + escapeHtml(m._error);
              content.appendChild(errorEl);
            } else if (isStreaming && i === messages.length - 1 && !parsed.content) {
              const spinner = document.createElement("span");
              spinner.className = "thinking-indicator";
              const starFrames = ["✶","✸","✹","✺","✹","✷"];
              let frame = 0;
              spinner.textContent = starFrames[0];
              spinner._interval = setInterval(() => { frame = (frame + 1) % starFrames.length; spinner.textContent = starFrames[frame]; }, 70);
              content.appendChild(spinner);
            } else {
              content.innerHTML = renderAssistantMarkdown(parsed.content);
            }
            if (toolActivity.length > 0) {
              content.insertAdjacentHTML("beforeend", renderToolActivity(toolActivity));
            }
            wrap.appendChild(content);
            row.appendChild(wrap);
          } else {
            row.innerHTML = '<div class="user-bubble">' + escapeHtml(m.content) + '</div>';
          }
          col.appendChild(row);
        });
        elements.messages.appendChild(col);
        elements.messages.scrollTop = elements.messages.scrollHeight;
      };

      const loadConversations = async () => {
        const payload = await api("/api/conversations");
        state.conversations = payload.conversations || [];
        renderConversationList();
      };

      const loadConversation = async (conversationId) => {
        const payload = await api("/api/conversations/" + encodeURIComponent(conversationId));
        elements.chatTitle.textContent = payload.conversation.title;
        renderMessages(payload.conversation.messages);
        elements.prompt.focus();
      };

      const createConversation = async (title) => {
        const payload = await api("/api/conversations", {
          method: "POST",
          body: JSON.stringify(title ? { title } : {})
        });
        state.activeConversationId = payload.conversation.conversationId;
        state.confirmDeleteId = null;
        pushConversationUrl(state.activeConversationId);
        await loadConversations();
        await loadConversation(state.activeConversationId);
        return state.activeConversationId;
      };

      const parseSseChunk = (buffer, onEvent) => {
        let rest = buffer;
        while (true) {
          const index = rest.indexOf("\\n\\n");
          if (index < 0) {
            return rest;
          }
          const raw = rest.slice(0, index);
          rest = rest.slice(index + 2);
          const lines = raw.split("\\n");
          let eventName = "message";
          let data = "";
          for (const line of lines) {
            if (line.startsWith("event:")) {
              eventName = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              data += line.slice(5).trim();
            }
          }
          if (data) {
            try {
              onEvent(eventName, JSON.parse(data));
            } catch {}
          }
        }
      };

      const setStreaming = (value) => {
        state.isStreaming = value;
        elements.send.disabled = value;
      };

      const pushToolActivity = (assistantMessage, line) => {
        if (!line) {
          return;
        }
        if (
          !assistantMessage.metadata ||
          !Array.isArray(assistantMessage.metadata.toolActivity)
        ) {
          assistantMessage.metadata = {
            ...(assistantMessage.metadata || {}),
            toolActivity: [],
          };
        }
        assistantMessage.metadata.toolActivity.push(line);
      };

      const autoResizePrompt = () => {
        const el = elements.prompt;
        el.style.height = "auto";
        const scrollHeight = el.scrollHeight;
        const nextHeight = Math.min(scrollHeight, 200);
        el.style.height = nextHeight + "px";
        el.style.overflowY = scrollHeight > 200 ? "auto" : "hidden";
      };

      const sendMessage = async (text) => {
        const messageText = (text || "").trim();
        if (!messageText || state.isStreaming) {
          return;
        }
        let conversationId = state.activeConversationId;
        if (!conversationId) {
          conversationId = await createConversation(messageText);
        }
        const existingPayload = await api("/api/conversations/" + encodeURIComponent(conversationId));
        const localMessages = [...(existingPayload.conversation.messages || []), { role: "user", content: messageText }];
        let assistantMessage = { role: "assistant", content: "", metadata: { toolActivity: [] } };
        localMessages.push(assistantMessage);
        renderMessages(localMessages, true);
        setStreaming(true);
        try {
          const response = await fetch("/api/conversations/" + encodeURIComponent(conversationId) + "/messages", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json", "x-csrf-token": state.csrfToken },
            body: JSON.stringify({ message: messageText })
          });
          if (!response.ok || !response.body) {
            throw new Error("Failed to stream response");
          }
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          while (true) {
            const { value, done } = await reader.read();
            if (done) {
              break;
            }
            buffer += decoder.decode(value, { stream: true });
            buffer = parseSseChunk(buffer, (eventName, payload) => {
              if (eventName === "model:chunk") {
                assistantMessage.content += String(payload.content || "");
                renderMessages(localMessages, true);
              }
              if (eventName === "tool:started") {
                pushToolActivity(assistantMessage, "start " + (payload.tool || "tool"));
                renderMessages(localMessages, true);
              }
              if (eventName === "tool:completed") {
                const duration = typeof payload.duration === "number" ? payload.duration : null;
                pushToolActivity(
                  assistantMessage,
                  "done " +
                    (payload.tool || "tool") +
                    (duration !== null ? " (" + duration + "ms)" : ""),
                );
                renderMessages(localMessages, true);
              }
              if (eventName === "tool:error") {
                pushToolActivity(
                  assistantMessage,
                  "error " + (payload.tool || "tool") + ": " + (payload.error || "unknown error"),
                );
                renderMessages(localMessages, true);
              }
              if (eventName === "tool:approval:required") {
                pushToolActivity(assistantMessage, "approval required for " + (payload.tool || "tool"));
                renderMessages(localMessages, true);
              }
              if (eventName === "tool:approval:granted") {
                pushToolActivity(assistantMessage, "approval granted");
                renderMessages(localMessages, true);
              }
              if (eventName === "tool:approval:denied") {
                pushToolActivity(assistantMessage, "approval denied");
                renderMessages(localMessages, true);
              }
              if (eventName === "run:completed" && (!assistantMessage.content || assistantMessage.content.length === 0)) {
                assistantMessage.content = String(payload.result?.response || "");
                renderMessages(localMessages, false);
              }
              if (eventName === "run:error") {
                const errMsg = payload.error?.message || "Something went wrong";
                assistantMessage.content = "";
                assistantMessage._error = errMsg;
                renderMessages(localMessages, false);
              }
            });
          }
          await loadConversations();
          await loadConversation(conversationId);
        } finally {
          setStreaming(false);
          elements.prompt.focus();
        }
      };

      const requireAuth = async () => {
        try {
          const session = await api("/api/auth/session");
          if (!session.authenticated) {
            elements.auth.classList.remove("hidden");
            elements.app.classList.add("hidden");
            return false;
          }
          state.csrfToken = session.csrfToken || "";
          elements.auth.classList.add("hidden");
          elements.app.classList.remove("hidden");
          return true;
        } catch {
          elements.auth.classList.remove("hidden");
          elements.app.classList.add("hidden");
          return false;
        }
      };

      elements.loginForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        elements.loginError.textContent = "";
        try {
          const result = await api("/api/auth/login", {
            method: "POST",
            body: JSON.stringify({ passphrase: elements.passphrase.value || "" })
          });
          state.csrfToken = result.csrfToken || "";
          elements.passphrase.value = "";
          elements.auth.classList.add("hidden");
          elements.app.classList.remove("hidden");
          await loadConversations();
          const urlConversationId = getConversationIdFromUrl();
          if (urlConversationId) {
            state.activeConversationId = urlConversationId;
            renderConversationList();
            try {
              await loadConversation(urlConversationId);
            } catch {
              state.activeConversationId = null;
              replaceConversationUrl(null);
              renderMessages([]);
              renderConversationList();
            }
          }
        } catch (error) {
          elements.loginError.textContent = error.message || "Login failed";
        }
      });

      elements.newChat.addEventListener("click", () => {
        state.activeConversationId = null;
        state.confirmDeleteId = null;
        pushConversationUrl(null);
        elements.chatTitle.textContent = "";
        renderMessages([]);
        renderConversationList();
        elements.prompt.focus();
        if (isMobile()) {
          setSidebarOpen(false);
        }
      });

      elements.prompt.addEventListener("input", () => {
        autoResizePrompt();
      });

      elements.prompt.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          elements.composer.requestSubmit();
        }
      });

      elements.sidebarToggle.addEventListener("click", () => {
        if (isMobile()) setSidebarOpen(!elements.shell.classList.contains("sidebar-open"));
      });

      elements.sidebarBackdrop.addEventListener("click", () => setSidebarOpen(false));

      elements.logout.addEventListener("click", async () => {
        await api("/api/auth/logout", { method: "POST" });
        state.activeConversationId = null;
        state.confirmDeleteId = null;
        state.conversations = [];
        state.csrfToken = "";
        await requireAuth();
      });

      elements.composer.addEventListener("submit", async (event) => {
        event.preventDefault();
        const value = elements.prompt.value;
        elements.prompt.value = "";
        autoResizePrompt();
        await sendMessage(value);
      });

      document.addEventListener("click", (event) => {
        if (!(event.target instanceof Node)) {
          return;
        }
        if (!event.target.closest(".conversation-item") && state.confirmDeleteId) {
          state.confirmDeleteId = null;
          renderConversationList();
        }
      });

      window.addEventListener("resize", () => {
        setSidebarOpen(false);
      });

      const navigateToConversation = async (conversationId) => {
        if (conversationId) {
          state.activeConversationId = conversationId;
          renderConversationList();
          try {
            await loadConversation(conversationId);
          } catch {
            // Conversation not found – fall back to empty state
            state.activeConversationId = null;
            replaceConversationUrl(null);
            elements.chatTitle.textContent = "";
            renderMessages([]);
            renderConversationList();
          }
        } else {
          state.activeConversationId = null;
          elements.chatTitle.textContent = "";
          renderMessages([]);
          renderConversationList();
        }
      };

      window.addEventListener("popstate", async () => {
        if (state.isStreaming) return;
        const conversationId = getConversationIdFromUrl();
        await navigateToConversation(conversationId);
      });

      (async () => {
        const authenticated = await requireAuth();
        if (!authenticated) {
          return;
        }
        await loadConversations();
        const urlConversationId = getConversationIdFromUrl();
        if (urlConversationId) {
          state.activeConversationId = urlConversationId;
          replaceConversationUrl(urlConversationId);
          renderConversationList();
          try {
            await loadConversation(urlConversationId);
          } catch {
            // URL pointed to a conversation that no longer exists
            state.activeConversationId = null;
            replaceConversationUrl(null);
            elements.chatTitle.textContent = "";
            renderMessages([]);
            renderConversationList();
            if (state.conversations.length === 0) {
              await createConversation();
            }
          }
        } else if (state.conversations.length === 0) {
          await createConversation();
        }
        autoResizePrompt();
        elements.prompt.focus();
      })();

      if ("serviceWorker" in navigator) {
        navigator.serviceWorker.register("/sw.js").catch(() => {});
      }

      // iOS keyboard: use visualViewport to set the real visible height
      // and prevent the page from scrolling behind the keyboard.
      (function() {
        const setHeight = () => {
          const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
          document.documentElement.style.setProperty("--app-height", h + "px");
        };
        if (window.visualViewport) {
          window.visualViewport.addEventListener("resize", setHeight);
        }
        window.addEventListener("resize", setHeight);
        setHeight();

        // Prevent iOS from scrolling the page when the keyboard opens.
        // Keep scroll pinned to 0 whenever an input is focused.
        var inputFocused = false;
        var pinScroll = function() { if (inputFocused && window.scrollY !== 0) window.scrollTo(0, 0); };
        document.addEventListener("focusin", function(e) {
          if (e.target && (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT")) {
            inputFocused = true;
          }
        });
        document.addEventListener("focusout", function() {
          inputFocused = false;
          window.scrollTo(0, 0);
        });
        if (window.visualViewport) {
          window.visualViewport.addEventListener("scroll", pinScroll);
          window.visualViewport.addEventListener("resize", pinScroll);
        }
        document.addEventListener("scroll", pinScroll);
      })();

    </script>
  </body>
</html>`;
};
