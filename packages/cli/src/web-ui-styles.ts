export const WEB_UI_STYLES = `
    :root {
      color-scheme: light dark;

      --bg: #000;
      --bg-alt: #0a0a0a;
      --bg-elevated: #111;

      --fg: #ededed;
      --fg-strong: #fff;
      --fg-2: #888;
      --fg-3: #999;
      --fg-4: #777;
      --fg-5: #666;
      --fg-6: #555;
      --fg-7: #444;
      --fg-8: #333;

      --fg-tool: #8a8a8a;
      --fg-tool-code: #bcbcbc;
      --fg-tool-item: #d6d6d6;
      --fg-approval-label: #b0b0b0;
      --fg-approval-input: #cfcfcf;
      --fg-approval-btn: #f0f0f0;

      --accent: #ededed;
      --accent-fg: #000;
      --accent-hover: #fff;

      --stop-bg: #4a4a4a;
      --stop-fg: #fff;
      --stop-hover: #565656;

      --border-1: rgba(255,255,255,0.06);
      --border-2: rgba(255,255,255,0.08);
      --border-3: rgba(255,255,255,0.1);
      --border-4: rgba(255,255,255,0.12);
      --border-5: rgba(255,255,255,0.18);
      --border-focus: rgba(255,255,255,0.2);
      --border-hover: rgba(255,255,255,0.25);
      --border-drag: rgba(255,255,255,0.4);

      --surface-1: rgba(255,255,255,0.02);
      --surface-2: rgba(255,255,255,0.03);
      --surface-3: rgba(255,255,255,0.04);
      --surface-4: rgba(255,255,255,0.06);
      --surface-5: rgba(255,255,255,0.08);
      --surface-6: rgba(255,255,255,0.1);
      --surface-7: rgba(255,255,255,0.12);
      --surface-8: rgba(255,255,255,0.14);

      --chip-bg: rgba(0,0,0,0.6);
      --chip-bg-hover: rgba(0,0,0,0.75);
      --backdrop: rgba(0,0,0,0.6);
      --lightbox-bg: rgba(0,0,0,0.85);
      --inset-1: rgba(0,0,0,0.16);
      --inset-2: rgba(0,0,0,0.25);

      --file-badge-bg: rgba(0,0,0,0.2);
      --file-badge-fg: rgba(255,255,255,0.8);

      --error: #ff4444;
      --error-soft: #ff6b6b;
      --error-alt: #ff6666;
      --error-bg: rgba(255,68,68,0.08);
      --error-border: rgba(255,68,68,0.25);

      --tool-done: #6a9955;
      --tool-error: #f48771;

      --warning: #e8a735;

      --approve: #78e7a6;
      --approve-border: rgba(58,208,122,0.45);
      --deny: #f59b9b;
      --deny-border: rgba(224,95,95,0.45);

      --scrollbar: rgba(255,255,255,0.1);
      --scrollbar-hover: rgba(255,255,255,0.16);
    }

    @media (prefers-color-scheme: light) {
      :root {
        --bg: #ffffff;
        --bg-alt: #f5f5f5;
        --bg-elevated: #e8e8e8;

        --fg: #1a1a1a;
        --fg-strong: #000;
        --fg-2: #666;
        --fg-3: #555;
        --fg-4: #777;
        --fg-5: #888;
        --fg-6: #888;
        --fg-7: #aaa;
        --fg-8: #bbb;

        --fg-tool: #666;
        --fg-tool-code: #444;
        --fg-tool-item: #333;
        --fg-approval-label: #666;
        --fg-approval-input: #444;
        --fg-approval-btn: #1a1a1a;

        --accent: #1a1a1a;
        --accent-fg: #fff;
        --accent-hover: #000;

        --stop-bg: #d4d4d4;
        --stop-fg: #333;
        --stop-hover: #c4c4c4;

        --border-1: rgba(0,0,0,0.06);
        --border-2: rgba(0,0,0,0.08);
        --border-3: rgba(0,0,0,0.1);
        --border-4: rgba(0,0,0,0.1);
        --border-5: rgba(0,0,0,0.15);
        --border-focus: rgba(0,0,0,0.2);
        --border-hover: rgba(0,0,0,0.2);
        --border-drag: rgba(0,0,0,0.3);

        --surface-1: rgba(0,0,0,0.02);
        --surface-2: rgba(0,0,0,0.03);
        --surface-3: rgba(0,0,0,0.03);
        --surface-4: rgba(0,0,0,0.04);
        --surface-5: rgba(0,0,0,0.05);
        --surface-6: rgba(0,0,0,0.07);
        --surface-7: rgba(0,0,0,0.08);
        --surface-8: rgba(0,0,0,0.1);

        --chip-bg: rgba(255,255,255,0.8);
        --chip-bg-hover: rgba(255,255,255,0.9);
        --backdrop: rgba(0,0,0,0.3);
        --lightbox-bg: rgba(0,0,0,0.75);
        --inset-1: rgba(0,0,0,0.04);
        --inset-2: rgba(0,0,0,0.06);

        --file-badge-bg: rgba(0,0,0,0.05);
        --file-badge-fg: rgba(0,0,0,0.7);

        --error: #dc2626;
        --error-soft: #ef4444;
        --error-alt: #ef4444;
        --error-bg: rgba(220,38,38,0.06);
        --error-border: rgba(220,38,38,0.2);

        --tool-done: #16a34a;
        --tool-error: #dc2626;

        --warning: #ca8a04;

        --approve: #16a34a;
        --approve-border: rgba(22,163,74,0.35);
        --deny: #dc2626;
        --deny-border: rgba(220,38,38,0.3);

        --scrollbar: rgba(0,0,0,0.12);
        --scrollbar-hover: rgba(0,0,0,0.2);
      }
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100vh; overflow: hidden; overscroll-behavior: none; touch-action: pan-y; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", "Helvetica Neue", sans-serif;
      background: var(--bg);
      color: var(--fg);
      font-size: 14px;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }
    button, input, textarea { font: inherit; color: inherit; }
    .hidden { display: none !important; }
    a { color: var(--fg); }

    /* Auth */
    .auth {
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 20px;
      background: var(--bg);
    }
    .auth-card {
      width: min(400px, 90vw);
    }
    .auth-shell {
      background: var(--bg-alt);
      border: 1px solid var(--border-3);
      border-radius: 9999px;
      display: flex;
      align-items: center;
      padding: 4px 6px 4px 18px;
      transition: border-color 0.15s;
    }
    .auth-shell:focus-within { border-color: var(--border-focus); }
    .auth-input {
      flex: 1;
      background: transparent;
      border: 0;
      outline: none;
      color: var(--fg);
      padding: 10px 0 8px;
      font-size: 14px;
      margin-top: -2px;
    }
    .auth-input::placeholder { color: var(--fg-7); }
    .auth-submit {
      width: 32px;
      height: 32px;
      background: var(--accent);
      border: 0;
      border-radius: 50%;
      color: var(--accent-fg);
      cursor: pointer;
      display: grid;
      place-items: center;
      flex-shrink: 0;
      margin-bottom: 2px;
      transition: background 0.15s;
    }
    .auth-submit:hover { background: var(--accent-hover); }
    .error { color: var(--error); font-size: 13px; min-height: 16px; }
    .message-error {
      background: var(--error-bg);
      border: 1px solid var(--error-border);
      border-radius: 10px;
      color: var(--error-soft);
      padding: 12px 16px;
      font-size: 13px;
      line-height: 1.5;
      max-width: 600px;
    }
    .message-error strong { color: var(--error); }

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
      background: var(--bg);
      border-right: 1px solid var(--border-1);
      display: flex;
      flex-direction: column;
      padding: 12px 8px;
    }
    .sidebar-header {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .sidebar-agent-name {
      font-size: 14px;
      font-weight: 500;
      color: var(--fg-strong);
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      padding-left: 10px;
    }
    .new-chat-btn {
      background: transparent;
      border: 0;
      color: var(--fg-2);
      border-radius: 12px;
      height: 36px;
      padding: 0 10px;
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      cursor: pointer;
      flex-shrink: 0;
      transition: background 0.15s, color 0.15s;
    }
    .new-chat-btn:hover { color: var(--fg); }
    .new-chat-btn svg { width: 16px; height: 16px; }
    .conversation-list {
      flex: 1;
      overflow-y: auto;
      margin-top: 12px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .sidebar-section-label {
      font-size: 11px;
      font-weight: 600;
      color: var(--fg-7);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      padding: 10px 10px 4px;
    }
    .sidebar-section-label:first-child { padding-top: 4px; }
    .sidebar-section-divider {
      height: 1px;
      background: var(--border);
      margin: 6px 10px;
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
      color: var(--fg-6);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      position: relative;
      transition: color 0.15s;
    }
    .conversation-item .approval-dot {
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--warning, #e8a735);
      margin-right: 6px;
      flex-shrink: 0;
      vertical-align: middle;
    }
    .conversation-item:hover { color: var(--fg-3); }
    .conversation-item.active {
      color: var(--fg);
    }
    .conversation-item .delete-btn {
      position: absolute;
      right: 0;
      top: 0;
      bottom: 0;
      opacity: 0;
      background: var(--bg);
      border: 0;
      color: var(--fg-7);
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
    .conversation-item.active .delete-btn { background: var(--bg); }
    .conversation-item .delete-btn::before {
      content: "";
      position: absolute;
      right: 100%;
      top: 0;
      bottom: 0;
      width: 24px;
      background: linear-gradient(to right, transparent, var(--bg));
      pointer-events: none;
    }
    .conversation-item.active .delete-btn::before {
      background: linear-gradient(to right, transparent, var(--bg));
    }
    .conversation-item .delete-btn:hover { color: var(--fg-2); }
    .conversation-item .delete-btn.confirming {
      opacity: 1;
      width: auto;
      padding: 0 8px;
      font-size: 11px;
      color: var(--error);
      border-radius: 3px;
    }
    .conversation-item .delete-btn.confirming:hover {
      color: var(--error-alt);
    }
    .sidebar-footer {
      margin-top: auto;
      padding-top: 8px;
    }
    .logout-btn {
      background: transparent;
      border: 0;
      color: var(--fg-6);
      width: 100%;
      padding: 8px 10px;
      text-align: left;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      transition: color 0.15s, background 0.15s;
    }
    .logout-btn:hover { color: var(--fg-2); }

    /* Main */
    .main { flex: 1; display: flex; flex-direction: column; min-width: 0; max-width: 100%; background: var(--bg); overflow: hidden; }
    .main-body { flex: 1; display: flex; min-height: 0; overflow: hidden; }
    .main-chat { flex: 1; display: flex; flex-direction: column; min-width: 0; overflow: hidden; }
    .topbar {
      height: calc(52px + env(safe-area-inset-top, 0px));
      padding-top: env(safe-area-inset-top, 0px);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      font-weight: 500;
      color: var(--fg-2);
      border-bottom: 1px solid var(--border-1);
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
      cursor: default;
    }
    .topbar-title-input {
      font: inherit;
      font-weight: inherit;
      letter-spacing: inherit;
      color: inherit;
      background: var(--bg-2);
      border: none;
      border-radius: 4px;
      padding: 2px 6px;
      margin: -3px 0;
      max-width: 100%;
      outline: none;
      box-sizing: border-box;
      text-align: center;
    }
    .sidebar-toggle {
      display: none;
      position: absolute;
      left: 12px;
      bottom: 4px; /* Position from bottom of topbar content area */
      background: transparent;
      border: 0;
      color: var(--fg-5);
      width: 44px;
      height: 44px;
      border-radius: 6px;
      cursor: pointer;
      transition: color 0.15s, background 0.15s;
      font-size: 18px;
      z-index: 10;
      -webkit-tap-highlight-color: transparent;
    }
    .sidebar-toggle:hover { color: var(--fg); }
    .topbar-new-chat {
      display: none;
      position: absolute;
      right: 12px;
      bottom: 4px;
      background: transparent;
      border: 0;
      color: var(--fg-5);
      width: 44px;
      height: 44px;
      border-radius: 6px;
      cursor: pointer;
      transition: color 0.15s, background 0.15s;
      z-index: 10;
      -webkit-tap-highlight-color: transparent;
    }
    .topbar-new-chat:hover { color: var(--fg); }
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
      background: var(--accent);
      color: var(--accent-fg);
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
      color: var(--fg);
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
    .assistant-content strong { font-weight: 600; color: var(--fg-strong); }
    .assistant-content h2 {
      font-size: 16px;
      font-weight: 600;
      letter-spacing: -0.02em;
      margin: 20px 0 8px;
      color: var(--fg-strong);
    }
    .assistant-content h3 {
      font-size: 14px;
      font-weight: 600;
      letter-spacing: -0.01em;
      margin: 16px 0 6px;
      color: var(--fg-strong);
    }
    .assistant-content code {
      background: var(--surface-4);
      border: 1px solid var(--border-1);
      padding: 2px 5px;
      border-radius: 4px;
      font-family: ui-monospace, "SF Mono", "Fira Code", monospace;
      font-size: 0.88em;
    }
    .assistant-content pre {
      background: var(--bg-alt);
      border: 1px solid var(--border-1);
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
      color: var(--fg-tool);
    }
    .tool-activity-inline code {
      font-family: ui-monospace, "SF Mono", "Fira Code", monospace;
      background: var(--surface-3);
      border: 1px solid var(--border-2);
      padding: 4px 8px;
      border-radius: 6px;
      color: var(--fg-tool-code);
      font-size: 11px;
    }
    .tool-status {
      color: var(--fg-tool);
      font-style: italic;
    }
    .tool-done {
      color: var(--tool-done);
    }
    .tool-error {
      color: var(--tool-error);
    }
    .assistant-content table:not(.approval-request-table) {
      border-collapse: collapse;
      width: 100%;
      margin: 14px 0;
      font-size: 13px;
      border: 1px solid var(--border-2);
      border-radius: 8px;
      overflow: hidden;
      display: block;
      max-width: 100%;
      overflow-x: auto;
      white-space: nowrap;
    }
    .assistant-content table:not(.approval-request-table) th {
      background: var(--surface-4);
      padding: 10px 12px;
      text-align: left;
      font-weight: 600;
      border-bottom: 1px solid var(--border-4);
      color: var(--fg-strong);
      min-width: 100px;
    }
    .assistant-content table:not(.approval-request-table) td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--border-1);
      width: 100%;
      min-width: 100px;
    }
    .assistant-content table:not(.approval-request-table) tr:last-child td {
      border-bottom: none;
    }
    .assistant-content table:not(.approval-request-table) tbody tr:hover {
      background: var(--surface-1);
    }
    .assistant-content hr {
      border: 0;
      border-top: 1px solid var(--border-3);
      margin: 20px 0;
    }
    .tool-activity {
      margin-top: 12px;
      margin-bottom: 12px;
      border: 1px solid var(--border-2);
      background: var(--surface-2);
      border-radius: 10px;
      font-size: 12px;
      line-height: 1.45;
      color: var(--fg-tool-code);
      width: 300px;
      transition: width 0.2s ease;
    }
    .tool-activity.has-approvals {
      width: 100%;
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
      color: var(--fg-tool);
      font-weight: 600;
    }
    .tool-activity-caret {
      margin-left: auto;
      color: var(--fg-tool);
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
      background: var(--surface-3);
      border-radius: 6px;
      padding: 4px 7px;
      color: var(--fg-tool-item);
    }
    .tool-images {
      padding: 10px 12px 4px;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .tool-screenshot {
      max-width: 100%;
      border-radius: 6px;
      border: 1px solid var(--border-2);
      cursor: pointer;
    }
    .approval-requests {
      border-top: 1px solid var(--border-2);
      padding: 10px 12px 12px;
      display: grid;
      gap: 10px;
    }
    .approval-requests-label {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--fg-approval-label);
      font-weight: 600;
    }
    .approval-requests-label code {
      font-family: ui-monospace, "SF Mono", "Fira Code", monospace;
      text-transform: none;
      letter-spacing: 0;
      color: var(--fg-strong);
    }
    .approval-request-item {
      display: grid;
      gap: 8px;
    }
    .approval-request-table {
      width: 100%;
      border-collapse: collapse;
      border: none;
      font-size: 14px;
      line-height: 1.5;
    }
    .approval-request-table tr,
    .approval-request-table td {
      border: none;
      background: none;
    }
    .approval-request-table td {
      padding: 4px 0;
      vertical-align: top;
    }
    .approval-request-table .ak {
      font-weight: 600;
      color: var(--fg-approval-label);
      white-space: nowrap;
      width: 1%;
      padding-right: 20px;
    }
    .approval-request-table .av,
    .approval-request-table .av-complex {
      color: var(--fg);
      overflow-wrap: anywhere;
      white-space: pre-wrap;
      max-height: 200px;
      overflow-y: auto;
      display: block;
    }
    .approval-request-table .av-complex {
      font-family: ui-monospace, "SF Mono", "Fira Code", monospace;
      font-size: 12px;
    }
    .approval-request-actions {
      display: flex;
      gap: 6px;
    }
    .approval-action-btn {
      border-radius: 6px;
      border: 1px solid var(--border-5);
      background: var(--surface-4);
      color: var(--fg-approval-btn);
      font-size: 11px;
      font-weight: 600;
      padding: 4px 8px;
      cursor: pointer;
    }
    .approval-action-btn:hover {
      background: var(--surface-7);
    }
    .approval-action-btn.approve {
      border-color: var(--approve-border);
      color: var(--approve);
    }
    .approval-action-btn.deny {
      border-color: var(--deny-border);
      color: var(--deny);
    }
    .approval-action-btn[disabled] {
      opacity: 0.55;
      cursor: not-allowed;
    }
    .user-bubble {
      background: var(--bg-elevated);
      border: 1px solid var(--border-2);
      padding: 10px 16px;
      border-radius: 18px;
      max-width: 70%;
      font-size: 14px;
      line-height: 1.5;
      overflow-wrap: break-word;
      word-break: break-word;
      white-space: pre-wrap;
    }
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      gap: 16px;
      color: var(--fg-6);
    }
    .empty-state .assistant-avatar {
      width: 36px;
      height: 36px;
      font-size: 14px;
      border-radius: 8px;
    }
    .empty-state-text {
      font-size: 14px;
      color: var(--fg-6);
    }
    .thinking-indicator {
      display: inline-block;
      font-family: Inconsolata, monospace;
      font-size: 20px;
      line-height: 1;
      vertical-align: middle;
      color: var(--fg);
      opacity: 0.5;
    }
    .thinking-status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin-top: 2px;
      color: var(--fg-tool);
      font-size: 14px;
      line-height: 1.65;
      font-weight: 400;
    }
    .thinking-status-label {
      color: var(--fg-tool);
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
      background: linear-gradient(to top, var(--bg) 0%, transparent 100%);
      pointer-events: none;
    }
    .composer-inner { max-width: 680px; margin: 0 auto; }
    .composer-shell {
      background: var(--bg-alt);
      border: 1px solid var(--border-3);
      border-radius: 24px;
      display: flex;
      align-items: end;
      padding: 4px 6px 4px 6px;
      transition: border-color 0.15s;
    }
    .composer-shell:focus-within { border-color: var(--border-focus); }
    .composer-input {
      flex: 1;
      background: transparent;
      border: 0;
      outline: none;
      color: var(--fg);
      min-height: 40px;
      max-height: 200px;
      resize: none;
      padding: 11px 0 8px;
      font-size: 14px;
      line-height: 1.5;
      margin-top: -4px;
    }
    .composer-input::placeholder { color: var(--fg-7); }
    .send-btn {
      width: 32px;
      height: 32px;
      background: var(--accent);
      border: 0;
      border-radius: 50%;
      color: var(--accent-fg);
      cursor: pointer;
      display: grid;
      place-items: center;
      flex-shrink: 0;
      margin-bottom: 2px;
      transition: background 0.15s, opacity 0.15s;
    }
    .send-btn:hover { background: var(--accent-hover); }
    .send-btn.stop-mode {
      background: var(--stop-bg);
      color: var(--stop-fg);
    }
    .send-btn.stop-mode:hover { background: var(--stop-hover); }
    .send-btn:disabled { opacity: 0.2; cursor: default; }
    .send-btn:disabled:hover { background: var(--accent); }
    .send-btn-wrapper {
      position: relative;
      width: 36px;
      height: 36px;
      display: grid;
      place-items: center;
      flex-shrink: 0;
      margin-bottom: 0;
    }
    .send-btn-wrapper .send-btn {
      margin-bottom: 0;
    }
    .context-ring {
      position: absolute;
      inset: 0;
      width: 36px;
      height: 36px;
      pointer-events: none;
      transform: rotate(-90deg);
    }
    .context-ring-fill {
      fill: none;
      stroke: var(--bg-alt);
      stroke-width: 3;
      stroke-linecap: butt;
      transition: stroke-dashoffset 0.4s ease, stroke 0.3s ease;
    }
    .send-btn-wrapper.stop-mode .context-ring-fill {
      stroke: var(--fg-3);
    }
    .context-ring-fill.warning {
      stroke: #e5a33d;
    }
    .context-ring-fill.critical {
      stroke: #e55d4a;
    }
    .context-tooltip {
      position: absolute;
      bottom: calc(100% + 8px);
      right: 0;
      background: var(--bg-elevated);
      border: 1px solid var(--border-3);
      border-radius: 8px;
      padding: 6px 10px;
      font-size: 12px;
      color: var(--fg-2);
      white-space: nowrap;
      pointer-events: none;
      opacity: 0;
      transform: translateY(4px);
      transition: opacity 0.15s, transform 0.15s;
      z-index: 10;
    }
    .send-btn-wrapper:hover .context-tooltip,
    .send-btn-wrapper:focus-within .context-tooltip {
      opacity: 1;
      transform: translateY(0);
    }
    .attach-btn {
      width: 32px;
      height: 32px;
      background: var(--surface-5);
      border: 0;
      border-radius: 50%;
      color: var(--fg-3);
      cursor: pointer;
      display: grid;
      place-items: center;
      flex-shrink: 0;
      margin-bottom: 2px;
      margin-right: 8px;
      transition: color 0.15s, background 0.15s;
    }
    .attach-btn:hover { color: var(--fg); background: var(--surface-8); }
    .attachment-preview {
      display: flex;
      gap: 8px;
      padding: 8px 0;
      flex-wrap: wrap;
    }
    .attachment-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: var(--chip-bg);
      border: 1px solid var(--border-4);
      border-radius: 9999px;
      padding: 4px 10px 4px 6px;
      font-size: 11px;
      color: var(--fg-4);
      max-width: 200px;
      cursor: pointer;
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      transition: color 0.15s, border-color 0.15s, background 0.15s;
    }
    .attachment-chip:hover {
      color: var(--fg);
      border-color: var(--border-hover);
      background: var(--chip-bg-hover);
    }
    .attachment-chip img {
      width: 20px;
      height: 20px;
      object-fit: cover;
      border-radius: 50%;
      flex-shrink: 0;
      cursor: pointer;
    }
    .attachment-chip .file-icon {
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: var(--surface-6);
      display: grid;
      place-items: center;
      font-size: 11px;
      flex-shrink: 0;
    }
    .attachment-chip .remove-attachment {
      cursor: pointer;
      color: var(--fg-6);
      font-size: 14px;
      margin-left: 2px;
      line-height: 1;
      transition: color 0.15s;
    }
    .attachment-chip .remove-attachment:hover { color: var(--fg-strong); }
    .attachment-chip .filename { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100px; }
    .user-bubble .user-file-attachments {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      margin-top: 8px;
    }
    .user-file-attachments img {
      max-width: 200px;
      max-height: 160px;
      border-radius: 8px;
      object-fit: cover;
      cursor: pointer;
      transition: opacity 0.15s;
    }
    .user-file-attachments img:hover { opacity: 0.85; }
    .lightbox {
      position: fixed;
      inset: 0;
      z-index: 9999;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0,0,0,0);
      backdrop-filter: blur(0px);
      cursor: zoom-out;
      transition: background 0.25s ease, backdrop-filter 0.25s ease;
    }
    .lightbox.active {
      background: var(--lightbox-bg);
      backdrop-filter: blur(8px);
    }
    .lightbox img {
      max-width: 90vw;
      max-height: 90vh;
      border-radius: 8px;
      object-fit: contain;
      transform: scale(0.4);
      opacity: 0;
      transition: transform 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94), opacity 0.25s ease;
    }
    .lightbox.active img {
      transform: scale(1);
      opacity: 1;
    }
    .user-file-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: var(--file-badge-bg);
      border-radius: 6px;
      padding: 4px 8px;
      font-size: 12px;
      color: var(--file-badge-fg);
    }
    .drag-overlay {
      position: fixed;
      inset: 0;
      background: var(--backdrop);
      z-index: 9999;
      display: none;
      align-items: center;
      justify-content: center;
      pointer-events: none;
    }
    .drag-overlay.active { display: flex; }
    .drag-overlay-inner {
      border: 2px dashed var(--border-drag);
      border-radius: 16px;
      padding: 40px 60px;
      color: var(--fg-strong);
      font-size: 16px;
    }
    .disclaimer {
      text-align: center;
      color: var(--fg-8);
      font-size: 12px;
      margin-top: 10px;
    }
    .poncho-badge {
      position: absolute;
      right: 12px;
      top: 50%;
      transform: translateY(-50%);
      margin-top: calc(env(safe-area-inset-top, 0px) / 2);
      z-index: 10;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      color: var(--fg-4);
      text-decoration: none;
      background: var(--chip-bg);
      border: 1px solid var(--border-4);
      border-radius: 9999px;
      padding: 4px 10px 4px 6px;
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      transition: color 0.15s, border-color 0.15s, background 0.15s;
    }
    .poncho-badge:hover {
      color: var(--fg);
      border-color: var(--border-hover);
      background: var(--chip-bg-hover);
    }
    .poncho-badge-avatar {
      width: 16px;
      height: 16px;
      border-radius: 50%;
      object-fit: cover;
      display: block;
      flex-shrink: 0;
    }

    /* Scrollbar */
    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--scrollbar); border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: var(--scrollbar-hover); }

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
      .sidebar-header { padding-right: 130px; }
      .sidebar-agent-name { padding-left: 0; }
      .new-chat-btn { order: -1; }
      .poncho-badge {
        display: none;
        position: fixed;
        top: calc(12px + env(safe-area-inset-top, 0px));
        right: 12px;
        transform: none;
        margin-top: 0;
        z-index: 200;
      }
      .shell.sidebar-open .poncho-badge { display: inline-flex; }
      .sidebar-backdrop {
        position: fixed;
        inset: 0;
        background: var(--backdrop);
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

    /* Browser viewport panel */
    .browser-panel-resize {
      width: 1px;
      cursor: col-resize;
      background: var(--border-1);
      flex-shrink: 0;
      position: relative;
      z-index: 10;
    }
    .browser-panel-resize::after {
      content: "";
      position: absolute;
      inset: 0 -3px;
    }
    .browser-panel-resize:hover,
    .browser-panel-resize.dragging {
      background: var(--fg-5);
    }
    .browser-panel {
      flex: 2 1 0%;
      min-width: 280px;
      background: var(--bg);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .main-chat.has-browser {
      flex: 1 1 0%;
      min-width: 280px;
    }
    .browser-panel-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--border);
      min-height: 40px;
    }
    .browser-panel-title {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--fg-tool);
      white-space: nowrap;
    }
    .browser-nav-btn {
      background: none;
      border: none;
      color: var(--fg-3);
      cursor: pointer;
      padding: 4px;
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: color 0.15s, background 0.15s;
      flex-shrink: 0;
    }
    .browser-nav-btn:hover:not(:disabled) { color: var(--fg); background: var(--bg-bubble-user); }
    .browser-nav-btn:disabled { opacity: 0.3; cursor: default; }
    .browser-panel-url {
      flex: 1;
      font-size: 11px;
      color: var(--fg-3);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .browser-panel-close {
      background: none;
      border: none;
      color: var(--fg-3);
      font-size: 18px;
      cursor: pointer;
      padding: 0 4px;
      line-height: 1;
    }
    .browser-panel-close:hover {
      color: var(--fg);
    }
    .browser-panel-viewport {
      flex: 1;
      position: relative;
      overflow: auto;
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding: 8px;
    }
    .browser-panel-viewport img {
      max-width: 100%;
      border-radius: 4px;
      display: block;
      outline: none;
    }
    .browser-panel-viewport img:focus {
      box-shadow: 0 0 0 2px var(--accent);
    }
    .browser-panel-placeholder {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--fg-3);
      font-size: 13px;
    }
    @media (max-width: 768px) {
      .main-body { flex-direction: column; }
      .browser-panel {
        position: relative;
        order: -1;
        max-height: 35vh;
        flex: none !important;
        width: auto !important;
        border-bottom: 1px solid var(--border-1);
      }
      .browser-panel-resize { display: none !important; }
      .main-chat.has-browser { flex: 1 1 auto !important; min-width: 0; min-height: 0; }
    }

    /* --- Subagent UI --- */

    .subagent-tree {
      margin-left: 16px;
    }
    .subagent-tree-item {
      height: 36px;
      min-height: 36px;
      max-height: 36px;
      flex-shrink: 0;
      padding: 0 10px 0 18px;
      display: flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
      font-size: 13px;
      color: var(--fg-4);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      position: relative;
      transition: color 0.15s;
    }
    .subagent-tree-item::before {
      content: "";
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      border-left: 1px solid var(--border-5);
    }
    .subagent-tree-item::after {
      content: "";
      position: absolute;
      left: 0;
      top: 50%;
      width: 8px;
      border-top: 1px solid var(--border-5);
    }
    .subagent-tree-item.last::before {
      bottom: auto;
      height: 50%;
      width: 8px;
      border-bottom: 1px solid var(--border-5);
      border-bottom-left-radius: 4px;
    }
    .subagent-tree-item.last::after {
      display: none;
    }
    .subagent-tree-item:hover { color: var(--fg-3); }
    .subagent-tree-item.active { color: var(--fg); }
    .subagent-tree-item .approval-dot {
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--warning, #e8a735);
      flex-shrink: 0;
    }
    .subagent-title {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .subagent-banner {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 6px 16px;
      background: var(--surface-2);
      border-bottom: none;
      color: var(--fg-3);
      flex-shrink: 0;
    }
    .subagent-banner-text {
      font-size: 12px;
    }
    .subagent-back-btn {
      background: none;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 4px 10px;
      font-size: 12px;
      color: var(--accent);
      cursor: pointer;
      transition: background 0.15s;
    }
    .subagent-back-btn:hover {
      background: var(--surface-1);
    }
    .subagent-link {
      color: var(--accent);
      text-decoration: none;
      font-size: 11px;
      margin-left: 4px;
      cursor: pointer;
    }
    .subagent-link:hover {
      text-decoration: underline;
    }

    /* Reduced motion */
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.01ms !important;
        transition-duration: 0.01ms !important;
      }
    }
`;
