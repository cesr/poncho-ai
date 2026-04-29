import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

import { WEB_UI_STYLES } from "./web-ui-styles.js";
import { getWebUiClientScript } from "./web-ui-client.js";

export {
  FileConversationStore,
  LoginRateLimiter,
  SessionStore,
  getRequestIp,
  inferConversationTitle,
  parseCookies,
  setCookie,
  verifyPassphrase,
} from "./web-ui-store.js";

export type { WebUiConversation } from "./web-ui-store.js";

const require = createRequire(import.meta.url);
const markedPackagePath = require.resolve("marked");
const markedDir = dirname(markedPackagePath);
const markedSource = readFileSync(join(markedDir, "marked.umd.js"), "utf-8");

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

export const renderWebUiHtml = (options?: { agentName?: string; isDev?: boolean }): string => {
  const agentInitial = (options?.agentName ?? "A").charAt(0).toUpperCase();
  const agentName = options?.agentName ?? "Agent";
  const pageTitle = options?.isDev ? `[dev] ${agentName}` : agentName;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
  <meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">
  <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="${agentName}">
  <link rel="manifest" href="/manifest.json">
  <link rel="icon" href="/icon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/icon-192.png">
  <title>${pageTitle}</title>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css?family=Inconsolata:400,700">
  <style>
${WEB_UI_STYLES}
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
      <div class="sidebar-header">
        <span class="sidebar-agent-name">${agentName}</span>
        <button id="new-chat" class="new-chat-btn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
        </button>
      </div>
      <div id="conversation-list" class="conversation-list"></div>
      <div class="sidebar-footer">
        <div class="sidebar-footer-row">
          <button id="logout" class="logout-btn">Log out</button>
          <button id="settings-btn" class="settings-btn hidden" aria-label="Settings">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          </button>
        </div>
      </div>
    </aside>
    <div id="sidebar-backdrop" class="sidebar-backdrop"></div>
    <main class="main">
      <div class="topbar">
        <button id="sidebar-toggle" class="sidebar-toggle">&#9776;</button>
        <div id="chat-title" class="topbar-title"></div>
        <button id="view-toggle" class="topbar-view-toggle" hidden title="Toggle between user-facing messages and raw harness messages (dev -v only)">user</button>
        <button id="topbar-new-chat" class="topbar-new-chat">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
        </button>
        <a class="poncho-badge" href="https://github.com/cesr/poncho-ai" target="_blank" rel="noopener noreferrer"><img class="poncho-badge-avatar" src="data:image/jpeg;base64,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" alt="" aria-hidden="true">Built with Poncho</a>
      </div>
      <div class="main-body">
        <div class="main-chat">
          <div id="messages" class="messages">
            <div class="empty-state">
              <div class="assistant-avatar">${agentInitial}</div>
              <div class="empty-state-text">How can I help you today?</div>
            </div>
          </div>
          <form id="composer" class="composer">
            <div class="composer-inner">
              <div id="todo-panel" class="hidden"></div>
              <div id="attachment-preview" class="attachment-preview" style="display:none"></div>
              <div class="composer-shell">
                <button id="attach-btn" class="attach-btn" type="button" title="Attach files">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
                </button>
                <input id="file-input" type="file" multiple accept="image/*,video/*,application/pdf,.txt,.csv,.json,.html" style="display:none" />
                <textarea id="prompt" class="composer-input" placeholder="Send a message..." rows="1"></textarea>
                <div class="send-btn-wrapper" id="send-btn-wrapper">
                  <svg class="context-ring" viewBox="0 0 36 36">
                    <circle class="context-ring-fill" id="context-ring-fill" cx="18" cy="18" r="14.5" />
                  </svg>
                  <button id="send" class="send-btn" type="submit">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 12V4M4 7l4-4 4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                  </button>
                  <div class="context-tooltip" id="context-tooltip"></div>
                </div>
              </div>
            </div>
          </form>
        </div>
        <div id="browser-panel-resize" class="browser-panel-resize" style="display:none"></div>
        <aside id="browser-panel" class="browser-panel" style="display:none">
          <div class="browser-panel-header">
            <button id="browser-nav-back" class="browser-nav-btn" title="Go back" disabled>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
            <button id="browser-nav-forward" class="browser-nav-btn" title="Go forward" disabled>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M6 3l5 5-5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
            <span id="browser-panel-url" class="browser-panel-url"></span>
            <button id="browser-panel-close" class="browser-panel-close" title="Hide panel">&times;</button>
          </div>
          <div class="browser-panel-viewport">
            <img id="browser-panel-frame" alt="Browser viewport" />
            <div id="browser-panel-placeholder" class="browser-panel-placeholder">No active browser session</div>
          </div>
        </aside>
        <div id="thread-panel-resize" class="thread-panel-resize" style="display:none"></div>
        <aside id="thread-panel" class="thread-panel" style="display:none">
          <div class="thread-panel-header">
            <span class="thread-panel-title">Thread</span>
            <button id="thread-panel-close" class="thread-panel-close" title="Close thread">&times;</button>
          </div>
          <div id="thread-panel-messages" class="thread-panel-messages messages"></div>
          <form id="thread-composer" class="composer thread-composer">
            <div class="composer-inner">
              <div id="thread-attachment-preview" class="attachment-preview" style="display:none"></div>
              <div class="composer-shell">
                <button id="thread-attach-btn" class="attach-btn" type="button" title="Attach files">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
                </button>
                <input id="thread-file-input" type="file" multiple accept="image/*,video/*,application/pdf,.txt,.csv,.json,.html" style="display:none" />
                <textarea id="thread-prompt" class="composer-input" placeholder="Reply in thread..." rows="1"></textarea>
                <button id="thread-send" class="send-btn" type="submit">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 12V4M4 7l4-4 4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </button>
              </div>
            </div>
          </form>
        </aside>
      </div>
    </main>
  </div>
  <div id="drag-overlay" class="drag-overlay"><div class="drag-overlay-inner">Drop files to attach</div></div>
  <div id="lightbox" class="lightbox" style="display:none"><img /></div>

    <script>
${getWebUiClientScript(markedSource)}
    </script>
  </body>
</html>`;
};
