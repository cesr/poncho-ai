import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { basename, dirname, resolve, join } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Message } from "@poncho-ai/sdk";

// Load marked library at module initialization (ESM compatible)
const require = createRequire(import.meta.url);
const markedPackagePath = require.resolve("marked");
const markedDir = dirname(markedPackagePath);
const markedSource = readFileSync(join(markedDir, "marked.umd.js"), "utf-8");

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
    return "/tmp/.poncho/state";
  }
  return resolve(homedir(), ".poncho", "state");
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
    description: `${name} — AI agent powered by Poncho`,
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
const CACHE_NAME = "poncho-shell-v1";
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
    html, body { height: 100vh; overflow: hidden; overscroll-behavior: none; touch-action: pan-y; }
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
      width: min(400px, 90vw);
    }
    .auth-shell {
      background: #0a0a0a;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 9999px;
      display: flex;
      align-items: center;
      padding: 4px 6px 4px 18px;
      transition: border-color 0.15s;
    }
    .auth-shell:focus-within { border-color: rgba(255,255,255,0.2); }
    .auth-input {
      flex: 1;
      background: transparent;
      border: 0;
      outline: none;
      color: #ededed;
      padding: 10px 0 8px;
      font-size: 14px;
      margin-top: -2px;
    }
    .auth-input::placeholder { color: #444; }
    .auth-submit {
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

    /* Layout - use fixed positioning with explicit dimensions */
    .shell { 
      position: fixed; 
      top: 0; 
      left: 0;
      width: 100vw;
      height: 100vh;
      height: 100dvh; /* Dynamic viewport height for normal browsers */
      display: flex; 
      overflow: hidden;
    }
    /* PWA standalone mode: use 100vh which works correctly */
    @media (display-mode: standalone) {
      .shell {
        height: 100vh;
      }
    }
    
    /* Edge swipe blocker - invisible touch target to intercept right edge gestures */
    .edge-blocker-right {
      position: fixed;
      top: 0;
      bottom: 0;
      right: 0;
      width: 20px;
      z-index: 9999;
      touch-action: none;
    }
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
      height: 36px;
      min-height: 36px;
      max-height: 36px;
      flex-shrink: 0;
      padding: 0 16px 0 10px;
      border-radius: 12px;
      cursor: pointer;
      font-size: 13px;
      line-height: 36px;
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
    .main { flex: 1; display: flex; flex-direction: column; min-width: 0; max-width: 100%; background: #000; overflow: hidden; }
    .topbar {
      height: calc(52px + env(safe-area-inset-top, 0px));
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
      max-width: calc(100% - 100px);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      letter-spacing: -0.01em;
      padding: 0 50px;
    }
    .sidebar-toggle {
      display: none;
      position: absolute;
      left: 12px;
      bottom: 4px; /* Position from bottom of topbar content area */
      background: transparent;
      border: 0;
      color: #666;
      width: 44px;
      height: 44px;
      border-radius: 6px;
      cursor: pointer;
      transition: color 0.15s, background 0.15s;
      font-size: 18px;
      z-index: 10;
      -webkit-tap-highlight-color: transparent;
    }
    .sidebar-toggle:hover { color: #ededed; }
    .topbar-new-chat {
      display: none;
      position: absolute;
      right: 12px;
      bottom: 4px;
      background: transparent;
      border: 0;
      color: #666;
      width: 44px;
      height: 44px;
      border-radius: 6px;
      cursor: pointer;
      transition: color 0.15s, background 0.15s;
      z-index: 10;
      -webkit-tap-highlight-color: transparent;
    }
    .topbar-new-chat:hover { color: #ededed; }
    .topbar-new-chat svg { width: 16px; height: 16px; }

    /* Messages */
    .messages { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 24px 24px; }
    .messages-column { max-width: 680px; margin: 0 auto; }
    .message-row { margin-bottom: 24px; display: flex; max-width: 100%; }
    .message-row.user { justify-content: flex-end; }
    .assistant-wrap { display: flex; gap: 12px; max-width: 100%; min-width: 0; }
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
      max-width: 100%;
      overflow-wrap: break-word;
      word-break: break-word;
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
    .tool-activity-inline {
      margin: 8px 0;
      font-size: 12px;
      line-height: 1.45;
      color: #8a8a8a;
    }
    .tool-activity-inline code {
      font-family: ui-monospace, "SF Mono", "Fira Code", monospace;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      padding: 4px 8px;
      border-radius: 6px;
      color: #bcbcbc;
      font-size: 11px;
    }
    .tool-status {
      color: #8a8a8a;
      font-style: italic;
    }
    .tool-done {
      color: #6a9955;
    }
    .tool-error {
      color: #f48771;
    }
    .assistant-content table {
      border-collapse: collapse;
      width: 100%;
      margin: 14px 0;
      font-size: 13px;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 8px;
      overflow: hidden;
      display: block;
      max-width: 100%;
      overflow-x: auto;
      white-space: nowrap;
    }
    .assistant-content th {
      background: rgba(255,255,255,0.06);
      padding: 10px 12px;
      text-align: left;
      font-weight: 600;
      border-bottom: 1px solid rgba(255,255,255,0.12);
      color: #fff;
      min-width: 100px;
    }
    .assistant-content td {
      padding: 10px 12px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      width: 100%;
      min-width: 100px;
    }
    .assistant-content tr:last-child td {
      border-bottom: none;
    }
    .assistant-content tbody tr:hover {
      background: rgba(255,255,255,0.02);
    }
    .assistant-content hr {
      border: 0;
      border-top: 1px solid rgba(255,255,255,0.1);
      margin: 20px 0;
    }
    .tool-activity {
      margin-top: 12px;
      margin-bottom: 12px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.03);
      border-radius: 10px;
      font-size: 12px;
      line-height: 1.45;
      color: #bcbcbc;
      width: 300px;
    }
    .assistant-content > .tool-activity:first-child {
      margin-top: 0;
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
    .approval-requests {
      border-top: 1px solid rgba(255,255,255,0.08);
      padding: 10px 12px 12px;
      display: grid;
      gap: 8px;
      background: rgba(0,0,0,0.16);
    }
    .approval-requests-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: #b0b0b0;
      font-weight: 600;
    }
    .approval-request-item {
      border: 1px solid rgba(255,255,255,0.1);
      background: rgba(255,255,255,0.03);
      border-radius: 8px;
      padding: 8px;
      display: grid;
      gap: 6px;
    }
    .approval-request-tool {
      font-size: 12px;
      color: #fff;
      font-weight: 600;
      overflow-wrap: anywhere;
    }
    .approval-request-input {
      font-family: ui-monospace, "SF Mono", "Fira Code", monospace;
      font-size: 11px;
      color: #cfcfcf;
      background: rgba(0,0,0,0.25);
      border-radius: 6px;
      padding: 6px;
      overflow-wrap: anywhere;
      max-height: 80px;
      overflow-y: auto;
    }
    .approval-request-actions {
      display: flex;
      gap: 6px;
    }
    .approval-action-btn {
      border-radius: 6px;
      border: 1px solid rgba(255,255,255,0.18);
      background: rgba(255,255,255,0.06);
      color: #f0f0f0;
      font-size: 11px;
      font-weight: 600;
      padding: 4px 8px;
      cursor: pointer;
    }
    .approval-action-btn:hover {
      background: rgba(255,255,255,0.12);
    }
    .approval-action-btn.approve {
      border-color: rgba(58, 208, 122, 0.45);
      color: #78e7a6;
    }
    .approval-action-btn.deny {
      border-color: rgba(224, 95, 95, 0.45);
      color: #f59b9b;
    }
    .approval-action-btn[disabled] {
      opacity: 0.55;
      cursor: not-allowed;
    }
    .user-bubble {
      background: #111;
      border: 1px solid rgba(255,255,255,0.08);
      padding: 10px 16px;
      border-radius: 18px;
      max-width: 70%;
      font-size: 14px;
      line-height: 1.5;
      overflow-wrap: break-word;
      word-break: break-word;
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
    .thinking-status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin-top: 2px;
      color: #8a8a8a;
      font-size: 14px;
      line-height: 1.65;
      font-weight: 400;
    }
    .thinking-status-label {
      color: #8a8a8a;
      font-size: 14px;
      line-height: 1.65;
      font-weight: 400;
      white-space: nowrap;
    }

    /* Composer */
    .composer {
      padding: 12px 24px 24px;
      position: relative;
    }
    /* PWA standalone mode - extra bottom padding */
    @media (display-mode: standalone), (-webkit-touch-callout: none) {
      .composer {
        padding-bottom: 32px;
      }
    }
    @supports (-webkit-touch-callout: none) {
      /* iOS Safari standalone check via JS class */
      .standalone .composer {
        padding-bottom: 32px;
      }
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
      margin-top: -2px;
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
        padding-top: calc(env(safe-area-inset-top, 0px) + 12px);
        will-change: transform;
      }
      .sidebar.dragging { transition: none; }
      .sidebar:not(.dragging) { transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1); }
      .shell.sidebar-open .sidebar { transform: translateX(0); }
      .sidebar-toggle { display: grid; place-items: center; }
      .topbar-new-chat { display: grid; place-items: center; }
      .sidebar-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.6);
        z-index: 50;
        backdrop-filter: blur(2px);
        -webkit-backdrop-filter: blur(2px);
        opacity: 0;
        pointer-events: none;
        will-change: opacity;
      }
      .sidebar-backdrop:not(.dragging) { transition: opacity 0.25s cubic-bezier(0.4, 0, 0.2, 1); }
      .sidebar-backdrop.dragging { transition: none; }
      .shell.sidebar-open .sidebar-backdrop { opacity: 1; pointer-events: auto; }
      .messages { padding: 16px; }
      .composer { padding: 8px 16px 16px; }
      /* Always show delete button on mobile (no hover) */
      .conversation-item .delete-btn { opacity: 1; }
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
  <div class="edge-blocker-right"></div>
  <div id="auth" class="auth hidden">
    <form id="login-form" class="auth-card">
      <div class="auth-shell">
        <input id="passphrase" class="auth-input" type="password" placeholder="Passphrase" required autofocus>
        <button class="auth-submit" type="submit">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 8h8M9 5l3 3-3 3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
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
        <button id="topbar-new-chat" class="topbar-new-chat">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
        </button>
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
      // Marked library (inlined)
      ${markedSource}

      // Configure marked for GitHub Flavored Markdown (tables, etc.)
      marked.setOptions({
        gfm: true,
        breaks: true
      });

      const state = {
        csrfToken: "",
        conversations: [],
        activeConversationId: null,
        activeMessages: [],
        isStreaming: false,
        isMessagesPinnedToBottom: true,
        confirmDeleteId: null,
        approvalRequestsInFlight: {}
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
        topbarNewChat: $("topbar-new-chat"),
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

      const renderAssistantMarkdown = (value) => {
        const source = String(value || "").trim();
        if (!source) return "<p></p>";

        try {
          return marked.parse(source);
        } catch (error) {
          console.error("Markdown parsing error:", error);
          // Fallback to escaped text
          return "<p>" + escapeHtml(source) + "</p>";
        }
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

      const renderApprovalRequests = (requests) => {
        if (!Array.isArray(requests) || requests.length === 0) {
          return "";
        }
        const rows = requests
          .map((req) => {
            const approvalId = typeof req.approvalId === "string" ? req.approvalId : "";
            const tool = typeof req.tool === "string" ? req.tool : "tool";
            const inputPreview = typeof req.inputPreview === "string" ? req.inputPreview : "{}";
            const submitting = req.state === "submitting";
            const approveLabel = submitting && req.pendingDecision === "approve" ? "Approving..." : "Approve";
            const denyLabel = submitting && req.pendingDecision === "deny" ? "Denying..." : "Deny";
            return (
              '<div class="approval-request-item">' +
              '<div class="approval-request-tool">' +
              escapeHtml(tool) +
              "</div>" +
              '<div class="approval-request-input">' +
              escapeHtml(inputPreview) +
              "</div>" +
              '<div class="approval-request-actions">' +
              '<button class="approval-action-btn approve" data-approval-id="' +
              escapeHtml(approvalId) +
              '" data-approval-decision="approve" ' +
              (submitting ? "disabled" : "") +
              ">" +
              approveLabel +
              "</button>" +
              '<button class="approval-action-btn deny" data-approval-id="' +
              escapeHtml(approvalId) +
              '" data-approval-decision="deny" ' +
              (submitting ? "disabled" : "") +
              ">" +
              denyLabel +
              "</button>" +
              "</div>" +
              "</div>"
            );
          })
          .join("");
        return (
          '<div class="approval-requests">' +
          '<div class="approval-requests-label">Approval required</div>' +
          rows +
          "</div>"
        );
      };

      const renderToolActivity = (items, approvalRequests = []) => {
        const hasItems = Array.isArray(items) && items.length > 0;
        const hasApprovals = Array.isArray(approvalRequests) && approvalRequests.length > 0;
        if (!hasItems && !hasApprovals) {
          return "";
        }
        const chips = hasItems
          ? items
              .map((item) => '<div class="tool-activity-item">' + escapeHtml(item) + "</div>")
              .join("")
          : "";
        const disclosure = hasItems
          ? (
              '<details class="tool-activity-disclosure">' +
              '<summary class="tool-activity-summary">' +
              '<span class="tool-activity-label">Tool activity</span>' +
              '<span class="tool-activity-caret" aria-hidden="true"><svg viewBox="0 0 12 12" fill="none"><path d="M4.5 2.75L8 6L4.5 9.25" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path></svg></span>' +
              "</summary>" +
              '<div class="tool-activity-list">' +
              chips +
              "</div>" +
              "</details>"
            )
          : "";
        return (
          '<div class="tool-activity">' +
          disclosure +
          renderApprovalRequests(approvalRequests) +
          "</div>"
        );
      };

      const safeJsonPreview = (value) => {
        try {
          return JSON.stringify(value, (_, nestedValue) =>
            typeof nestedValue === "bigint" ? String(nestedValue) : nestedValue,
          );
        } catch {
          return "[unserializable input]";
        }
      };

      const updatePendingApproval = (approvalId, updater) => {
        if (!approvalId || typeof updater !== "function") {
          return false;
        }
        const messages = state.activeMessages || [];
        for (const message of messages) {
          if (!message || !Array.isArray(message._pendingApprovals)) {
            continue;
          }
          const idx = message._pendingApprovals.findIndex((req) => req.approvalId === approvalId);
          if (idx < 0) {
            continue;
          }
          const next = updater(message._pendingApprovals[idx], message._pendingApprovals);
          if (next === null) {
            message._pendingApprovals.splice(idx, 1);
          } else if (next && typeof next === "object") {
            message._pendingApprovals[idx] = next;
          }
          return true;
        }
        return false;
      };

      const toUiPendingApprovals = (pendingApprovals) => {
        if (!Array.isArray(pendingApprovals)) {
          return [];
        }
        return pendingApprovals
          .map((item) => {
            const approvalId =
              item && typeof item.approvalId === "string" ? item.approvalId : "";
            if (!approvalId) {
              return null;
            }
            const toolName = item && typeof item.tool === "string" ? item.tool : "tool";
            const preview = safeJsonPreview(item?.input ?? {});
            const inputPreview = preview.length > 600 ? preview.slice(0, 600) + "..." : preview;
            return {
              approvalId,
              tool: toolName,
              inputPreview,
              state: "pending",
            };
          })
          .filter(Boolean);
      };

      const hydratePendingApprovals = (messages, pendingApprovals) => {
        const nextMessages = Array.isArray(messages) ? [...messages] : [];
        const pending = toUiPendingApprovals(pendingApprovals);
        if (pending.length === 0) {
          return nextMessages;
        }
        const toolLines = pending.map((request) => "- approval required \\x60" + request.tool + "\\x60");
        for (let idx = nextMessages.length - 1; idx >= 0; idx -= 1) {
          const message = nextMessages[idx];
          if (!message || message.role !== "assistant") {
            continue;
          }
          const metadata = message.metadata && typeof message.metadata === "object" ? message.metadata : {};
          const existingTimeline = Array.isArray(metadata.toolActivity) ? metadata.toolActivity : [];
          const mergedTimeline = [...existingTimeline];
          toolLines.forEach((line) => {
            if (!mergedTimeline.includes(line)) {
              mergedTimeline.push(line);
            }
          });
          nextMessages[idx] = {
            ...message,
            metadata: {
              ...metadata,
              toolActivity: mergedTimeline,
            },
            _pendingApprovals: pending,
          };
          return nextMessages;
        }
        nextMessages.push({
          role: "assistant",
          content: "",
          metadata: { toolActivity: toolLines },
          _pendingApprovals: pending,
        });
        return nextMessages;
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
              state.activeMessages = [];
              pushConversationUrl(null);
              elements.chatTitle.textContent = "";
              renderMessages([]);
            }
            state.confirmDeleteId = null;
            await loadConversations();
          };
          item.appendChild(deleteBtn);

          item.onclick = async () => {
            // Clear any delete confirmation, but still navigate
            if (state.confirmDeleteId) {
              state.confirmDeleteId = null;
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

      const isNearBottom = (element, threshold = 64) => {
        if (!element) return true;
        return (
          element.scrollHeight - element.clientHeight - element.scrollTop <= threshold
        );
      };

      const renderMessages = (messages, isStreaming = false, options = {}) => {
        const previousScrollTop = elements.messages.scrollTop;
        const shouldStickToBottom =
          options.forceScrollBottom === true || state.isMessagesPinnedToBottom;

        const createThinkingIndicator = (label) => {
          const status = document.createElement("div");
          status.className = "thinking-status";
          const spinner = document.createElement("span");
          spinner.className = "thinking-indicator";
          const starFrames = ["✶", "✸", "✹", "✺", "✹", "✷"];
          let frame = 0;
          spinner.textContent = starFrames[0];
          spinner._interval = setInterval(() => {
            frame = (frame + 1) % starFrames.length;
            spinner.textContent = starFrames[frame];
          }, 70);
          status.appendChild(spinner);
          if (label) {
            const text = document.createElement("span");
            text.className = "thinking-status-label";
            text.textContent = label;
            status.appendChild(text);
          }
          return status;
        };

        elements.messages.innerHTML = "";
        if (!messages || !messages.length) {
          elements.messages.innerHTML = '<div class="empty-state"><div class="assistant-avatar">' + agentInitial + '</div><div>How can I help you today?</div></div>';
          elements.messages.scrollTop = 0;
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
            const isLastAssistant = i === messages.length - 1;
            const hasPendingApprovals =
              Array.isArray(m._pendingApprovals) && m._pendingApprovals.length > 0;
            const shouldRenderEmptyStreamingIndicator =
              isStreaming &&
              isLastAssistant &&
              !text &&
              (!Array.isArray(m._sections) || m._sections.length === 0) &&
              (!Array.isArray(m._currentTools) || m._currentTools.length === 0) &&
              !hasPendingApprovals;

            if (m._error) {
              const errorEl = document.createElement("div");
              errorEl.className = "message-error";
              errorEl.innerHTML = "<strong>Error</strong><br>" + escapeHtml(m._error);
              content.appendChild(errorEl);
            } else if (shouldRenderEmptyStreamingIndicator) {
              content.appendChild(createThinkingIndicator(getThinkingStatusLabel(m)));
            } else {
              // Check for sections in _sections (streaming) or metadata.sections (stored)
              const sections = m._sections || (m.metadata && m.metadata.sections);
              const pendingApprovals = Array.isArray(m._pendingApprovals) ? m._pendingApprovals : [];

              if (sections && sections.length > 0) {
                let lastToolsSectionIndex = -1;
                for (let sectionIdx = sections.length - 1; sectionIdx >= 0; sectionIdx -= 1) {
                  if (sections[sectionIdx] && sections[sectionIdx].type === "tools") {
                    lastToolsSectionIndex = sectionIdx;
                    break;
                  }
                }
                // Render sections interleaved
                sections.forEach((section, sectionIdx) => {
                  if (section.type === "text") {
                    const textDiv = document.createElement("div");
                    textDiv.innerHTML = renderAssistantMarkdown(section.content);
                    content.appendChild(textDiv);
                  } else if (section.type === "tools") {
                    const sectionApprovals =
                      !isStreaming &&
                      pendingApprovals.length > 0 &&
                      sectionIdx === lastToolsSectionIndex
                        ? pendingApprovals
                        : [];
                    content.insertAdjacentHTML(
                      "beforeend",
                      renderToolActivity(section.content, sectionApprovals),
                    );
                  }
                });
                // While streaming, show current tools if any
                if (isStreaming && i === messages.length - 1 && m._currentTools && m._currentTools.length > 0) {
                  content.insertAdjacentHTML(
                    "beforeend",
                    renderToolActivity(m._currentTools, m._pendingApprovals || []),
                  );
                }
                // When reloading with unresolved approvals, show them even when not streaming
                if (!isStreaming && pendingApprovals.length > 0 && lastToolsSectionIndex < 0) {
                  content.insertAdjacentHTML("beforeend", renderToolActivity([], m._pendingApprovals));
                }
                // Show current text being typed
                if (isStreaming && i === messages.length - 1 && m._currentText) {
                  const textDiv = document.createElement("div");
                  textDiv.innerHTML = renderAssistantMarkdown(m._currentText);
                  content.appendChild(textDiv);
                }
              } else {
                // Fallback: render text and tools the old way (for old messages without sections)
                if (text) {
                  const parsed = extractToolActivity(text);
                  content.innerHTML = renderAssistantMarkdown(parsed.content);
                }
                const metadataToolActivity =
                  m.metadata && Array.isArray(m.metadata.toolActivity)
                    ? m.metadata.toolActivity
                    : [];
                if (metadataToolActivity.length > 0 || pendingApprovals.length > 0) {
                  content.insertAdjacentHTML(
                    "beforeend",
                    renderToolActivity(metadataToolActivity, pendingApprovals),
                  );
                }
              }
              if (
                isStreaming &&
                isLastAssistant &&
                !hasPendingApprovals
              ) {
                const waitIndicator = document.createElement("div");
                waitIndicator.appendChild(createThinkingIndicator(getThinkingStatusLabel(m)));
                content.appendChild(waitIndicator);
              }
            }
            wrap.appendChild(content);
            row.appendChild(wrap);
          } else {
            row.innerHTML = '<div class="user-bubble">' + escapeHtml(m.content) + '</div>';
          }
          col.appendChild(row);
        });
        elements.messages.appendChild(col);
        if (shouldStickToBottom) {
          elements.messages.scrollTop = elements.messages.scrollHeight;
          state.isMessagesPinnedToBottom = true;
          return;
        }
        if (options.preserveScroll !== false) {
          elements.messages.scrollTop = previousScrollTop;
        }
      };

      const loadConversations = async () => {
        const payload = await api("/api/conversations");
        state.conversations = payload.conversations || [];
        renderConversationList();
      };

      const loadConversation = async (conversationId) => {
        const payload = await api("/api/conversations/" + encodeURIComponent(conversationId));
        elements.chatTitle.textContent = payload.conversation.title;
        state.activeMessages = hydratePendingApprovals(
          payload.conversation.messages || [],
          payload.conversation.pendingApprovals || payload.pendingApprovals || [],
        );
        renderMessages(state.activeMessages, false, { forceScrollBottom: true });
        elements.prompt.focus();
      };

      const streamConversationEvents = (conversationId) => {
        return new Promise((resolve) => {
          const localMessages = state.activeMessages || [];
          const renderIfActiveConversation = (streaming) => {
            if (state.activeConversationId !== conversationId) {
              return;
            }
            state.activeMessages = localMessages;
            renderMessages(localMessages, streaming);
          };
          let assistantMessage = localMessages[localMessages.length - 1];
          if (!assistantMessage || assistantMessage.role !== "assistant") {
            assistantMessage = {
              role: "assistant",
              content: "",
              _sections: [],
              _currentText: "",
              _currentTools: [],
              _pendingApprovals: [],
              metadata: { toolActivity: [] },
            };
            localMessages.push(assistantMessage);
            state.activeMessages = localMessages;
          }
          if (!assistantMessage._sections) assistantMessage._sections = [];
          if (!assistantMessage._currentText) assistantMessage._currentText = "";
          if (!assistantMessage._currentTools) assistantMessage._currentTools = [];
          if (!assistantMessage._activeActivities) assistantMessage._activeActivities = [];
          if (!assistantMessage._pendingApprovals) assistantMessage._pendingApprovals = [];
          if (!assistantMessage.metadata) assistantMessage.metadata = {};
          if (!assistantMessage.metadata.toolActivity) assistantMessage.metadata.toolActivity = [];

          const url = "/api/conversations/" + encodeURIComponent(conversationId) + "/events";
          fetch(url, { credentials: "include" }).then((response) => {
            if (!response.ok || !response.body) {
              resolve(undefined);
              return;
            }
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            const processChunks = async () => {
              while (true) {
                const { value, done } = await reader.read();
                if (done) {
                  break;
                }
                buffer += decoder.decode(value, { stream: true });
                buffer = parseSseChunk(buffer, (eventName, payload) => {
                  try {
                    if (eventName === "stream:end") {
                      return;
                    }
                    if (eventName === "model:chunk") {
                      const chunk = String(payload.content || "");
                      if (assistantMessage._currentTools.length > 0 && chunk.length > 0) {
                        assistantMessage._sections.push({
                          type: "tools",
                          content: assistantMessage._currentTools,
                        });
                        assistantMessage._currentTools = [];
                      }
                      assistantMessage.content += chunk;
                      assistantMessage._currentText += chunk;
                      renderIfActiveConversation(true);
                    }
                    if (eventName === "tool:started") {
                      const toolName = payload.tool || "tool";
                      const startedActivity = addActiveActivityFromToolStart(
                        assistantMessage,
                        payload,
                      );
                      if (assistantMessage._currentText.length > 0) {
                        assistantMessage._sections.push({
                          type: "text",
                          content: assistantMessage._currentText,
                        });
                        assistantMessage._currentText = "";
                      }
                      const detail =
                        startedActivity && typeof startedActivity.detail === "string"
                          ? startedActivity.detail.trim()
                          : "";
                      const toolText =
                        "- start \\x60" +
                        toolName +
                        "\\x60" +
                        (detail ? " (" + detail + ")" : "");
                      assistantMessage._currentTools.push(toolText);
                      assistantMessage.metadata.toolActivity.push(toolText);
                      renderIfActiveConversation(true);
                    }
                    if (eventName === "tool:completed") {
                      const toolName = payload.tool || "tool";
                      const activeActivity = removeActiveActivityForTool(
                        assistantMessage,
                        toolName,
                      );
                      const duration =
                        typeof payload.duration === "number" ? payload.duration : null;
                      const detail =
                        activeActivity && typeof activeActivity.detail === "string"
                          ? activeActivity.detail.trim()
                          : "";
                      const meta = [];
                      if (duration !== null) meta.push(duration + "ms");
                      if (detail) meta.push(detail);
                      const toolText =
                        "- done \\x60" +
                        toolName +
                        "\\x60" +
                        (meta.length > 0 ? " (" + meta.join(", ") + ")" : "");
                      assistantMessage._currentTools.push(toolText);
                      assistantMessage.metadata.toolActivity.push(toolText);
                      renderIfActiveConversation(true);
                    }
                    if (eventName === "tool:error") {
                      const toolName = payload.tool || "tool";
                      const activeActivity = removeActiveActivityForTool(
                        assistantMessage,
                        toolName,
                      );
                      const errorMsg = payload.error || "unknown error";
                      const detail =
                        activeActivity && typeof activeActivity.detail === "string"
                          ? activeActivity.detail.trim()
                          : "";
                      const toolText =
                        "- error \\x60" +
                        toolName +
                        "\\x60" +
                        (detail ? " (" + detail + ")" : "") +
                        ": " +
                        errorMsg;
                      assistantMessage._currentTools.push(toolText);
                      assistantMessage.metadata.toolActivity.push(toolText);
                      renderIfActiveConversation(true);
                    }
                    if (eventName === "run:completed") {
                      assistantMessage._activeActivities = [];
                      if (
                        !assistantMessage.content ||
                        assistantMessage.content.length === 0
                      ) {
                        assistantMessage.content = String(
                          payload.result?.response || "",
                        );
                      }
                      if (assistantMessage._currentTools.length > 0) {
                        assistantMessage._sections.push({
                          type: "tools",
                          content: assistantMessage._currentTools,
                        });
                        assistantMessage._currentTools = [];
                      }
                      if (assistantMessage._currentText.length > 0) {
                        assistantMessage._sections.push({
                          type: "text",
                          content: assistantMessage._currentText,
                        });
                        assistantMessage._currentText = "";
                      }
                      renderIfActiveConversation(false);
                    }
                    if (eventName === "run:error") {
                      assistantMessage._activeActivities = [];
                      const errMsg =
                        payload.error?.message || "Something went wrong";
                      assistantMessage.content = "";
                      assistantMessage._error = errMsg;
                      renderIfActiveConversation(false);
                    }
                  } catch (error) {
                    console.error("SSE reconnect event error:", eventName, error);
                  }
                });
              }
            };
            processChunks().finally(() => {
              if (state.activeConversationId === conversationId) {
                state.activeMessages = localMessages;
              }
              resolve(undefined);
            });
          }).catch(() => {
            resolve(undefined);
          });
        });
      };

      const createConversation = async (title, options = {}) => {
        const shouldLoadConversation = options.loadConversation !== false;
        const payload = await api("/api/conversations", {
          method: "POST",
          body: JSON.stringify(title ? { title } : {})
        });
        state.activeConversationId = payload.conversation.conversationId;
        state.confirmDeleteId = null;
        pushConversationUrl(state.activeConversationId);
        await loadConversations();
        if (shouldLoadConversation) {
          await loadConversation(state.activeConversationId);
        } else {
          elements.chatTitle.textContent = payload.conversation.title || "New conversation";
        }
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

      const ensureActiveActivities = (assistantMessage) => {
        if (!Array.isArray(assistantMessage._activeActivities)) {
          assistantMessage._activeActivities = [];
        }
        return assistantMessage._activeActivities;
      };

      const getStringInputField = (input, key) => {
        if (!input || typeof input !== "object") {
          return "";
        }
        const value = input[key];
        return typeof value === "string" ? value.trim() : "";
      };

      const describeToolStart = (payload) => {
        const toolName = payload && typeof payload.tool === "string" ? payload.tool : "tool";
        const input = payload && payload.input && typeof payload.input === "object" ? payload.input : {};

        if (toolName === "activate_skill") {
          const skillName = getStringInputField(input, "name") || "skill";
          return {
            kind: "skill",
            tool: toolName,
            label: "Activating " + skillName + " skill",
            detail: "skill: " + skillName,
          };
        }

        if (toolName === "run_skill_script") {
          const scriptPath = getStringInputField(input, "script");
          const skillName = getStringInputField(input, "skill");
          if (scriptPath && skillName) {
            return {
              kind: "tool",
              tool: toolName,
              label: "Running script " + scriptPath + " in " + skillName + " skill",
              detail: "script: " + scriptPath + ", skill: " + skillName,
            };
          }
          if (scriptPath) {
            return {
              kind: "tool",
              tool: toolName,
              label: "Running script " + scriptPath,
              detail: "script: " + scriptPath,
            };
          }
        }

        if (toolName === "read_skill_resource") {
          const resourcePath = getStringInputField(input, "path");
          const skillName = getStringInputField(input, "skill");
          if (resourcePath && skillName) {
            return {
              kind: "tool",
              tool: toolName,
              label: "Reading " + resourcePath + " from " + skillName + " skill",
              detail: "path: " + resourcePath + ", skill: " + skillName,
            };
          }
          if (resourcePath) {
            return {
              kind: "tool",
              tool: toolName,
              label: "Reading " + resourcePath,
              detail: "path: " + resourcePath,
            };
          }
        }

        if (toolName === "read_file") {
          const path = getStringInputField(input, "path");
          if (path) {
            return {
              kind: "tool",
              tool: toolName,
              label: "Reading " + path,
              detail: "path: " + path,
            };
          }
        }

        return {
          kind: "tool",
          tool: toolName,
          label: "Running " + toolName + " tool",
          detail: "",
        };
      };

      const addActiveActivityFromToolStart = (assistantMessage, payload) => {
        const activities = ensureActiveActivities(assistantMessage);
        const activity = describeToolStart(payload);
        activities.push(activity);
        return activity;
      };

      const removeActiveActivityForTool = (assistantMessage, toolName) => {
        if (!toolName || !Array.isArray(assistantMessage._activeActivities)) {
          return null;
        }
        const activities = assistantMessage._activeActivities;
        const idx = activities.findIndex((item) => item && item.tool === toolName);
        if (idx >= 0) {
          return activities.splice(idx, 1)[0] || null;
        }
        return null;
      };

      const getThinkingStatusLabel = (assistantMessage) => {
        const activities = Array.isArray(assistantMessage?._activeActivities)
          ? assistantMessage._activeActivities
          : [];
        const labels = [];
        activities.forEach((item) => {
          if (!item || typeof item.label !== "string") {
            return;
          }
          const label = item.label.trim();
          if (!label || labels.includes(label)) {
            return;
          }
          labels.push(label);
        });
        if (labels.length === 1) {
          return labels[0];
        }
        if (labels.length === 2) {
          return labels[0] + ", " + labels[1];
        }
        if (labels.length > 2) {
          return labels[0] + ", " + labels[1] + " +" + (labels.length - 2) + " more";
        }

        if (Array.isArray(assistantMessage?._currentTools)) {
          const tick = String.fromCharCode(96);
          const startPrefix = "- start " + tick;
          for (let idx = assistantMessage._currentTools.length - 1; idx >= 0; idx -= 1) {
            const item = String(assistantMessage._currentTools[idx] || "");
            if (item.startsWith(startPrefix)) {
              const rest = item.slice(startPrefix.length);
              const endIdx = rest.indexOf(tick);
              const toolName = (endIdx >= 0 ? rest.slice(0, endIdx) : rest).trim();
              if (toolName) {
                return "Running " + toolName + " tool";
              }
            }
          }
        }
        return "Thinking...";
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
        const localMessages = [...(state.activeMessages || []), { role: "user", content: messageText }];
        let assistantMessage = {
          role: "assistant",
          content: "",
          _sections: [], // Array of {type: 'text'|'tools', content: string|array}
          _currentText: "",
          _currentTools: [],
          _activeActivities: [],
          _pendingApprovals: [],
          metadata: { toolActivity: [] }
        };
        localMessages.push(assistantMessage);
        state.activeMessages = localMessages;
        renderMessages(localMessages, true, { forceScrollBottom: true });
        setStreaming(true);
        let conversationId = state.activeConversationId;
        try {
          if (!conversationId) {
            conversationId = await createConversation(messageText, { loadConversation: false });
          }
          const streamConversationId = conversationId;
          const renderIfActiveConversation = (streaming) => {
            if (state.activeConversationId !== streamConversationId) {
              return;
            }
            state.activeMessages = localMessages;
            renderMessages(localMessages, streaming);
          };
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
              try {
                if (eventName === "model:chunk") {
                  const chunk = String(payload.content || "");
                  // If we have tools accumulated and text starts again, push tools as a section
                  if (assistantMessage._currentTools.length > 0 && chunk.length > 0) {
                    assistantMessage._sections.push({ type: "tools", content: assistantMessage._currentTools });
                    assistantMessage._currentTools = [];
                  }
                  assistantMessage.content += chunk;
                  assistantMessage._currentText += chunk;
                  renderIfActiveConversation(true);
                }
                if (eventName === "tool:started") {
                  const toolName = payload.tool || "tool";
                  const startedActivity = addActiveActivityFromToolStart(
                    assistantMessage,
                    payload,
                  );
                  // If we have text accumulated, push it as a text section
                  if (assistantMessage._currentText.length > 0) {
                    assistantMessage._sections.push({ type: "text", content: assistantMessage._currentText });
                    assistantMessage._currentText = "";
                  }
                  const detail =
                    startedActivity && typeof startedActivity.detail === "string"
                      ? startedActivity.detail.trim()
                      : "";
                  const toolText =
                    "- start \\x60" + toolName + "\\x60" + (detail ? " (" + detail + ")" : "");
                  assistantMessage._currentTools.push(toolText);
                  if (!assistantMessage.metadata) assistantMessage.metadata = {};
                  if (!assistantMessage.metadata.toolActivity) assistantMessage.metadata.toolActivity = [];
                  assistantMessage.metadata.toolActivity.push(toolText);
                  renderIfActiveConversation(true);
                }
                if (eventName === "tool:completed") {
                  const toolName = payload.tool || "tool";
                  const activeActivity = removeActiveActivityForTool(
                    assistantMessage,
                    toolName,
                  );
                  const duration = typeof payload.duration === "number" ? payload.duration : null;
                  const detail =
                    activeActivity && typeof activeActivity.detail === "string"
                      ? activeActivity.detail.trim()
                      : "";
                  const meta = [];
                  if (duration !== null) meta.push(duration + "ms");
                  if (detail) meta.push(detail);
                  const toolText =
                    "- done \\x60" + toolName + "\\x60" + (meta.length > 0 ? " (" + meta.join(", ") + ")" : "");
                  assistantMessage._currentTools.push(toolText);
                  if (!assistantMessage.metadata) assistantMessage.metadata = {};
                  if (!assistantMessage.metadata.toolActivity) assistantMessage.metadata.toolActivity = [];
                  assistantMessage.metadata.toolActivity.push(toolText);
                  renderIfActiveConversation(true);
                }
                if (eventName === "tool:error") {
                  const toolName = payload.tool || "tool";
                  const activeActivity = removeActiveActivityForTool(
                    assistantMessage,
                    toolName,
                  );
                  const errorMsg = payload.error || "unknown error";
                  const detail =
                    activeActivity && typeof activeActivity.detail === "string"
                      ? activeActivity.detail.trim()
                      : "";
                  const toolText =
                    "- error \\x60" +
                    toolName +
                    "\\x60" +
                    (detail ? " (" + detail + ")" : "") +
                    ": " +
                    errorMsg;
                  assistantMessage._currentTools.push(toolText);
                  if (!assistantMessage.metadata) assistantMessage.metadata = {};
                  if (!assistantMessage.metadata.toolActivity) assistantMessage.metadata.toolActivity = [];
                  assistantMessage.metadata.toolActivity.push(toolText);
                  renderIfActiveConversation(true);
                }
                if (eventName === "tool:approval:required") {
                  const toolName = payload.tool || "tool";
                  const activeActivity = removeActiveActivityForTool(
                    assistantMessage,
                    toolName,
                  );
                  const detailFromPayload = describeToolStart(payload);
                  const detail =
                    (activeActivity && typeof activeActivity.detail === "string"
                      ? activeActivity.detail.trim()
                      : "") ||
                    (detailFromPayload && typeof detailFromPayload.detail === "string"
                      ? detailFromPayload.detail.trim()
                      : "");
                  const toolText =
                    "- approval required \\x60" +
                    toolName +
                    "\\x60" +
                    (detail ? " (" + detail + ")" : "");
                  assistantMessage._currentTools.push(toolText);
                  if (!assistantMessage.metadata) assistantMessage.metadata = {};
                  if (!assistantMessage.metadata.toolActivity) assistantMessage.metadata.toolActivity = [];
                  assistantMessage.metadata.toolActivity.push(toolText);
                  const approvalId =
                    typeof payload.approvalId === "string" ? payload.approvalId : "";
                  if (approvalId) {
                    const preview = safeJsonPreview(payload.input ?? {});
                    const inputPreview = preview.length > 600 ? preview.slice(0, 600) + "..." : preview;
                    if (!Array.isArray(assistantMessage._pendingApprovals)) {
                      assistantMessage._pendingApprovals = [];
                    }
                    const exists = assistantMessage._pendingApprovals.some(
                      (req) => req.approvalId === approvalId,
                    );
                    if (!exists) {
                      assistantMessage._pendingApprovals.push({
                        approvalId,
                        tool: toolName,
                        inputPreview,
                        state: "pending",
                      });
                    }
                  }
                  renderIfActiveConversation(true);
                }
                if (eventName === "tool:approval:granted") {
                  const toolText = "- approval granted";
                  assistantMessage._currentTools.push(toolText);
                  if (!assistantMessage.metadata) assistantMessage.metadata = {};
                  if (!assistantMessage.metadata.toolActivity) assistantMessage.metadata.toolActivity = [];
                  assistantMessage.metadata.toolActivity.push(toolText);
                  const approvalId =
                    typeof payload.approvalId === "string" ? payload.approvalId : "";
                  if (approvalId && Array.isArray(assistantMessage._pendingApprovals)) {
                    assistantMessage._pendingApprovals = assistantMessage._pendingApprovals.filter(
                      (req) => req.approvalId !== approvalId,
                    );
                  }
                  renderIfActiveConversation(true);
                }
                if (eventName === "tool:approval:denied") {
                  const toolText = "- approval denied";
                  assistantMessage._currentTools.push(toolText);
                  if (!assistantMessage.metadata) assistantMessage.metadata = {};
                  if (!assistantMessage.metadata.toolActivity) assistantMessage.metadata.toolActivity = [];
                  assistantMessage.metadata.toolActivity.push(toolText);
                  const approvalId =
                    typeof payload.approvalId === "string" ? payload.approvalId : "";
                  if (approvalId && Array.isArray(assistantMessage._pendingApprovals)) {
                    assistantMessage._pendingApprovals = assistantMessage._pendingApprovals.filter(
                      (req) => req.approvalId !== approvalId,
                    );
                  }
                  renderIfActiveConversation(true);
                }
                if (eventName === "run:completed") {
                  assistantMessage._activeActivities = [];
                  if (!assistantMessage.content || assistantMessage.content.length === 0) {
                    assistantMessage.content = String(payload.result?.response || "");
                  }
                  // Finalize sections: push any remaining tools and text
                  if (assistantMessage._currentTools.length > 0) {
                    assistantMessage._sections.push({ type: "tools", content: assistantMessage._currentTools });
                    assistantMessage._currentTools = [];
                  }
                  if (assistantMessage._currentText.length > 0) {
                    assistantMessage._sections.push({ type: "text", content: assistantMessage._currentText });
                    assistantMessage._currentText = "";
                  }
                  renderIfActiveConversation(false);
                }
                if (eventName === "run:error") {
                  assistantMessage._activeActivities = [];
                  const errMsg = payload.error?.message || "Something went wrong";
                  assistantMessage.content = "";
                  assistantMessage._error = errMsg;
                  renderIfActiveConversation(false);
                }
              } catch (error) {
                console.error("SSE event handling error:", eventName, error);
              }
            });
          }
          // Update active state only if user is still on this conversation.
          if (state.activeConversationId === streamConversationId) {
            state.activeMessages = localMessages;
          }
          await loadConversations();
          // Don't reload the conversation - we already have the latest state with tool chips
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
              state.activeMessages = [];
              replaceConversationUrl(null);
              renderMessages([]);
              renderConversationList();
            }
          }
        } catch (error) {
          elements.loginError.textContent = error.message || "Login failed";
        }
      });

      const startNewChat = () => {
        state.activeConversationId = null;
        state.activeMessages = [];
        state.confirmDeleteId = null;
        pushConversationUrl(null);
        elements.chatTitle.textContent = "";
        renderMessages([]);
        renderConversationList();
        elements.prompt.focus();
        if (isMobile()) {
          setSidebarOpen(false);
        }
      };

      elements.newChat.addEventListener("click", startNewChat);
      elements.topbarNewChat.addEventListener("click", startNewChat);

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
        state.activeMessages = [];
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

      elements.messages.addEventListener("click", async (event) => {
        const target = event.target;
        if (!(target instanceof Element)) {
          return;
        }
        const button = target.closest(".approval-action-btn");
        if (!button) {
          return;
        }
        const approvalId = button.getAttribute("data-approval-id") || "";
        const decision = button.getAttribute("data-approval-decision") || "";
        if (!approvalId || (decision !== "approve" && decision !== "deny")) {
          return;
        }
        if (state.approvalRequestsInFlight[approvalId]) {
          return;
        }
        state.approvalRequestsInFlight[approvalId] = true;
        const wasStreaming = state.isStreaming;
        if (!wasStreaming) {
          setStreaming(true);
        }
        updatePendingApproval(approvalId, (request) => ({
          ...request,
          state: "submitting",
          pendingDecision: decision,
        }));
        renderMessages(state.activeMessages, state.isStreaming);
        try {
          await api("/api/approvals/" + encodeURIComponent(approvalId), {
            method: "POST",
            body: JSON.stringify({ approved: decision === "approve" }),
          });
          updatePendingApproval(approvalId, () => null);
          renderMessages(state.activeMessages, state.isStreaming);
          if (!wasStreaming && state.activeConversationId) {
            await streamConversationEvents(state.activeConversationId);
          }
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          updatePendingApproval(approvalId, (request) => ({
            ...request,
            state: "pending",
            pendingDecision: null,
            inputPreview: String(request.inputPreview || "") + " (submit failed: " + errMsg + ")",
          }));
          renderMessages(state.activeMessages, state.isStreaming);
        } finally {
          if (!wasStreaming) {
            setStreaming(false);
            renderMessages(state.activeMessages, false);
          }
          delete state.approvalRequestsInFlight[approvalId];
        }
      });

      elements.messages.addEventListener("scroll", () => {
        state.isMessagesPinnedToBottom = isNearBottom(elements.messages);
      }, { passive: true });

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
            state.activeMessages = [];
            replaceConversationUrl(null);
            elements.chatTitle.textContent = "";
            renderMessages([]);
            renderConversationList();
          }
        } else {
          state.activeConversationId = null;
          state.activeMessages = [];
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
            state.activeMessages = [];
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

      // Detect iOS standalone mode and add class for CSS targeting
      if (window.navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches) {
        document.documentElement.classList.add("standalone");
      }

      // iOS viewport and keyboard handling
      (function() {
        var shell = document.querySelector(".shell");
        var pinScroll = function() { if (window.scrollY !== 0) window.scrollTo(0, 0); };
        
        // Track the "full" height when keyboard is not open
        var fullHeight = window.innerHeight;
        
        // Resize shell when iOS keyboard opens/closes
        var resizeForKeyboard = function() {
          if (!shell || !window.visualViewport) return;
          var vvHeight = window.visualViewport.height;
          
          // Update fullHeight if viewport grew (keyboard closed)
          if (vvHeight > fullHeight) {
            fullHeight = vvHeight;
          }
          
          // Only apply height override if keyboard appears to be open
          // (viewport significantly smaller than full height)
          if (vvHeight < fullHeight - 100) {
            shell.style.height = vvHeight + "px";
          } else {
            // Keyboard closed - remove override, let CSS handle it
            shell.style.height = "";
          }
          pinScroll();
        };
        
        if (window.visualViewport) {
          window.visualViewport.addEventListener("scroll", pinScroll);
          window.visualViewport.addEventListener("resize", resizeForKeyboard);
        }
        document.addEventListener("scroll", pinScroll);

        // Draggable sidebar from left edge (mobile only)
        (function() {
          var sidebar = document.querySelector(".sidebar");
          var backdrop = document.querySelector(".sidebar-backdrop");
          var shell = document.querySelector(".shell");
          if (!sidebar || !backdrop || !shell) return;
          
          var sidebarWidth = 260;
          var edgeThreshold = 50; // px from left edge to start drag
          var velocityThreshold = 0.3; // px/ms to trigger open/close
          
          var dragging = false;
          var startX = 0;
          var startY = 0;
          var currentX = 0;
          var startTime = 0;
          var isOpen = false;
          var directionLocked = false;
          var isHorizontal = false;
          
          function getProgress() {
            // Returns 0 (closed) to 1 (open)
            if (isOpen) {
              return Math.max(0, Math.min(1, 1 + currentX / sidebarWidth));
            } else {
              return Math.max(0, Math.min(1, currentX / sidebarWidth));
            }
          }
          
          function updatePosition(progress) {
            var offset = (progress - 1) * sidebarWidth;
            sidebar.style.transform = "translateX(" + offset + "px)";
            backdrop.style.opacity = progress;
            if (progress > 0) {
              backdrop.style.pointerEvents = "auto";
            } else {
              backdrop.style.pointerEvents = "none";
            }
          }
          
          function onTouchStart(e) {
            if (window.innerWidth > 768) return;
            
            // Don't intercept touches on interactive elements
            var target = e.target;
            if (target.closest("button") || target.closest("a") || target.closest("input") || target.closest("textarea")) {
              return;
            }
            
            var touch = e.touches[0];
            isOpen = shell.classList.contains("sidebar-open");
            
            // When sidebar is closed: only respond to edge swipes
            // When sidebar is open: only respond to backdrop touches (not sidebar content)
            var fromEdge = touch.clientX < edgeThreshold;
            var onBackdrop = e.target === backdrop;
            
            if (!isOpen && !fromEdge) return;
            if (isOpen && !onBackdrop) return;
            
            // Prevent Safari back gesture when starting from edge
            if (fromEdge) {
              e.preventDefault();
            }
            
            startX = touch.clientX;
            startY = touch.clientY;
            currentX = 0;
            startTime = Date.now();
            directionLocked = false;
            isHorizontal = false;
            dragging = true;
            sidebar.classList.add("dragging");
            backdrop.classList.add("dragging");
          }
          
          function onTouchMove(e) {
            if (!dragging) return;
            var touch = e.touches[0];
            var dx = touch.clientX - startX;
            var dy = touch.clientY - startY;
            
            // Lock direction after some movement
            if (!directionLocked && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
              directionLocked = true;
              isHorizontal = Math.abs(dx) > Math.abs(dy);
              if (!isHorizontal) {
                // Vertical scroll, cancel drag
                dragging = false;
                sidebar.classList.remove("dragging");
                backdrop.classList.remove("dragging");
                return;
              }
            }
            
            if (!directionLocked) return;
            
            // Prevent scrolling while dragging sidebar
            e.preventDefault();
            
            currentX = dx;
            updatePosition(getProgress());
          }
          
          function onTouchEnd(e) {
            if (!dragging) return;
            dragging = false;
            sidebar.classList.remove("dragging");
            backdrop.classList.remove("dragging");
            
            var touch = e.changedTouches[0];
            var dx = touch.clientX - startX;
            var dt = Date.now() - startTime;
            var velocity = dx / dt; // px/ms
            
            var progress = getProgress();
            var shouldOpen;
            
            // Use velocity if fast enough, otherwise use position threshold
            if (Math.abs(velocity) > velocityThreshold) {
              shouldOpen = velocity > 0;
            } else {
              shouldOpen = progress > 0.5;
            }
            
            // Reset inline styles and let CSS handle the animation
            sidebar.style.transform = "";
            backdrop.style.opacity = "";
            backdrop.style.pointerEvents = "";
            
            if (shouldOpen) {
              shell.classList.add("sidebar-open");
            } else {
              shell.classList.remove("sidebar-open");
            }
          }
          
          document.addEventListener("touchstart", onTouchStart, { passive: false });
          document.addEventListener("touchmove", onTouchMove, { passive: false });
          document.addEventListener("touchend", onTouchEnd, { passive: true });
          document.addEventListener("touchcancel", onTouchEnd, { passive: true });
        })();

        // Prevent Safari back/forward navigation by manipulating history
        // This doesn't stop the gesture animation but prevents actual navigation
        if (window.navigator.standalone || window.matchMedia("(display-mode: standalone)").matches) {
          history.pushState(null, "", location.href);
          window.addEventListener("popstate", function() {
            history.pushState(null, "", location.href);
          });
        }
        
        // Right edge blocker - intercept touch events to prevent forward navigation
        var rightBlocker = document.querySelector(".edge-blocker-right");
        if (rightBlocker) {
          rightBlocker.addEventListener("touchstart", function(e) {
            e.preventDefault();
          }, { passive: false });
          rightBlocker.addEventListener("touchmove", function(e) {
            e.preventDefault();
          }, { passive: false });
        }
      })();

    </script>
  </body>
</html>`;
};
