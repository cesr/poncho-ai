export const getWebUiClientScript = (markedSource: string): string => `
      // Marked library (inlined)
      ${markedSource}

      // Configure marked for GitHub Flavored Markdown (tables, etc.)
      marked.setOptions({
        gfm: true,
        breaks: true
      });

      // --- Tenant token handling ---
      // Extract ?token= from URL on first load, strip from address bar, persist in sessionStorage
      const _extractTenantToken = () => {
        const params = new URLSearchParams(window.location.search);
        const urlToken = params.get("token");
        if (urlToken) {
          sessionStorage.setItem("poncho_tenant_token", urlToken);
          params.delete("token");
          const qs = params.toString();
          const cleanUrl = window.location.pathname + (qs ? "?" + qs : "") + window.location.hash;
          history.replaceState(null, "", cleanUrl);
          return urlToken;
        }
        return sessionStorage.getItem("poncho_tenant_token") || null;
      };
      const _tenantToken = _extractTenantToken();

      const state = {
        csrfToken: "",
        tenantToken: _tenantToken,
        conversations: [],
        activeConversationId: null,
        activeMessages: [],
        // Verbose dev (-v) only: mirror of conversation._harnessMessages plus
        // the current view mode the user toggled to.
        verboseDev: false,
        viewMode: "user", // "user" | "harness"
        harnessMessages: null,
        isStreaming: false,
        activeStreamAbortController: null,
        activeStreamConversationId: null,
        activeStreamRunId: null,
        _activeStreamMessages: null,
        isMessagesPinnedToBottom: true,
        confirmDeleteId: null,
        approvalRequestsInFlight: {},
        pendingFiles: [],
        contextTokens: 0,
        contextWindow: 0,
        subagents: [],
        subagentsParentId: null,
        viewingSubagentId: null,
        parentConversationId: null,
        todos: [],
        todoPanelCollapsed: false,
        cronSectionCollapsed: true,
        cronShowAll: false,
        subagentPollInFlight: {},
        slashCommands: null,
        slashMenuIndex: 0,
        threadsByParent: {},
        confirmDeleteThreadId: null,
        threadPanel: {
          open: false,
          threadId: null,
          parentMessageId: null,
          messages: [],
          isStreaming: false,
          abortController: null,
          pendingFiles: [],
        },
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
        viewToggle: $("view-toggle"),
        logout: $("logout"),
        composer: $("composer"),
        prompt: $("prompt"),
        send: $("send"),
        shell: $("app"),
        sidebarToggle: $("sidebar-toggle"),
        sidebarBackdrop: $("sidebar-backdrop"),
        attachBtn: $("attach-btn"),
        fileInput: $("file-input"),
        attachmentPreview: $("attachment-preview"),
        dragOverlay: $("drag-overlay"),
        lightbox: $("lightbox"),
        contextRingFill: $("context-ring-fill"),
        contextTooltip: $("context-tooltip"),
        sendBtnWrapper: $("send-btn-wrapper"),
        browserPanel: $("browser-panel"),
        browserPanelResize: $("browser-panel-resize"),
        browserPanelFrame: $("browser-panel-frame"),
        browserPanelUrl: $("browser-panel-url"),
        browserPanelPlaceholder: $("browser-panel-placeholder"),
        browserPanelClose: $("browser-panel-close"),
        browserNavBack: $("browser-nav-back"),
        browserNavForward: $("browser-nav-forward"),
        threadPanel: $("thread-panel"),
        threadPanelResize: $("thread-panel-resize"),
        threadPanelClose: $("thread-panel-close"),
        threadPanelMessages: $("thread-panel-messages"),
        threadComposer: $("thread-composer"),
        threadAttachBtn: $("thread-attach-btn"),
        threadFileInput: $("thread-file-input"),
        threadAttachmentPreview: $("thread-attachment-preview"),
        threadPrompt: $("thread-prompt"),
        threadSend: $("thread-send"),
      };
      const sendIconMarkup =
        '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 12V4M4 7l4-4 4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      const stopIconMarkup =
        '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="4" y="4" width="8" height="8" rx="2" fill="currentColor"/></svg>';

      const CONTEXT_RING_CIRCUMFERENCE = 2 * Math.PI * 14.5;
      const formatTokenCount = (n) => {
        if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\\.0$/, "") + "M";
        if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\\.0$/, "") + "k";
        return String(n);
      };
      const updateContextRing = () => {
        const ring = elements.contextRingFill;
        const tooltip = elements.contextTooltip;
        if (!ring || !tooltip) return;
        if (state.contextWindow <= 0) {
          ring.style.strokeDasharray = String(CONTEXT_RING_CIRCUMFERENCE);
          ring.style.strokeDashoffset = String(CONTEXT_RING_CIRCUMFERENCE);
          tooltip.textContent = "";
          return;
        }
        const ratio = Math.min(state.contextTokens / state.contextWindow, 1);
        const offset = CONTEXT_RING_CIRCUMFERENCE * (1 - ratio);
        ring.style.strokeDasharray = String(CONTEXT_RING_CIRCUMFERENCE);
        ring.style.strokeDashoffset = String(offset);
        ring.classList.toggle("warning", ratio >= 0.7 && ratio < 0.9);
        ring.classList.toggle("critical", ratio >= 0.9);
        const pct = (ratio * 100).toFixed(1).replace(/\\.0$/, "");
        tooltip.textContent = formatTokenCount(state.contextTokens) + " / " + formatTokenCount(state.contextWindow) + " tokens (" + pct + "%)";
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
        // Tenant token auth: send Bearer header instead of relying on cookies
        if (state.tenantToken) {
          headers["Authorization"] = "Bearer " + state.tenantToken;
        } else if (mutatingMethods.has(method) && state.csrfToken) {
          headers["x-csrf-token"] = state.csrfToken;
        }
        if (options.body && !headers["Content-Type"]) {
          headers["Content-Type"] = "application/json";
        }
        const response = await fetch(path, { credentials: state.tenantToken ? "omit" : "include", ...options, method, headers });
        if (!response.ok) {
          if (response.status === 401 && state.tenantToken) {
            // Token expired — clear and show message
            state.tenantToken = null;
            sessionStorage.removeItem("poncho_tenant_token");
            document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui;color:#666"><p>Session expired. Please reload with a new token.</p></div>';
            throw new Error("Session expired");
          }
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

      // Backtick character — defined once via charCode to avoid any escaping ambiguity
      // across the TypeScript template literal → browser JavaScript boundary.
      const _TK = String.fromCharCode(96);

      // Shared tool-text builder — single source of truth for tool:completed formatting.
      // Used by main SSE handler, continuation handler, and subagent handler.
      const buildToolDoneText = (payload) => {
        const toolName = payload.tool || "tool";
        const duration = typeof payload.duration === "number" ? payload.duration : null;
        const inp = payload.input && typeof payload.input === "object" ? payload.input : {};
        const out = payload.output && typeof payload.output === "object" ? payload.output : {};
        var detail = "";
        if (toolName === "bash" && typeof inp.command === "string") {
          detail = inp.command;
        } else if (toolName === "web_search") {
          const q = typeof inp.query === "string" ? inp.query : (typeof out.query === "string" ? out.query : "");
          if (q) detail = "\\x22" + (q.length > 60 ? q.slice(0, 57) + "..." : q) + "\\x22";
        } else if (toolName === "web_fetch") {
          const u = typeof inp.url === "string" ? inp.url : (typeof out.url === "string" ? out.url : "");
          if (u) detail = u;
        } else if (toolName === "spawn_subagent") {
          detail = typeof inp.task === "string" ? inp.task : "";
        } else {
          // Generic: pick the first short string value from input
          for (var k in inp) {
            var v = inp[k];
            if (typeof v === "string" && v.length > 0) {
              detail = v.length > 80 ? v.slice(0, 77) + "..." : v;
              break;
            }
          }
        }
        if (detail) detail = detail.replace(/\\n/g, " ");
        const meta = [];
        if (duration !== null) meta.push(duration + "ms");
        if (detail) meta.push(detail);
        var text = "- done " + _TK + toolName + _TK + (meta.length > 0 ? " (" + meta.join(", ") + ")" : "");
        if (toolName === "spawn_subagent" && out.subagentId) {
          text += " [subagent:" + out.subagentId + "]";
        }
        if (toolName === "bash" && typeof out.exitCode === "number" && out.exitCode !== 0) {
          text += " \\u2014 exit " + out.exitCode;
        }
        if (toolName === "web_search" && Array.isArray(out.results)) {
          text += " \\u2014 " + out.results.length + " result" + (out.results.length !== 1 ? "s" : "");
        }
        return text;
      };

      const _mdCache = new Map();
      const renderAssistantMarkdown = (value) => {
        const source = String(value || "").trim();
        if (!source) return "<p></p>";

        const cached = _mdCache.get(source);
        if (cached !== undefined) return cached;

        try {
          const result = marked.parse(source);
          _mdCache.set(source, result);
          if (_mdCache.size > 500) {
            _mdCache.delete(_mdCache.keys().next().value);
          }
          return result;
        } catch (error) {
          console.error("Markdown parsing error:", error);
          return "<p>" + escapeHtml(source) + "</p>";
        }
      };

      // During streaming, incomplete backtick sequences cause marked to
      // swallow all subsequent text into an invisible code element. This
      // helper detects unclosed fences and inline code delimiters and
      // appends the missing closing so marked can render partial text.
      const closeStreamingMarkdown = (text) => {
        const BT = "\x60";
        let result = text;

        // 1. Unclosed fenced code blocks (lines starting with 3+ backticks)
        const lines = result.split("\\n");
        let openFenceLen = 0;
        for (let li = 0; li < lines.length; li++) {
          const trimmed = lines[li].trimStart();
          let btCount = 0;
          while (btCount < trimmed.length && trimmed[btCount] === BT) btCount++;
          if (btCount >= 3) {
            if (openFenceLen === 0) {
              openFenceLen = btCount;
            } else if (btCount >= openFenceLen) {
              openFenceLen = 0;
            }
          }
        }
        if (openFenceLen > 0) {
          let fence = "";
          for (let k = 0; k < openFenceLen; k++) fence += BT;
          return result + "\\n" + fence;
        }

        // 2. Unclosed inline code delimiters
        let idx = 0;
        let inCode = false;
        let delimLen = 0;
        while (idx < result.length) {
          if (result[idx] === BT) {
            let run = 0;
            while (idx < result.length && result[idx] === BT) { run++; idx++; }
            if (!inCode) {
              inCode = true;
              delimLen = run;
            } else if (run === delimLen) {
              inCode = false;
            }
          } else {
            idx++;
          }
        }
        if (inCode) {
          let closing = "";
          for (let k = 0; k < delimLen; k++) closing += BT;
          result += closing;
        }

        return result;
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
            const input = req.input != null ? req.input : {};
            const subagentLabel = req._subagentLabel
              ? ' <span class="ta-detail">(from ' + escapeHtml(req._subagentLabel) + ')</span>'
              : "";
            if (req.state === "resolved") {
              const isApproved = req.resolvedDecision === "approve";
              return (
                '<div class="tool-activity-item">' +
                '<div class="ta-row">' +
                (isApproved ? '<span class="ta-icon ta-ok">✓</span>' : '<span class="ta-icon ta-fail">✕</span>') +
                '<span class="ta-tool">' + escapeHtml(tool) + '</span>' +
                '<span class="ta-detail">' + (isApproved ? "Approved" : "Denied") + '</span>' +
                subagentLabel +
                '</div></div>'
              );
            }
            const submitting = req.state === "submitting";
            const approveLabel = submitting && req.pendingDecision === "approve" ? "Approving..." : "Approve";
            const denyLabel = submitting && req.pendingDecision === "deny" ? "Denying..." : "Deny";
            const errorHtml = req._error
              ? '<div class="approval-error">Submit failed: ' + escapeHtml(req._error) + "</div>"
              : "";
            var inputSummary = renderInputTable(input);
            return (
              '<div class="approval-request-item">' +
              '<div class="ta-row">' +
              '<span class="ta-tool">' + escapeHtml(tool) + '</span>' +
              subagentLabel +
              '</div>' +
              inputSummary +
              errorHtml +
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
        const actionableCount = requests.filter((r) => r.state !== "resolved").length;
        const batchButtons = actionableCount > 1
          ? '<div class="approval-batch-actions">' +
            '<button class="approval-batch-btn approve" data-approval-batch="approve">Approve all (' + actionableCount + ')</button>' +
            '<button class="approval-batch-btn deny" data-approval-batch="deny">Deny all (' + actionableCount + ')</button>' +
            "</div>"
          : "";
        return (
          '<div class="approval-requests">' +
          '<div class="approval-requests-title"><span class="ta-icon ta-warn">⚠</span> Approval required</div>' +
          rows +
          batchButtons +
          "</div>"
        );
      };

      const extractToolImages = (output) => {
        const images = [];
        if (!output || typeof output !== "object") return images;
        const check = (val) => {
          if (val && typeof val === "object" && val.type === "file" && val.data && typeof val.mediaType === "string" && val.mediaType.startsWith("image/")) {
            images.push(val);
          }
        };
        if (Array.isArray(output)) { output.forEach(check); } else { Object.values(output).forEach(check); }
        return images;
      };

      const renderToolActivity = (items, approvalRequests = [], toolImages = []) => {
        const hasItems = Array.isArray(items) && items.length > 0;
        const hasApprovals = Array.isArray(approvalRequests) && approvalRequests.length > 0;
        if (!hasItems && !hasApprovals) {
          return "";
        }
        const subagentLinkRe = /\\s*\\[subagent:([^\\]]+)\\]$/;
        const toolLinkRe = /\\s*\\[link:(https?:\\/\\/[^\\]]+)\\]$/;
        // Parse status and tool name from activity lines like "- start \`bash\` (detail)"
        const activityRe = new RegExp("^- (preparing|start|done|error|approval required) " + _TK + "([^" + _TK + "]+)" + _TK + "(.*)$");
        const durationRe = /\\(([\\d,]+ms)/;
        const exitCodeRe = /\\u2014 exit (\\d+)/;
        const resultCountRe = /\\u2014 (\\d+ results?)$/;
        const renderActivityItem = (item) => {
          const flat = item.replace(/\\n/g, " ");
          const subMatch = flat.match(subagentLinkRe);
          const linkMatch = flat.match(toolLinkRe);
          const cleanItem = flat.replace(subagentLinkRe, "").replace(toolLinkRe, "");
          const m = cleanItem.match(activityRe);

          if (m) {
            const status = m[1];
            const toolName = m[2];
            const rest = m[3].trim();

            // Extract detail (in parens), duration, exit code, result count
            const detailMatch = rest.match(/^\\((.+?)\\)(.*)$/);
            const durMatch = rest.match(durationRe);
            const exitMatch = rest.match(exitCodeRe);
            const countMatch = rest.match(resultCountRe);

            let detail = "";
            if (status === "error") {
              // Error format: (input_detail): error_message — or just : error_message
              const colonIdx = rest.indexOf(":");
              detail = colonIdx >= 0 ? rest.slice(colonIdx + 1).trim() : rest.trim();
            } else if (detailMatch) {
              const parts = detailMatch[1].split(", ");
              detail = durMatch ? parts.slice(1).join(", ") : parts.join(", ");
            }

            const icon = "";

            // Duration badge
            const durBadge = durMatch
              ? '<span class="ta-dur">' + escapeHtml(durMatch[1]) + '</span>'
              : "";

            // Exit code badge
            const exitBadge = exitMatch
              ? '<span class="ta-exit">exit ' + escapeHtml(exitMatch[1]) + '</span>'
              : "";

            // Result count badge
            const countBadge = countMatch
              ? '<span class="ta-count">' + escapeHtml(countMatch[1]) + '</span>'
              : "";

            // Tool name display
            const toolDisplay = '<span class="ta-tool">' + escapeHtml(toolName) + '</span>';

            // Detail — for bash, render as terminal command; for web_fetch, render as clickable link
            let detailHtml = "";
            if (detail) {
              if (toolName === "bash") {
                detailHtml = '<div class="ta-cmd"><span class="ta-prompt">$</span> ' + escapeHtml(detail) + '</div>';
              } else if ((toolName === "web_fetch") && /^https?:\\/\\//.test(detail)) {
                var displayUrl = detail.replace(/^https?:\\/\\//, "");
                if (displayUrl.length > 60) displayUrl = displayUrl.slice(0, 57) + "...";
                detailHtml = '<a class="ta-detail tool-link" href="' + escapeHtml(detail) + '" target="_blank" rel="noopener">' + escapeHtml(displayUrl) + '</a>';
              } else {
                detailHtml = '<span class="ta-detail">' + escapeHtml(detail) + '</span>';
              }
            }

            // Links
            let linkHtml = "";
            if (subMatch) {
              const subId = escapeHtml(subMatch[1]);
              linkHtml = ' <a class="subagent-link" href="javascript:void(0)" data-subagent-id="' + subId + '">View subagent</a>';
            }
            if (linkMatch) {
              const href = escapeHtml(linkMatch[1]);
              var displayUrl = linkMatch[1].replace(/^https?:\\/\\//, "");
              if (displayUrl.length > 55) displayUrl = displayUrl.slice(0, 52) + "...";
              linkHtml = ' <a class="tool-link" href="' + href + '" target="_blank" rel="noopener">' + escapeHtml(displayUrl) + '</a>';
            }

            return '<div class="tool-activity-item ta-' + status.replace(/ /g, "-") + '">' +
              '<div class="ta-row">' + icon + toolDisplay + (detailHtml ? detailHtml : '') + exitBadge + countBadge + linkHtml + durBadge + '</div>' +
              '</div>';
          }

          // Fallback: plain text
          return '<div class="tool-activity-item">' + escapeHtml(item) + "</div>";
        };
        // Deduplicate:
        // - Remove "start"/"preparing" when "done" or "approval required" exists for the same tool
        // - Remove "approval required" when a "done (approved)" exists for the same tool
        const dedupedItems = hasItems ? items.filter((item) => {
          var flat2 = item.replace(/\\n/g, " ");
          const m2 = flat2.match(activityRe);
          if (!m2) return true;
          const status = m2[1];
          const tool = m2[2];
          if (status === "preparing" || status === "start") {
            return !items.some((other) => {
              var flatOther = other.replace(/\\n/g, " ");
              const m3 = flatOther.match(activityRe);
              return m3 && (m3[1] === "done" || m3[1] === "approval required") && m3[2] === tool;
            });
          }
          return true;
        }) : [];
        const chips = dedupedItems.length > 0
          ? dedupedItems.map(renderActivityItem).join("")
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
        const hasImages = Array.isArray(toolImages) && toolImages.length > 0;
        const imagesHtml = hasImages
          ? '<div class="tool-images">' + toolImages.map((img) =>
              '<img class="tool-screenshot" src="data:' + escapeHtml(img.mediaType) + ';base64,' + img.data + '" alt="' + escapeHtml(img.filename || "screenshot") + '" />'
            ).join("") + "</div>"
          : "";
        const cls = "tool-activity" + (hasApprovals ? " has-approvals" : "");
        return (
          '<div class="' + cls + '">' +
          imagesHtml +
          disclosure +
          renderApprovalRequests(approvalRequests) +
          "</div>"
        );
      };

      const renderSubagentResult = (content, metadata) => {
        const contentStr = String(content || "");
        // Prefer metadata.task (new messages); fall back to parsing content for old messages
        const taskFromContent = contentStr.match(/\[Subagent Result\] Subagent "([^"]+)"/)?.[1];
        const task = (metadata && metadata.task) ? String(metadata.task) : (taskFromContent || "subagent result");
        const shortTask = task.length > 60 ? task.slice(0, 57) + "…" : task;
        const caretSvg = '<svg viewBox="0 0 12 12" fill="none"><path d="M4.5 2.75L8 6L4.5 9.25" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path></svg>';
        return (
          '<details class="subagent-result-disclosure">' +
          '<summary class="subagent-result-summary">' +
          '<span class="subagent-result-label">' + escapeHtml(shortTask) + '</span>' +
          '<span class="subagent-result-caret" aria-hidden="true">' + caretSvg + '</span>' +
          '</summary>' +
          '<div class="subagent-result-body">' + renderAssistantMarkdown(contentStr) + '</div>' +
          '</details>'
        );
      };

      const renderInputTable = (input) => {
        if (!input || typeof input !== "object") {
          return '<div class="av-complex">' + escapeHtml(String(input ?? "{}")) + "</div>";
        }
        const keys = Object.keys(input);
        if (keys.length === 0) {
          return '<div class="av-complex">{}</div>';
        }
        const formatValue = (val) => {
          if (val === null || val === undefined) return escapeHtml("null");
          if (typeof val === "boolean" || typeof val === "number") return escapeHtml(String(val));
          if (typeof val === "string") return escapeHtml(val);
          try {
            const replacer = (_, v) => typeof v === "bigint" ? String(v) : v;
            return escapeHtml(JSON.stringify(val, replacer, 2));
          } catch {
            return escapeHtml("[unserializable]");
          }
        };
        const rows = keys.map((key) => {
          const val = input[key];
          const isComplex = val !== null && typeof val === "object";
          const cls = isComplex ? "av-complex" : "av";
          return (
            "<tr>" +
            '<td class="ak">' + escapeHtml(key) + "</td>" +
            '<td><div class="' + cls + '">' + formatValue(val) + "</div></td>" +
            "</tr>"
          );
        }).join("");
        return '<table class="approval-request-table">' + rows + "</table>";
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

      const clearResolvedApprovals = (message) => {
        if (Array.isArray(message._pendingApprovals)) {
          message._pendingApprovals = message._pendingApprovals.filter(
            (req) => req.state !== "resolved",
          );
        }
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
            const decision =
              item && typeof item.decision === "string" ? item.decision : null;
            const isResolved = decision === "approved" || decision === "denied";
            return {
              approvalId,
              tool: toolName,
              input: item?.input ?? {},
              state: isResolved ? "resolved" : "pending",
              resolvedDecision:
                decision === "approved"
                  ? "approve"
                  : decision === "denied"
                    ? "deny"
                    : null,
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
        const toolLines = pending.map((request) => "- approval required " + _TK + request.tool + _TK);
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

      const buildConversationItem = (c) => {
        const item = document.createElement("div");
        const isActive = c.conversationId === state.activeConversationId ||
          (state.parentConversationId && state.parentConversationId === c.conversationId);
        item.className = "conversation-item" + (isActive ? " active" : "");

        if (c.hasPendingApprovals) {
          const dot = document.createElement("span");
          dot.className = "approval-dot";
          item.appendChild(dot);
        }

        const titleSpan = document.createElement("span");
        titleSpan.textContent = c.title;
        item.appendChild(titleSpan);

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
          // Optimistic: update UI immediately, delete in background
          state.conversations = state.conversations.filter(
            function(conv) { return conv.conversationId !== c.conversationId; }
          );
          state.subagents = (state.subagents || []).filter(
            function(sub) { return sub.conversationId !== c.conversationId; }
          );
          if (state.activeConversationId === c.conversationId) {
            state.activeConversationId = null;
            state.activeMessages = [];
            state.contextTokens = 0;
            state.contextWindow = 0;
            state.todos = [];
            updateContextRing();
            renderTodoPanel();
            pushConversationUrl(null);
            elements.chatTitle.textContent = "";
            renderMessages([]);
          }
          state.confirmDeleteId = null;
          renderConversationList();
          api("/api/conversations/" + c.conversationId, { method: "DELETE" }).catch(function() {});
        };
        item.appendChild(deleteBtn);

        item.onclick = async () => {
          if (state.confirmDeleteId) {
            state.confirmDeleteId = null;
          }
          var switchingFamily = state.subagentsParentId !== c.conversationId;
          state.activeConversationId = c.conversationId;
          state.viewingSubagentId = null;
          state.parentConversationId = null;
          if (switchingFamily) {
            state.subagents = [];
            state.subagentsParentId = null;
          }
          pushConversationUrl(c.conversationId);
          renderConversationList();
          await loadConversation(c.conversationId);
          if (isMobile()) setSidebarOpen(false);
        };

        return item;
      };

      const _todoPriorityOrder = { high: 0, medium: 1, low: 2 };
      const _todoStatusOrder = { in_progress: 0, pending: 1, completed: 2 };
      const _todoCompletedTimers = new Map();

      const _scheduleCompletedHide = () => {
        state.todos.forEach(function(todo) {
          if (todo.status === "completed" && !_todoCompletedTimers.has(todo.id)) {
            _todoCompletedTimers.set(todo.id, todo.updatedAt || Date.now());
          }
        });
        const activeIds = new Set(state.todos.map(function(t) { return t.id; }));
        for (const id of _todoCompletedTimers.keys()) {
          if (!activeIds.has(id)) _todoCompletedTimers.delete(id);
        }
      };

      const _getVisibleTodos = () => {
        const now = Date.now();
        const sorted = state.todos.slice().sort(function(a, b) {
          const sp = (_todoStatusOrder[a.status] || 1) - (_todoStatusOrder[b.status] || 1);
          if (sp !== 0) return sp;
          const pp = (_todoPriorityOrder[a.priority] || 1) - (_todoPriorityOrder[b.priority] || 1);
          if (pp !== 0) return pp;
          return (a.createdAt || 0) - (b.createdAt || 0);
        });
        if (!state.todoPanelCollapsed) return sorted;
        return sorted.filter(function(todo) {
          if (todo.status !== "completed") return true;
          const completedAt = _todoCompletedTimers.get(todo.id);
          return !completedAt || (now - completedAt) < 30000;
        });
      };

      let _todoHideTimer = null;
      const _ensureHideTimer = () => {
        if (_todoHideTimer) return;
        _todoHideTimer = setInterval(function() {
          const hasExpiring = state.todos.some(function(t) {
            if (t.status !== "completed") return false;
            const at = _todoCompletedTimers.get(t.id);
            return at && (Date.now() - at) >= 30000;
          });
          if (hasExpiring && state.todoPanelCollapsed) renderTodoPanel();
          if (!state.todos.length) {
            clearInterval(_todoHideTimer);
            _todoHideTimer = null;
          }
        }, 5000);
      };

      const _autoCollapseTodos = (live) => {
        if (!live) {
          state.todoPanelCollapsed = true;
          return;
        }
        const hasActive = state.todos.some(function(t) {
          return t.status === "pending" || t.status === "in_progress";
        });
        state.todoPanelCollapsed = !hasActive;
      };

      const renderTodoPanel = () => {
        let panel = document.getElementById("todo-panel");
        if (!panel) return;

        _scheduleCompletedHide();
        const visible = _getVisibleTodos();

        if (!visible.length) {
          panel.classList.add("hidden");
          panel.innerHTML = "";
          return;
        }

        panel.classList.remove("hidden");
        if (state.todoPanelCollapsed) {
          panel.classList.add("collapsed");
        } else {
          panel.classList.remove("collapsed");
        }
        _ensureHideTimer();

        const completed = state.todos.filter(t => t.status === "completed").length;
        const total = state.todos.length;

        const statusIcon = (status) => {
          if (status === "completed") return '<span class="todo-status todo-status-completed">\\u2713</span>';
          if (status === "in_progress") return '<span class="todo-status todo-status-in-progress">\\u25CF</span>';
          return '<span class="todo-status todo-status-pending">\\u25CB</span>';
        };

        const priorityBadge = (priority) => {
          if (!priority || priority === "medium") return "";
          return '<span class="todo-priority todo-priority-' + priority + '">' + priority + '</span>';
        };

        const isCollapsed = state.todoPanelCollapsed;

        let html = '<div class="todo-panel-header" id="todo-panel-header">';
        html += '<div class="todo-panel-title">';
        html += '<span class="todo-panel-label">Todos</span>';
        html += '<span class="todo-panel-progress">' + completed + '/' + total + ' done</span>';
        html += '</div>';
        html += '<span class="todo-panel-toggle' + (isCollapsed ? '' : ' open') + '"><svg viewBox="0 0 12 12" fill="none" width="12" height="12"><path d="M4.5 2.75L8 6L4.5 9.25" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path></svg></span>';
        html += '</div>';

        if (!isCollapsed) {
          html += '<ul class="todo-panel-list">';
          visible.forEach(function(todo) {
            const isDone = todo.status === "completed";
            html += '<li class="todo-item' + (isDone ? ' todo-item-done' : '') + '">';
            html += statusIcon(todo.status);
            html += '<span class="todo-item-content">' + escapeHtml(todo.content) + '</span>';
            html += priorityBadge(todo.priority);
            html += '</li>';
          });
          html += '</ul>';
        }

        panel.innerHTML = html;

        const header = document.getElementById("todo-panel-header");
        if (header) {
          header.onclick = function() {
            state.todoPanelCollapsed = !state.todoPanelCollapsed;
            renderTodoPanel();
          };
        }
      };

      const cronCaretSvg = '<svg viewBox="0 0 12 12" fill="none" width="10" height="10"><path d="M4.5 2.75L8 6L4.5 9.25" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path></svg>';

      const parseCronTitle = (title) => {
        const rest = title.replace(/^\[cron\]\s*/, "");
        const isoMatch = rest.match(/\s(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)$/);
        if (isoMatch) {
          return { jobName: rest.slice(0, isoMatch.index).trim(), timestamp: isoMatch[1] };
        }
        return { jobName: rest, timestamp: "" };
      };

      const formatCronTimestamp = (isoStr) => {
        if (!isoStr) return "";
        try {
          const d = new Date(isoStr);
          if (isNaN(d.getTime())) return isoStr;
          return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
        } catch { return isoStr; }
      };

      const CRON_PAGE_SIZE = 20;

      const appendCronSection = (cronConvs, needsDivider) => {
        if (needsDivider) {
          const divider = document.createElement("div");
          divider.className = "sidebar-section-divider";
          elements.list.appendChild(divider);
        }

        cronConvs.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));

        const isOpen = !state.cronSectionCollapsed;
        const header = document.createElement("div");
        header.className = "cron-section-header";
        header.innerHTML =
          '<span class="cron-section-caret' + (isOpen ? ' open' : '') + '">' + cronCaretSvg + '</span>' +
          '<span>Cron jobs</span>' +
          '<span class="cron-section-count">' + cronConvs.length + '</span>';
        header.onclick = () => {
          state.cronSectionCollapsed = !state.cronSectionCollapsed;
          state.cronShowAll = false;
          renderConversationList();
        };
        elements.list.appendChild(header);

        if (state.cronSectionCollapsed) return;

        const limit = state.cronShowAll ? cronConvs.length : CRON_PAGE_SIZE;
        const visible = cronConvs.slice(0, limit);

        for (const c of visible) {
          const { jobName, timestamp } = parseCronTitle(c.title);
          const fmtTime = formatCronTimestamp(timestamp);
          const displayTitle = fmtTime ? jobName + " \\u00b7 " + fmtTime : c.title;
          elements.list.appendChild(buildConversationItem(Object.assign({}, c, { title: displayTitle })));
          appendSubagentsIfActive(c.conversationId);
        }

        if (!state.cronShowAll && cronConvs.length > CRON_PAGE_SIZE) {
          const remaining = cronConvs.length - CRON_PAGE_SIZE;
          const viewMore = document.createElement("div");
          viewMore.className = "cron-view-more";
          viewMore.textContent = "View " + remaining + " more\\u2026";
          viewMore.onclick = () => {
            state.cronShowAll = true;
            renderConversationList();
          };
          elements.list.appendChild(viewMore);
        }
      };

      const renderConversationList = () => {
        elements.list.innerHTML = "";
        const pending = state.conversations.filter(c => c.hasPendingApprovals);
        const rest = state.conversations.filter(c => !c.hasPendingApprovals);

        const isCron = (c) => c.title && c.title.startsWith("[cron]");
        const cronConvs = rest.filter(isCron);
        const nonCron = rest.filter(c => !isCron(c));

        if (pending.length > 0) {
          const label = document.createElement("div");
          label.className = "sidebar-section-label";
          label.textContent = "Awaiting approval";
          elements.list.appendChild(label);
          for (const c of pending) {
            elements.list.appendChild(buildConversationItem(c));
            appendSubagentsIfActive(c.conversationId);
          }
        }

        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const sevenDaysAgo = startOfToday - 7 * 86400000;

        const latest = [];
        const previous7 = [];
        const older = [];
        for (const c of nonCron) {
          const ts = c.updatedAt || c.createdAt || 0;
          if (ts >= startOfToday) {
            latest.push(c);
          } else if (ts >= sevenDaysAgo) {
            previous7.push(c);
          } else {
            older.push(c);
          }
        }

        let sectionRendered = pending.length > 0;

        if (cronConvs.length > 0) {
          appendCronSection(cronConvs, sectionRendered);
          sectionRendered = true;
        }

        const appendSection = (items, labelText) => {
          if (items.length === 0) return;
          if (sectionRendered) {
            const divider = document.createElement("div");
            divider.className = "sidebar-section-divider";
            elements.list.appendChild(divider);
          }
          const sectionLabel = document.createElement("div");
          sectionLabel.className = "sidebar-section-label";
          sectionLabel.textContent = labelText;
          elements.list.appendChild(sectionLabel);
          for (const c of items) {
            elements.list.appendChild(buildConversationItem(c));
            appendSubagentsIfActive(c.conversationId);
          }
          sectionRendered = true;
        };

        appendSection(latest, "Latest");
        appendSection(previous7, "Previous 7 days");
        appendSection(older, "Older");
      };

      const appendSubagentsIfActive = (conversationId) => {
        const isActive = state.activeConversationId === conversationId ||
          (state.parentConversationId && state.parentConversationId === conversationId) ||
          (state.subagentsParentId && state.subagentsParentId === conversationId);
        if (!isActive || state.subagents.length === 0) return;

        const tree = document.createElement("div");
        tree.className = "subagent-tree";

        for (var si = 0; si < state.subagents.length; si++) {
          var sub = state.subagents[si];
          var isLast = si === state.subagents.length - 1;

          var row = document.createElement("div");
          row.className = "subagent-tree-item" +
            (state.viewingSubagentId === sub.conversationId ? " active" : "") +
            (isLast ? " last" : "");

          if (sub.hasPendingApprovals) {
            var dot = document.createElement("span");
            dot.className = "approval-dot";
            row.appendChild(dot);
          }

          var titleSpan = document.createElement("span");
          titleSpan.className = "subagent-title";
          titleSpan.textContent = sub.task.length > 50 ? sub.task.slice(0, 47) + "..." : sub.task;
          titleSpan.title = sub.task;
          row.appendChild(titleSpan);

          (function(s, parentId) {
            row.onclick = async function() {
              state.viewingSubagentId = s.conversationId;
              state.activeConversationId = s.conversationId;
              state.parentConversationId = parentId;
              replaceConversationUrl(s.conversationId);
              renderConversationList();
              await loadConversation(s.conversationId);
              if (isMobile()) setSidebarOpen(false);
            };
          })(sub, conversationId);

          tree.appendChild(row);
        }

        elements.list.appendChild(tree);
      };

      const loadSubagents = async (conversationId, force) => {
        if (!force && state.subagentsParentId === conversationId && state.subagents.length > 0) {
          return;
        }
        try {
          const payload = await api("/api/conversations/" + encodeURIComponent(conversationId) + "/subagents");
          state.subagents = payload.subagents || [];
          state.subagentsParentId = conversationId;
        } catch {
          state.subagents = [];
          state.subagentsParentId = null;
        }
        renderConversationList();
      };

      const updateSubagentUi = () => {
        const isSubagent = !!state.viewingSubagentId;
        const composerEl = document.getElementById("composer");
        const bannerEl = document.getElementById("subagent-banner");

        if (isSubagent) {
          if (composerEl) composerEl.style.display = "none";
          if (!bannerEl) {
            const banner = document.createElement("div");
            banner.id = "subagent-banner";
            banner.className = "subagent-banner";
            banner.innerHTML =
              '<span class="subagent-banner-text">Subagent conversation (read-only)</span>';
            const topbar = document.querySelector(".topbar");
            if (topbar && topbar.parentNode) topbar.parentNode.insertBefore(banner, topbar.nextSibling);
          }
        } else {
          if (composerEl) composerEl.style.display = "";
          if (bannerEl) bannerEl.remove();
        }
      };

      const isNearBottom = (element, threshold = 64) => {
        if (!element) return true;
        return (
          element.scrollHeight - element.clientHeight - element.scrollTop <= threshold
        );
      };

      const formatRelativeTime = (ts) => {
        if (!ts) return "";
        const diff = Math.max(0, Date.now() - ts);
        if (diff < 60_000) return "just now";
        if (diff < 3_600_000) return Math.floor(diff / 60_000) + "m ago";
        if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + "h ago";
        return Math.floor(diff / 86_400_000) + "d ago";
      };

      const REPLY_ICON_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12V8a4 4 0 0 1 4-4h6"/><path d="M10 1l3 3-3 3"/></svg>';

      const isThreadAffordanceCandidate = (m) => {
        if (!m || !m.metadata || typeof m.metadata.id !== "string") return false;
        if (m.role === "system") return false;
        if (m.metadata.isCompactionSummary) return false;
        if (m.metadata._subagentCallback) return false;
        return true;
      };

      const deleteThreadConfirmed = (threadId, parentMessageId) => {
        if (!threadId) return;
        // Optimistic removal — fire DELETE in the background, mirrors the
        // sidebar conversation-delete pattern at line ~798.
        if (parentMessageId && state.threadsByParent[parentMessageId]) {
          state.threadsByParent[parentMessageId] = state.threadsByParent[parentMessageId]
            .filter((t) => t.conversationId !== threadId);
          if (state.threadsByParent[parentMessageId].length === 0) {
            delete state.threadsByParent[parentMessageId];
          }
        }
        if (state.threadPanel.threadId === threadId) {
          closeThreadPanel();
        }
        state.confirmDeleteThreadId = null;
        renderMessages(state.activeMessages, state.isStreaming);
        api(
          "/api/conversations/" + encodeURIComponent(threadId),
          { method: "DELETE" },
        ).catch(() => {});
      };

      // Single absolute-positioned wrap on each message row. Behaves as:
      //   - no threads: hover-only "Reply in thread" pill (creates a thread)
      //   - >=1 thread: always-visible badge per thread (opens that thread)
      // Position (bottom-offset overlapping the message) is identical in both
      // states so the badge sits exactly where the hover pill would.
      const appendThreadAffordances = (row, m) => {
        if (!isThreadAffordanceCandidate(m)) return;
        const messageId = m.metadata.id;
        const threads = state.threadsByParent[messageId] || [];
        const wrap = document.createElement("span");
        wrap.className = "reply-pill-wrap" + (threads.length > 0 ? " has-threads" : "");

        if (threads.length === 0) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "reply-icon-btn";
          btn.title = "Reply in thread";
          btn.innerHTML = REPLY_ICON_SVG + '<span>Reply in thread</span>';
          btn.addEventListener("click", (e) => {
            e.stopPropagation();
            createAndOpenNewThread(messageId);
          });
          wrap.appendChild(btn);
          row.appendChild(wrap);
          return;
        }

        threads.forEach((t) => {
          const pair = document.createElement("span");
          pair.className = "thread-pill-pair";
          const pill = document.createElement("button");
          pill.type = "button";
          pill.className = "reply-icon-btn thread-pill";
          pill.title = "Open thread";
          const replies = t.replyCount || 0;
          const repliesLabel = replies === 1 ? "1 reply" : replies + " replies";
          const meta = t.lastReplyAt ? formatRelativeTime(t.lastReplyAt) : "";
          pill.innerHTML = '<span class="thread-pill-count">' + repliesLabel + '</span>'
            + (meta ? '<span class="thread-pill-meta">' + meta + '</span>' : '');
          pill.addEventListener("click", (e) => {
            e.stopPropagation();
            openThread(t.conversationId, t);
          });
          pair.appendChild(pill);

          const isConfirming = state.confirmDeleteThreadId === t.conversationId;
          const del = document.createElement("button");
          del.type = "button";
          del.className = "thread-row-delete" + (isConfirming ? " confirming" : "");
          del.title = isConfirming ? "Click again to confirm" : "Delete thread";
          del.textContent = isConfirming ? "sure?" : "×";
          del.addEventListener("click", (e) => {
            e.stopPropagation();
            if (!isConfirming) {
              state.confirmDeleteThreadId = t.conversationId;
              renderMessages(state.activeMessages, state.isStreaming);
              return;
            }
            deleteThreadConfirmed(t.conversationId, messageId);
          });
          pair.appendChild(del);
          wrap.appendChild(pair);
        });
        row.appendChild(wrap);
      };

      // Hoisted so both renderMessages and buildSimpleMessageRow can use it.
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

      // Render a single message into a target column. Mirrors the assistant /
      // user branches of renderMessages but without the streaming-specific bits.
      const buildSimpleMessageRow = (m) => {
        const r = document.createElement("div");
        r.className = "message-row " + m.role;
        if (m.role === "assistant") {
          const wrap = document.createElement("div");
          wrap.className = "assistant-wrap";
          wrap.innerHTML = '<div class="assistant-avatar">' + agentInitial + '</div>';
          const content = document.createElement("div");
          content.className = "assistant-content";
          const sections = (m.metadata && m.metadata.sections) || null;
          const text = typeof m.content === "string" ? m.content : "";
          if (sections && sections.length > 0) {
            sections.forEach((section) => {
              if (section.type === "text") {
                const textDiv = document.createElement("div");
                textDiv.innerHTML = renderAssistantMarkdown(section.content);
                content.appendChild(textDiv);
              } else if (section.type === "tools") {
                content.insertAdjacentHTML(
                  "beforeend",
                  renderToolActivity(section.content, [], []),
                );
              }
            });
          } else if (m._streaming && !text) {
            // Empty + streaming → show a thinking indicator until the first
            // model:chunk lands.
            content.appendChild(createThinkingIndicator(""));
          } else {
            content.innerHTML = renderAssistantMarkdown(text);
          }
          wrap.appendChild(content);
          r.appendChild(wrap);
        } else {
          const bubble = document.createElement("div");
          bubble.className = "user-bubble";
          if (typeof m.content === "string") {
            bubble.textContent = m.content;
          } else if (Array.isArray(m.content)) {
            const textParts = m.content.filter((p) => p.type === "text").map((p) => p.text).join("");
            if (textParts) {
              const textEl = document.createElement("div");
              textEl.textContent = textParts;
              bubble.appendChild(textEl);
            }
            // File attachments — same logic as the main renderer
            const fileParts = m.content.filter((p) => p.type === "file");
            if (fileParts.length > 0) {
              const filesEl = document.createElement("div");
              filesEl.className = "user-file-attachments";
              fileParts.forEach((fp) => {
                if (fp.mediaType && fp.mediaType.startsWith("image/")) {
                  const img = document.createElement("img");
                  if (fp.data && fp.data.startsWith("poncho-upload://")) {
                    img.src = "/api/uploads/" + encodeURIComponent(fp.data.replace("poncho-upload://", ""));
                  } else if (fp.data && (fp.data.startsWith("http://") || fp.data.startsWith("https://"))) {
                    img.src = fp.data;
                  } else if (fp.data) {
                    img.src = "data:" + fp.mediaType + ";base64," + fp.data;
                  }
                  img.alt = fp.filename || "image";
                  filesEl.appendChild(img);
                } else {
                  const badge = document.createElement("span");
                  badge.className = "user-file-badge";
                  badge.textContent = "📎 " + (fp.filename || "file");
                  filesEl.appendChild(badge);
                }
              });
              bubble.appendChild(filesEl);
            }
          }
          r.appendChild(bubble);
        }
        return r;
      };

      const renderThreadPanelMessages = () => {
        const root = elements.threadPanelMessages;
        if (!root) return;
        root.innerHTML = "";
        const msgs = state.threadPanel.messages || [];
        if (msgs.length === 0) {
          const empty = document.createElement("div");
          empty.className = "thread-panel-parent-empty";
          empty.textContent = "No replies yet — send the first one below.";
          root.appendChild(empty);
        } else {
          const col = document.createElement("div");
          col.className = "messages-column";
          msgs.forEach((m) => col.appendChild(buildSimpleMessageRow(m)));
          root.appendChild(col);
        }
        root.scrollTop = root.scrollHeight;
      };

      const closeThreadPanel = () => {
        if (state.threadPanel.abortController) {
          try { state.threadPanel.abortController.abort(); } catch (e) {}
        }
        state.threadPanel.open = false;
        state.threadPanel.threadId = null;
        state.threadPanel.parentMessageId = null;
        state.threadPanel.messages = [];
        state.threadPanel.isStreaming = false;
        state.threadPanel.abortController = null;
        state.threadPanel.pendingFiles = [];
        renderThreadAttachmentPreview();
        if (elements.threadPrompt) elements.threadPrompt.value = "";
        if (elements.threadPanel) {
          elements.threadPanel.style.display = "none";
          // Clear inline flex set by drag-resize so next open starts fresh.
          elements.threadPanel.style.flex = "";
        }
        if (elements.threadPanelResize) elements.threadPanelResize.style.display = "none";
        const mainEl = document.querySelector(".main-chat");
        if (mainEl) {
          mainEl.classList.remove("has-thread");
          // Same fix on the main pane.
          mainEl.style.flex = "";
        }
        try {
          if (window.location.hash.indexOf("thread=") >= 0) {
            history.replaceState(null, "", window.location.pathname + window.location.search);
          }
        } catch (e) {}
      };

      const renderActiveTopForThreadPanel = (payload) => {
        const conv = payload.conversation || {};
        const allMsgs = Array.isArray(conv.messages) ? conv.messages : [];
        // Show the anchor message + replies. The earlier snapshot is still
        // part of the thread's context server-side, but the panel only
        // displays what's relevant: the message you forked on, plus what
        // came after.
        const snapshotLength = (conv.threadMeta && typeof conv.threadMeta.snapshotLength === "number")
          ? conv.threadMeta.snapshotLength
          : allMsgs.length;
        const startIdx = Math.max(0, snapshotLength - 1);
        state.threadPanel.messages = allMsgs.slice(startIdx);
        renderThreadPanelMessages();
      };

      const buildAuthHeaders = () => {
        const headers = {};
        if (state.tenantToken) {
          headers["Authorization"] = "Bearer " + state.tenantToken;
        } else if (state.csrfToken) {
          headers["x-csrf-token"] = state.csrfToken;
        }
        return headers;
      };

      const subscribeThreadPanelStream = (threadId) => {
        // Scoped, duplicated SSE handler — independent of the main-pane
        // subscription so a regression here can't break the main conversation.
        if (state.threadPanel.abortController) {
          try { state.threadPanel.abortController.abort(); } catch (e) {}
        }
        const ac = new AbortController();
        state.threadPanel.abortController = ac;
        const url = "/api/conversations/" + encodeURIComponent(threadId) + "/events?live_only=true";
        fetch(url, {
          headers: buildAuthHeaders(),
          signal: ac.signal,
          credentials: state.tenantToken ? "omit" : "include",
        }).then(async (resp) => {
          if (!resp.ok || !resp.body) return;
          const reader = resp.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const events = buf.split("\\n\\n");
            buf = events.pop() || "";
            for (const block of events) {
              if (!block) continue;
              const dataLine = block.split("\\n").find((l) => l.startsWith("data: "));
              if (!dataLine) continue;
              if (state.threadPanel.threadId !== threadId) continue;
              try {
                const evt = JSON.parse(dataLine.slice(6));
                if (evt.type === "run:completed" || evt.type === "messages:updated" || evt.type === "messages:appended" || evt.type === "run:cancelled") {
                  const fresh = await api("/api/conversations/" + encodeURIComponent(threadId)).catch(() => null);
                  if (fresh && state.threadPanel.threadId === threadId) {
                    renderActiveTopForThreadPanel(fresh);
                  }
                }
              } catch (e) { /* ignore parse errors */ }
            }
          }
        }).catch(() => { /* aborted or failed; no-op */ });
      };

      const openThread = async (threadId, summary) => {
        try {
          const payload = await api("/api/conversations/" + encodeURIComponent(threadId));
          state.threadPanel.open = true;
          state.threadPanel.threadId = threadId;
          state.threadPanel.parentMessageId = (summary && summary.parentMessageId) || null;
          renderActiveTopForThreadPanel(payload);
          if (elements.threadPanel) elements.threadPanel.style.display = "flex";
          if (elements.threadPanelResize) elements.threadPanelResize.style.display = "block";
          const mainEl = document.querySelector(".main-chat");
          if (mainEl) mainEl.classList.add("has-thread");
          if (elements.threadPrompt) elements.threadPrompt.focus();
          try {
            history.replaceState(null, "", window.location.pathname + window.location.search + "#thread=" + encodeURIComponent(threadId));
          } catch (e) {}
          subscribeThreadPanelStream(threadId);
        } catch (e) {
          alert("Failed to load thread: " + (e && e.message ? e.message : "unknown"));
        }
      };

      const createAndOpenNewThread = async (parentMessageId) => {
        const conversationId = state.activeConversationId;
        if (!conversationId) return;
        try {
          const resp = await api(
            "/api/conversations/" + encodeURIComponent(conversationId) + "/threads",
            { method: "POST", body: JSON.stringify({ parentMessageId }) },
          );
          const summary = resp.thread;
          const list = state.threadsByParent[parentMessageId] || [];
          state.threadsByParent[parentMessageId] = list.concat([summary]);
          renderMessages(state.activeMessages, state.isStreaming);
          await openThread(summary.conversationId, summary);
        } catch (e) {
          const code = e && e.payload && e.payload.code;
          const msg = code || (e && e.message ? e.message : "unknown");
          alert("Failed to create thread: " + msg);
        }
      };

      const refreshThreads = async () => {
        const conversationId = state.activeConversationId;
        if (!conversationId) {
          state.threadsByParent = {};
          return;
        }
        try {
          const data = await api("/api/conversations/" + encodeURIComponent(conversationId) + "/threads");
          const grouped = {};
          (data.threads || []).forEach((t) => {
            if (!t.parentMessageId) return;
            (grouped[t.parentMessageId] = grouped[t.parentMessageId] || []).push(t);
          });
          state.threadsByParent = grouped;
        } catch (e) { /* keep existing */ }
      };

      const refreshActiveMessagesFromServer = async (conversationId) => {
        if (!conversationId) return;
        try {
          const payload = await api("/api/conversations/" + encodeURIComponent(conversationId));
          if (state.activeConversationId !== conversationId) return;
          let displayMessages = (payload.conversation && payload.conversation.messages) || [];
          const compactedHistory = payload.conversation && payload.conversation.compactedHistory;
          if (Array.isArray(compactedHistory) && compactedHistory.length > 0) {
            let dividerMsg = { role: "user", content: "", metadata: { isCompactionSummary: true } };
            const summaryMsg = displayMessages.find((m) => m.metadata && m.metadata.isCompactionSummary);
            if (summaryMsg) {
              dividerMsg = summaryMsg;
              displayMessages = displayMessages.filter((m) => m !== summaryMsg);
            }
            displayMessages = [].concat(compactedHistory, [dividerMsg], displayMessages);
          }
          state.activeMessages = displayMessages;
          await refreshThreads();
          renderMessages(state.activeMessages, false);
        } catch (e) {
          // Best-effort refresh — silent on failure
        }
      };

      const submitThreadReply = async (text, files) => {
        const threadId = state.threadPanel.threadId;
        const messageText = (text || "").trim();
        const filesToSend = Array.isArray(files) ? files : [];
        if (!threadId || (!messageText && filesToSend.length === 0)) return;

        // Build the optimistic user message with file ContentParts so the
        // panel can show attachments immediately, matching the main pane.
        let optimisticContent;
        if (filesToSend.length > 0) {
          optimisticContent = [{ type: "text", text: messageText }];
          for (const f of filesToSend) {
            optimisticContent.push({
              type: "file",
              data: URL.createObjectURL(f),
              mediaType: f.type,
              filename: f.name,
              _localBlob: f,
            });
          }
        } else {
          optimisticContent = messageText;
        }
        // Optimistic user + empty assistant placeholder — model:chunk events
        // from the POST /messages SSE stream will fill the assistant content.
        const optimisticAssistant = { role: "assistant", content: "", _streaming: true };
        state.threadPanel.messages = (state.threadPanel.messages || []).concat([
          { role: "user", content: optimisticContent },
          optimisticAssistant,
        ]);
        renderThreadPanelMessages();

        // Optimistic bump on the inline thread-row reply count in the main pane.
        if (state.threadPanel.parentMessageId) {
          const list = state.threadsByParent[state.threadPanel.parentMessageId] || [];
          const idx = list.findIndex((t) => t.conversationId === threadId);
          if (idx >= 0) {
            list[idx] = { ...list[idx], replyCount: (list[idx].replyCount || 0) + 1, lastReplyAt: Date.now() };
            state.threadsByParent[state.threadPanel.parentMessageId] = list;
            renderMessages(state.activeMessages, state.isStreaming);
          }
        }

        // Build the request body — FormData when files are present, JSON otherwise.
        let fetchOpts;
        if (filesToSend.length > 0) {
          const formData = new FormData();
          formData.append("message", messageText);
          for (const f of filesToSend) {
            formData.append("files", f, f.name);
          }
          fetchOpts = {
            method: "POST",
            headers: buildAuthHeaders(),
            credentials: state.tenantToken ? "omit" : "include",
            body: formData,
          };
        } else {
          fetchOpts = {
            method: "POST",
            headers: { ...buildAuthHeaders(), "Content-Type": "application/json" },
            credentials: state.tenantToken ? "omit" : "include",
            body: JSON.stringify({ message: messageText }),
          };
        }

        try {
          const resp = await fetch(
            "/api/conversations/" + encodeURIComponent(threadId) + "/messages",
            fetchOpts,
          );
          if (!resp.ok) throw new Error("HTTP " + resp.status);
          // Stream the SSE body — incrementally append model:chunk text to the
          // optimistic assistant message so the user sees tokens land live.
          if (resp.body) {
            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            let chunkCount = 0;
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              buffer = parseSseChunk(buffer, (eventName, payload) => {
                if (state.threadPanel.threadId !== threadId) return;
                if (eventName === "model:chunk") {
                  const chunk = String((payload && payload.content) || "");
                  if (!chunk) return;
                  chunkCount += 1;
                  optimisticAssistant._streaming = true;
                  optimisticAssistant.content = String(optimisticAssistant.content || "") + chunk;
                  renderThreadPanelMessages();
                }
              });
            }
            if (chunkCount === 0) {
              console.warn("[thread] no model:chunk events received — server may be buffering the response");
            } else {
              console.debug("[thread] streamed " + chunkCount + " chunks");
            }
          }
          // After the run completes, refetch so the panel reflects canonical
          // server state (including any tool sections/metadata we didn't
          // incrementally render here).
          const fresh = await api("/api/conversations/" + encodeURIComponent(threadId)).catch(() => null);
          if (fresh && state.threadPanel.threadId === threadId) {
            renderActiveTopForThreadPanel(fresh);
          }
        } catch (e) {
          // Drop the streaming placeholder if the post failed before producing any text.
          if (!optimisticAssistant.content) {
            state.threadPanel.messages = (state.threadPanel.messages || []).filter(
              (m) => m !== optimisticAssistant,
            );
            renderThreadPanelMessages();
          }
          alert("Failed to send reply: " + (e && e.message ? e.message : "unknown"));
        }
      };

      const renderHarnessView = () => {
        const msgs = Array.isArray(state.harnessMessages) ? state.harnessMessages : [];
        if (msgs.length === 0) {
          elements.messages.innerHTML = '<div class="harness-debug-view"><em>No harness messages yet — they appear after the first assistant turn.</em></div>';
          return;
        }
        const rows = msgs.map((m, i) => {
          const role = String(m.role || "?");
          const meta = m.metadata && typeof m.metadata === "object" ? m.metadata : null;
          const metaLine = meta
            ? "step=" + (meta.step != null ? meta.step : "-") +
              " runId=" + (meta.runId ? String(meta.runId).slice(0, 16) : "-") +
              " id=" + (meta.id ? String(meta.id).slice(0, 12) : "-")
            : "";
          let content = m.content;
          if (typeof content !== "string") content = JSON.stringify(content, null, 2);
          // Pretty-print JSON content where possible (assistant tool calls,
          // tool result arrays, etc.) so it's actually readable.
          const trimmed = content.trim();
          if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
            try { content = JSON.stringify(JSON.parse(trimmed), null, 2); } catch (_e) { /* leave as-is */ }
          }
          return '<div class="hd-msg role-' + escapeHtml(role) + '">' +
            '<div class="hd-role">#' + i + ' · ' + escapeHtml(role) + '</div>' +
            (metaLine ? '<div class="hd-meta">' + escapeHtml(metaLine) + '</div>' : '') +
            '<div>' + escapeHtml(content) + '</div>' +
            '</div>';
        }).join("");
        elements.messages.innerHTML = '<div class="harness-debug-view">' + rows + '</div>';
      };

      const updateViewToggleVisibility = () => {
        if (!elements.viewToggle) return;
        if (!state.verboseDev) {
          elements.viewToggle.hidden = true;
          return;
        }
        elements.viewToggle.hidden = false;
        elements.viewToggle.textContent = state.viewMode === "harness" ? "harness" : "user";
        elements.viewToggle.classList.toggle("is-harness", state.viewMode === "harness");
      };

      if (elements.viewToggle) {
        elements.viewToggle.addEventListener("click", () => {
          state.viewMode = state.viewMode === "harness" ? "user" : "harness";
          updateViewToggleVisibility();
          if (state.viewMode === "harness") {
            renderHarnessView();
          } else {
            renderMessages(state.activeMessages, state.isStreaming);
          }
        });
      }

      const renderMessages = (messages, isStreaming = false, options = {}) => {
        // In harness debug view, the user-facing renderer is bypassed.
        if (state.viewMode === "harness") {
          renderHarnessView();
          return;
        }
        const previousScrollTop = elements.messages.scrollTop;
        const shouldStickToBottom =
          options.forceScrollBottom === true || state.isMessagesPinnedToBottom;

        // Preserve open state of tool-activity disclosures across re-renders.
        // Track by message row index + disclosure index within the row.
        const openDisclosures = new Map();
        const prevCol = elements.messages.querySelector(".messages-column");
        if (prevCol) {
          prevCol.querySelectorAll(".tool-activity-disclosure[open]").forEach((el) => {
            const row = el.closest(".message-row");
            if (row) {
              const rowIdx = Array.from(prevCol.children).indexOf(row);
              const allInRow = row.querySelectorAll(".tool-activity-disclosure");
              const dIdx = Array.from(allInRow).indexOf(el);
              if (!openDisclosures.has(rowIdx)) openDisclosures.set(rowIdx, new Set());
              openDisclosures.get(rowIdx).add(dIdx);
            }
          });
        }

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
            const isSubagentCallback = m.metadata && m.metadata._subagentCallback;
            if (isSubagentCallback) {
              row.className = "message-row assistant";
              const wrap = document.createElement("div");
              wrap.className = "assistant-wrap";
              wrap.innerHTML = '<div class="assistant-avatar">' + agentInitial + '</div>';
              const content = document.createElement("div");
              content.className = "assistant-content subagent-callback-wrap";
              content.innerHTML = renderSubagentResult(m.content, m.metadata);
              wrap.appendChild(content);
              row.appendChild(wrap);
              return;
            }
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

            if (shouldRenderEmptyStreamingIndicator && !m._error) {
              content.appendChild(createThinkingIndicator(getThinkingStatusLabel(m)));
            } else {
              // Merge stored sections (persisted) with live sections (from
              // an active stream).  For normal messages only one source
              // exists; for liveOnly reconnects both contribute.
              const storedSections = (m.metadata && m.metadata.sections) || [];
              const liveSections = m._sections || [];
              const sections = liveSections.length > 0 && storedSections.length > 0
                ? storedSections.concat(liveSections)
                : liveSections.length > 0 ? liveSections : (storedSections.length > 0 ? storedSections : null);
              const pendingApprovals = Array.isArray(m._pendingApprovals) ? m._pendingApprovals : [];

              // Render persisted sections (interleaved text + tool blocks)
              if (sections && sections.length > 0) {
                sections.forEach((section) => {
                  if (section.type === "text") {
                    const textDiv = document.createElement("div");
                    textDiv.innerHTML = renderAssistantMarkdown(section.content);
                    content.appendChild(textDiv);
                  } else if (section.type === "tools") {
                    content.insertAdjacentHTML(
                      "beforeend",
                      renderToolActivity(section.content, [], []),
                    );
                  }
                });
              } else if (text && !(isStreaming && isLastAssistant)) {
                // Fallback for old messages without sections
                const parsed = extractToolActivity(text);
                content.innerHTML = renderAssistantMarkdown(parsed.content);
                const metadataToolActivity =
                  m.metadata && Array.isArray(m.metadata.toolActivity)
                    ? m.metadata.toolActivity
                    : [];
                if (metadataToolActivity.length > 0) {
                  content.insertAdjacentHTML(
                    "beforeend",
                    renderToolActivity(metadataToolActivity, [], []),
                  );
                }
              }
              // Streaming: always render current tools + text (regardless of sections)
              if (isStreaming && i === messages.length - 1) {
                if (m._currentTools && m._currentTools.length > 0) {
                  content.insertAdjacentHTML(
                    "beforeend",
                    renderToolActivity(m._currentTools, [], m._toolImages || []),
                  );
                }
                if (m._currentText) {
                  const textDiv = document.createElement("div");
                  textDiv.innerHTML = renderAssistantMarkdown(closeStreamingMarkdown(m._currentText));
                  content.appendChild(textDiv);
                }
              }
              // Render pending approvals ONCE at the end (single source of truth)
              if (pendingApprovals.length > 0) {
                content.insertAdjacentHTML(
                  "beforeend",
                  renderToolActivity([], pendingApprovals, m._toolImages || []),
                );
              }
              if (isStreaming && isLastAssistant && !hasPendingApprovals && !m._error) {
                const waitIndicator = document.createElement("div");
                waitIndicator.appendChild(createThinkingIndicator(getThinkingStatusLabel(m)));
                content.appendChild(waitIndicator);
              }
            }
            if (m._error) {
              const errorEl = document.createElement("div");
              errorEl.className = "message-error";
              errorEl.innerHTML = "<strong>Error</strong><br>" + escapeHtml(m._error);
              content.appendChild(errorEl);
            }
            wrap.appendChild(content);
            row.appendChild(wrap);
          } else if (m.metadata && m.metadata._subagentCallback) {
            row.className = "message-row assistant";
            const wrap = document.createElement("div");
            wrap.className = "assistant-wrap";
            wrap.innerHTML = '<div class="assistant-avatar">' + agentInitial + '</div>';
            const content = document.createElement("div");
            content.className = "assistant-content subagent-callback-wrap";
            content.innerHTML = renderSubagentResult(m.content, m.metadata);
            wrap.appendChild(content);
            row.appendChild(wrap);
          } else if (m.metadata && m.metadata.isCompactionSummary) {
            row.className = "message-row compaction-divider-row";
            const wrapper = document.createElement("div");
            wrapper.className = "compaction-wrapper";
            const divider = document.createElement("div");
            divider.className = "compaction-divider";
            divider.innerHTML = '<span class="compaction-divider-label">context compacted <span class="compaction-chevron">▸</span></span>';
            divider.style.cursor = "pointer";
            const summaryEl = document.createElement("div");
            summaryEl.className = "compaction-summary hidden";
            var rawContent = typeof m.content === "string" ? m.content : "";
            var cleanContent = rawContent.replace(/^\\[CONTEXT COMPACTION\\][^\\n]*\\n*/, "").replace(/<\\/?summary>/g, "").trim();
            summaryEl.innerHTML = renderAssistantMarkdown(cleanContent);
            divider.addEventListener("click", function() {
              var isHidden = summaryEl.classList.contains("hidden");
              summaryEl.classList.toggle("hidden");
              var chevron = divider.querySelector(".compaction-chevron");
              if (chevron) chevron.textContent = isHidden ? "▾" : "▸";
            });
            wrapper.appendChild(divider);
            wrapper.appendChild(summaryEl);
            row.appendChild(wrapper);
          } else {
            const bubble = document.createElement("div");
            bubble.className = "user-bubble";
            if (typeof m.content === "string") {
              bubble.textContent = m.content;
            } else if (Array.isArray(m.content)) {
              const textParts = m.content.filter(p => p.type === "text").map(p => p.text).join("");
              if (textParts) {
                const textEl = document.createElement("div");
                textEl.textContent = textParts;
                bubble.appendChild(textEl);
              }
              const fileParts = m.content.filter(p => p.type === "file");
              if (fileParts.length > 0) {
                const filesEl = document.createElement("div");
                filesEl.className = "user-file-attachments";
                fileParts.forEach(fp => {
                  if (fp.mediaType && fp.mediaType.startsWith("image/")) {
                    const img = document.createElement("img");
                    if (fp._localBlob) {
                      if (!fp._cachedUrl) fp._cachedUrl = URL.createObjectURL(fp._localBlob);
                      img.src = fp._cachedUrl;
                    } else if (fp.data && fp.data.startsWith("poncho-upload://")) {
                      img.src = "/api/uploads/" + encodeURIComponent(fp.data.replace("poncho-upload://", ""));
                    } else if (fp.data && (fp.data.startsWith("http://") || fp.data.startsWith("https://"))) {
                      img.src = fp.data;
                    } else if (fp.data) {
                      img.src = "data:" + fp.mediaType + ";base64," + fp.data;
                    }
                    img.alt = fp.filename || "image";
                    filesEl.appendChild(img);
                  } else {
                    const badge = document.createElement("span");
                    badge.className = "user-file-badge";
                    badge.textContent = "📎 " + (fp.filename || "file");
                    filesEl.appendChild(badge);
                  }
                });
                bubble.appendChild(filesEl);
              }
            }
            row.appendChild(bubble);
          }
          appendThreadAffordances(row, m);
          col.appendChild(row);
        });
        elements.messages.appendChild(col);

        // Restore open state of tool-activity disclosures
        if (openDisclosures.size > 0) {
          const rows = col.children;
          openDisclosures.forEach((dIdxSet, rowIdx) => {
            const row = rows[rowIdx];
            if (row) {
              const allD = row.querySelectorAll(".tool-activity-disclosure");
              dIdxSet.forEach((dIdx) => {
                if (allD[dIdx]) allD[dIdx].setAttribute("open", "");
              });
            }
          });
        }

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
        if (window._resetBrowserPanel) window._resetBrowserPanel();
        // Switching conversations always closes any open thread panel.
        closeThreadPanel();
        // Kick off conversation + todos + threads fetches in parallel — they
        // only need the id, so there's no reason to wait for the conversation.
        const conversationPromise = api("/api/conversations/" + encodeURIComponent(conversationId));
        const todosPromise = api("/api/conversations/" + encodeURIComponent(conversationId) + "/todos")
          .catch(() => ({ todos: [] }));
        const threadsPromise = api("/api/conversations/" + encodeURIComponent(conversationId) + "/threads")
          .catch(() => ({ threads: [] }));
        const payload = await conversationPromise;
        elements.chatTitle.textContent = payload.conversation.title;
        // Verbose dev (-v) only — server includes verboseDev: true and the
        // raw harness-message stream so we can offer a debug toggle.
        state.verboseDev = payload.verboseDev === true;
        state.harnessMessages = state.verboseDev && Array.isArray(payload.conversation._harnessMessages)
          ? payload.conversation._harnessMessages
          : null;
        updateViewToggleVisibility();
        // Merge own pending approvals + subagent pending approvals
        var allPendingApprovals = [].concat(
          payload.conversation.pendingApprovals || payload.pendingApprovals || [],
        );
        if (Array.isArray(payload.subagentPendingApprovals)) {
          payload.subagentPendingApprovals.forEach(function(sa) {
            var subIdShort = sa.subagentId && sa.subagentId.length > 12 ? sa.subagentId.slice(0, 12) + "..." : (sa.subagentId || "");
            allPendingApprovals.push({
              approvalId: sa.approvalId,
              tool: sa.tool,
              input: sa.input,
              _subagentId: sa.subagentId,
              _subagentLabel: "subagent " + subIdShort,
            });
          });
        }
        var displayMessages = payload.conversation.messages || [];
        var compactedHistory = payload.conversation.compactedHistory;
        if (Array.isArray(compactedHistory) && compactedHistory.length > 0) {
          var dividerMsg = { role: "user", content: "", metadata: { isCompactionSummary: true } };
          var summaryMsg = displayMessages.find(function(m) { return m.metadata && m.metadata.isCompactionSummary; });
          if (summaryMsg) {
            dividerMsg = summaryMsg;
            displayMessages = displayMessages.filter(function(m) { return m !== summaryMsg; });
          }
          displayMessages = [].concat(compactedHistory, [dividerMsg], displayMessages);
        }
        state.activeMessages = hydratePendingApprovals(
          displayMessages,
          allPendingApprovals,
        );
        state.contextTokens = typeof payload.conversation.contextTokens === "number" ? payload.conversation.contextTokens : 0;
        state.contextWindow = typeof payload.conversation.contextWindow === "number" ? payload.conversation.contextWindow : 0;

        // Track subagent relationship
        state.parentConversationId = payload.conversation.parentConversationId || null;
        state.viewingSubagentId = payload.conversation.parentConversationId ? conversationId : null;
        updateSubagentUi();

        // Fetch subagents -- from this conversation if it's a parent, or from the parent if it's a subagent.
        // Skip if we already have them cached for the same parent (avoids flicker when switching parent<->subagent).
        var subagentParentId = payload.conversation.parentConversationId || conversationId;
        if (state.subagentsParentId !== subagentParentId) {
          loadSubagents(subagentParentId);
        }

        const todosPayload = await todosPromise;
        state.todos = todosPayload.todos || [];
        _autoCollapseTodos();
        renderTodoPanel();

        // Group thread summaries by parentMessageId for inline rendering.
        try {
          const threadsPayload = await threadsPromise;
          const grouped = {};
          (threadsPayload.threads || []).forEach((t) => {
            if (!t.parentMessageId) return;
            (grouped[t.parentMessageId] = grouped[t.parentMessageId] || []).push(t);
          });
          state.threadsByParent = grouped;
        } catch (e) {
          state.threadsByParent = {};
        }

        updateContextRing();
        var willStream = !!payload.hasActiveRun;
        var hasSendMessageStream = state.activeStreamConversationId === conversationId && state._activeStreamMessages;
        if (hasSendMessageStream) {
          state.activeMessages = state._activeStreamMessages;
          renderMessages(state.activeMessages, true, { forceScrollBottom: true });
        } else {
          renderMessages(state.activeMessages, willStream, { forceScrollBottom: true });
        }
        // If the URL has #thread=<id>, reopen that thread panel after main render.
        try {
          const hash = window.location.hash || "";
          const m = hash.match(/thread=([^&]+)/);
          if (m && m[1]) {
            const threadId = decodeURIComponent(m[1]);
            // Find the matching summary so we can pin parentMessageId.
            let summary = null;
            for (const k of Object.keys(state.threadsByParent)) {
              const found = (state.threadsByParent[k] || []).find((t) => t.conversationId === threadId);
              if (found) { summary = found; break; }
            }
            if (summary) openThread(threadId, summary);
          }
        } catch (e) { /* ignore */ }
        if (!state.viewingSubagentId) {
          elements.prompt.focus();
        }
        if (willStream && !hasSendMessageStream) {
          setStreaming(true);
          streamConversationEvents(conversationId, { liveOnly: false }).finally(() => {
            if (state.activeConversationId === conversationId) {
              pollUntilRunIdle(conversationId);
            }
          });
        } else if (willStream) {
          setStreaming(true);
        } else if (payload.needsContinuation && !payload.conversation.parentConversationId) {
          console.log("[poncho] Detected orphaned continuation for", conversationId, "— auto-resuming via /continue");
          (async () => {
            try {
              setStreaming(true);
              state.activeStreamConversationId = conversationId;
              var localMsgs = state.activeMessages || [];
              var contAssistant = {
                role: "assistant",
                content: "",
                _sections: [],
                _currentText: "",
                _currentTools: [],
                _toolImages: [],
                _activeActivities: [],
                _pendingApprovals: [],
                metadata: { toolActivity: [] }
              };
              localMsgs.push(contAssistant);
              state.activeMessages = localMsgs;
              state._activeStreamMessages = localMsgs;
              renderMessages(localMsgs, true);

              var _contHeaders2 = state.tenantToken
                ? { "Content-Type": "application/json", "Authorization": "Bearer " + state.tenantToken }
                : { "Content-Type": "application/json", "x-csrf-token": state.csrfToken };
              var contResp = await fetch(
                "/api/conversations/" + encodeURIComponent(conversationId) + "/continue",
                {
                  method: "POST",
                  credentials: state.tenantToken ? "omit" : "include",
                  headers: _contHeaders2,
                },
              );
              if (!contResp.ok || !contResp.body) {
                // Server already claimed the continuation (safety net). Poll for completion.
                await pollUntilRunIdle(conversationId);
                setStreaming(false);
                renderMessages(localMsgs, false);
                return;
              }

              var contReader = contResp.body.getReader();
              var contDecoder = new TextDecoder();
              var contBuffer = "";
              var gotStreamEnd = false;
              while (true) {
                var chunk = await contReader.read();
                if (chunk.done) break;
                contBuffer += contDecoder.decode(chunk.value, { stream: true });
                contBuffer = parseSseChunk(contBuffer, function(evtName, evtPayload) {
                  if (evtName === "stream:end") {
                    gotStreamEnd = true;
                    return;
                  }
                  if (evtName === "model:chunk" && evtPayload.content) {
                    contAssistant.content = (contAssistant.content || "") + evtPayload.content;
                    contAssistant._currentText += evtPayload.content;
                  }
                  if (evtName === "tool:started") {
                    if (contAssistant._currentText) {
                      contAssistant._sections.push({ type: "text", content: contAssistant._currentText });
                      contAssistant._currentText = "";
                    }
                    contAssistant._currentTools.push("- start " + _TK + evtPayload.tool + _TK);
                  }
                  if (evtName === "tool:completed") {
                    contAssistant._currentTools.push(buildToolDoneText(evtPayload));
                  }
                  if (evtName === "tool:error") {
                    contAssistant._currentTools.push("- error " + _TK + evtPayload.tool + _TK + ": " + evtPayload.error);
                  }
                  if (evtName === "run:completed" || evtName === "run:error" || evtName === "run:cancelled") {
                    if (contAssistant._currentTools.length > 0) {
                      contAssistant._sections.push({ type: "tools", content: contAssistant._currentTools });
                      contAssistant._currentTools = [];
                    }
                    if (contAssistant._currentText) {
                      contAssistant._sections.push({ type: "text", content: contAssistant._currentText });
                      contAssistant._currentText = "";
                    }
                    contAssistant._activeActivities = [];
                    if (evtName === "run:error") {
                      contAssistant._error = evtPayload.error?.message || "Something went wrong";
                    }
                  }
                  renderMessages(localMsgs, true);
                });
              }
              if (gotStreamEnd) {
                // Safety net already claimed it. Poll for completion.
                await pollUntilRunIdle(conversationId);
              }
              setStreaming(false);
              renderMessages(localMsgs, false);
              await loadConversations();
            } catch (contErr) {
              console.error("[poncho] Auto-continuation failed:", contErr);
              setStreaming(false);
              await loadConversation(conversationId).catch(function() {});
            } finally {
              state.activeStreamConversationId = null;
              state._activeStreamMessages = null;
            }
          })();
        }
      };

      const renameConversation = async (conversationId, title) => {
        const payload = await api("/api/conversations/" + encodeURIComponent(conversationId), {
          method: "PATCH",
          body: JSON.stringify({ title }),
        });
        elements.chatTitle.textContent = payload.conversation.title;
        const entry = state.conversations.find(c => c.conversationId === conversationId);
        if (entry) entry.title = payload.conversation.title;
        renderConversationList();
      };

      const beginTitleEdit = () => {
        if (!state.activeConversationId) return;
        if (elements.chatTitle.querySelector("input")) return;

        const current = elements.chatTitle.textContent || "";
        elements.chatTitle.textContent = "";

        const input = document.createElement("input");
        input.type = "text";
        input.className = "topbar-title-input";
        input.value = current;

        const sizer = document.createElement("span");
        sizer.style.cssText = "position:absolute;visibility:hidden;white-space:pre;font:inherit;font-weight:inherit;letter-spacing:inherit;padding:0 6px;";
        const autoSize = () => {
          sizer.textContent = input.value || " ";
          elements.chatTitle.appendChild(sizer);
          input.style.width = sizer.offsetWidth + 12 + "px";
          sizer.remove();
        };

        elements.chatTitle.appendChild(input);
        autoSize();
        input.focus();
        input.select();
        input.addEventListener("input", autoSize);

        const commit = async () => {
          const newTitle = input.value.trim();
          if (input._committed) return;
          input._committed = true;

          if (newTitle && newTitle !== current) {
            try {
              await renameConversation(state.activeConversationId, newTitle);
            } catch {
              elements.chatTitle.textContent = current;
            }
          } else {
            elements.chatTitle.textContent = current;
          }
        };

        input.addEventListener("blur", commit);
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { e.preventDefault(); input.blur(); }
          if (e.key === "Escape") { input.value = current; input.blur(); }
        });
      };

      // Fetch the full conversation and sync UI state. Extracted so both
      // poll loops can call it only when the cheap /status endpoint shows
      // something has actually changed.
      const refetchConversationAndRender = async (conversationId, streaming) => {
        const payload = await api("/api/conversations/" + encodeURIComponent(conversationId));
        if (state.activeConversationId !== conversationId || !payload.conversation) return payload;
        var allPending = [].concat(payload.conversation.pendingApprovals || []);
        if (Array.isArray(payload.subagentPendingApprovals)) {
          payload.subagentPendingApprovals.forEach(function(sa) {
            var subIdShort = sa.subagentId && sa.subagentId.length > 12 ? sa.subagentId.slice(0, 12) + "..." : (sa.subagentId || "");
            allPending.push({
              approvalId: sa.approvalId,
              tool: sa.tool,
              input: sa.input,
              _subagentId: sa.subagentId,
              _subagentLabel: "subagent " + subIdShort,
            });
          });
        }
        state.activeMessages = hydratePendingApprovals(
          payload.conversation.messages || [],
          allPending,
        );
        if (typeof payload.conversation.contextTokens === "number") {
          state.contextTokens = payload.conversation.contextTokens;
        }
        if (typeof payload.conversation.contextWindow === "number" && payload.conversation.contextWindow > 0) {
          state.contextWindow = payload.conversation.contextWindow;
        }
        // Keep harness debug view fresh on refetches in -v mode.
        state.verboseDev = payload.verboseDev === true;
        state.harnessMessages = state.verboseDev && Array.isArray(payload.conversation._harnessMessages)
          ? payload.conversation._harnessMessages
          : null;
        updateViewToggleVisibility();
        updateContextRing();
        renderMessages(state.activeMessages, streaming);
        return payload;
      };

      const pollUntilRunIdle = (conversationId) => {
        let lastUpdatedAt = 0;
        let lastMessageCount = -1;
        let lastPendingSignature = "";
        const poll = async () => {
          if (state.activeConversationId !== conversationId) return;
          try {
            // Cheap status check — no data blob, no archive, no messages.
            const status = await api("/api/conversations/" + encodeURIComponent(conversationId) + "/status");
            if (state.activeConversationId !== conversationId) return;
            const pendingSignature =
              (status.hasPendingApprovals ? 1 : 0) + ":" + (status.subagentPendingApprovalsCount || 0);
            const changed =
              status.updatedAt > lastUpdatedAt ||
              status.messageCount !== lastMessageCount ||
              pendingSignature !== lastPendingSignature;
            if (changed) {
              lastUpdatedAt = status.updatedAt;
              lastMessageCount = status.messageCount;
              lastPendingSignature = pendingSignature;
              await refetchConversationAndRender(conversationId, status.hasActiveRun);
              if (state.activeConversationId !== conversationId) return;
            }
            if (status.hasActiveRun || status.hasRunningSubagents) {
              if (status.hasActiveRun && window._connectBrowserStream) window._connectBrowserStream();
              setTimeout(poll, 2000);
            } else {
              setStreaming(false);
              renderMessages(state.activeMessages, false);
            }
          } catch {
            setStreaming(false);
            renderMessages(state.activeMessages, false);
          }
        };
        setTimeout(poll, 1500);
      };

      const pollForSubagentResults = (conversationId) => {
        if (state.subagentPollInFlight[conversationId]) return;
        state.subagentPollInFlight[conversationId] = true;
        let lastMessageCount = state.activeMessages ? state.activeMessages.length : 0;
        let lastUpdatedAt = 0;
        let lastPendingSignature = "";
        let streamingCallback = false;
        const poll = async () => {
          if (state.activeConversationId !== conversationId) {
            delete state.subagentPollInFlight[conversationId];
            return;
          }
          try {
            const status = await api("/api/conversations/" + encodeURIComponent(conversationId) + "/status");
            if (state.activeConversationId !== conversationId) return;
            const pendingSignature =
              (status.hasPendingApprovals ? 1 : 0) + ":" + (status.subagentPendingApprovalsCount || 0);
            const changed =
              status.messageCount > lastMessageCount ||
              status.updatedAt > lastUpdatedAt ||
              pendingSignature !== lastPendingSignature;
            if (changed) {
              lastMessageCount = status.messageCount;
              lastUpdatedAt = status.updatedAt;
              lastPendingSignature = pendingSignature;
              await refetchConversationAndRender(conversationId, status.hasActiveRun || status.hasRunningSubagents);
              if (state.activeConversationId !== conversationId) return;
            }
            if (status.hasActiveRun && !streamingCallback) {
              // The parent callback run is active — subscribe to the SSE
              // event stream so the response streams live instead of only
              // appearing after the run finishes.
              streamingCallback = true;
              // Refetch so the injected subagent result message is visible
              // before we start streaming the assistant's response.
              await refetchConversationAndRender(conversationId, true);
              if (state.activeConversationId !== conversationId) {
                delete state.subagentPollInFlight[conversationId];
                return;
              }
              lastMessageCount = status.messageCount;
              lastUpdatedAt = status.updatedAt;
              setStreaming(true);
              try {
                await streamConversationEvents(conversationId, { liveOnly: true });
              } catch {}
              streamingCallback = false;
              // After the stream ends, update counts and resume polling
              // to catch any remaining subagent work.
              const fresh = await api("/api/conversations/" + encodeURIComponent(conversationId) + "/status").catch(function() { return null; });
              if (fresh) {
                lastMessageCount = fresh.messageCount;
                lastUpdatedAt = fresh.updatedAt;
              }
              if (state.activeConversationId !== conversationId) {
                delete state.subagentPollInFlight[conversationId];
                return;
              }
              setTimeout(poll, 1000);
            } else if (status.hasActiveRun || status.hasRunningSubagents) {
              setTimeout(poll, 2000);
            } else {
              renderMessages(state.activeMessages, false);
              await loadConversations();
              delete state.subagentPollInFlight[conversationId];
            }
          } catch {
            // Polling error; retry
            setTimeout(poll, 5000);
          }
        };
        setTimeout(poll, 3000);
      };

      const streamConversationEvents = (conversationId, options) => {
        const liveOnly = options && options.liveOnly;
        return new Promise((resolve) => {
          const localMessages = state.activeMessages || [];
          let _rafId = 0;
          const renderIfActiveConversation = (streaming) => {
            if (state.activeConversationId !== conversationId) {
              return;
            }
            state.activeMessages = localMessages;
            if (!streaming) {
              if (_rafId) { cancelAnimationFrame(_rafId); _rafId = 0; }
              renderMessages(localMessages, false);
              return;
            }
            if (!_rafId) {
              _rafId = requestAnimationFrame(() => {
                _rafId = 0;
                if (state.activeConversationId !== conversationId) return;
                renderMessages(localMessages, true);
              });
            }
          };
          let assistantMessage = localMessages[localMessages.length - 1];
          if (!assistantMessage || assistantMessage.role !== "assistant") {
            assistantMessage = {
              role: "assistant",
              content: "",
              _sections: [],
              _currentText: "",
              _currentTools: [],
              _toolImages: [],
              _pendingApprovals: [],
              _activeActivities: [],
              metadata: { toolActivity: [] },
            };
            localMessages.push(assistantMessage);
            state.activeMessages = localMessages;
          }
          if (liveOnly) {
            // Live-only mode: keep metadata.sections intact (the stored
            // base content) and start _sections empty so it only collects
            // NEW sections from live events.  The renderer merges both.
            assistantMessage._sections = [];
            assistantMessage._currentText = "";
            assistantMessage._currentTools = [];
            if (!assistantMessage._activeActivities) assistantMessage._activeActivities = [];
            if (!assistantMessage._pendingApprovals) assistantMessage._pendingApprovals = [];
            if (!assistantMessage.metadata) assistantMessage.metadata = {};
            if (!assistantMessage.metadata.toolActivity) assistantMessage.metadata.toolActivity = [];
          } else {
            // Full replay mode: reset transient state so replayed events
            // rebuild from scratch (the buffer has the full event history).
            assistantMessage.content = "";
            assistantMessage._sections = [];
            assistantMessage._currentText = "";
            assistantMessage._currentTools = [];
            assistantMessage._activeActivities = [];
            assistantMessage._pendingApprovals = [];
            assistantMessage.metadata = { toolActivity: [] };
          }

          const url = "/api/conversations/" + encodeURIComponent(conversationId) + "/events" + (liveOnly ? "?live_only=true" : "");
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
                    if (eventName === "run:started") {
                      if (typeof payload.contextWindow === "number" && payload.contextWindow > 0) {
                        state.contextWindow = payload.contextWindow;
                      }
                    }
                    if (eventName === "model:chunk") {
                      const chunk = String(payload.content || "");
                      if (chunk.length > 0) clearResolvedApprovals(assistantMessage);
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
                    if (eventName === "model:response") {
                      if (typeof payload.usage?.input === "number") {
                        state.contextTokens = payload.usage.input;
                        updateContextRing();
                      }
                    }
                    if (eventName === "tool:generating") {
                      const toolName = payload.tool || "tool";
                      if (!Array.isArray(assistantMessage._activeActivities)) {
                        assistantMessage._activeActivities = [];
                      }
                      assistantMessage._activeActivities.push({
                        kind: "generating",
                        tool: toolName,
                        label: "Preparing " + toolName,
                      });
                      if (assistantMessage._currentText.length > 0) {
                        assistantMessage._sections.push({
                          type: "text",
                          content: assistantMessage._currentText,
                        });
                        assistantMessage._currentText = "";
                      }
                      const prepText =
                        "- preparing " + _TK + toolName + _TK;
                      assistantMessage._currentTools.push(prepText);
                      renderIfActiveConversation(true);
                    }
                    if (eventName === "tool:started") {
                      clearResolvedApprovals(assistantMessage);
                      const toolName = payload.tool || "tool";
                      removeActiveActivityForTool(assistantMessage, toolName);
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
                      const prepPrefix = "- preparing " + _TK + toolName + _TK;
                      const prepToolIdx = assistantMessage._currentTools.indexOf(prepPrefix);
                      if (prepToolIdx >= 0) {
                        assistantMessage._currentTools.splice(prepToolIdx, 1);
                      }
                      const detail =
                        startedActivity && typeof startedActivity.detail === "string"
                          ? startedActivity.detail.trim()
                          : "";
                      const toolText =
                        "- start " + _TK +
                        toolName +
                        _TK +
                        (detail ? " (" + detail + ")" : "");
                      assistantMessage._currentTools.push(toolText);
                      // Don't persist "start" to metadata — only "done" gets persisted
                      renderIfActiveConversation(true);
                    }
                    if (eventName === "tool:completed") {
                      const toolName = payload.tool || "tool";
                      removeActiveActivityForTool(assistantMessage, toolName);
                      // Remove the "start" entry from _currentTools — completed replaces it
                      const startPrefix = "- start " + _TK + toolName + _TK;
                      const startToolIdx = assistantMessage._currentTools.findIndex((t) => t.startsWith(startPrefix));
                      if (startToolIdx >= 0) assistantMessage._currentTools.splice(startToolIdx, 1);

                      const toolText = buildToolDoneText(payload);
                      assistantMessage._currentTools.push(toolText);
                      assistantMessage.metadata.toolActivity.push(toolText);
                      if (typeof payload.outputTokenEstimate === "number" && payload.outputTokenEstimate > 0 && state.contextWindow > 0) {
                        state.contextTokens += payload.outputTokenEstimate;
                        updateContextRing();
                      }
                      if (toolName !== "todo_list" && toolName.startsWith("todo_") && payload.output && typeof payload.output === "object" && Array.isArray(payload.output.todos)) {
                        state.todos = payload.output.todos;
                        _autoCollapseTodos(true);
                        renderTodoPanel();
                      }
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
                        "- error " + _TK +
                        toolName +
                        _TK +
                        (detail ? " (" + detail + ")" : "") +
                        ": " +
                        errorMsg;
                      assistantMessage._currentTools.push(toolText);
                      assistantMessage.metadata.toolActivity.push(toolText);
                      renderIfActiveConversation(true);
                    }
                    if (eventName === "compaction:started") {
                      ensureActiveActivities(assistantMessage).push({
                        kind: "compaction",
                        tool: "__compaction__",
                        label: "Compacting context",
                      });
                      renderIfActiveConversation(true);
                    }
                    if (eventName === "compaction:completed") {
                      didCompact = true;
                      removeActiveActivityForTool(assistantMessage, "__compaction__");
                      if (typeof payload.tokensAfter === "number") {
                        state.contextTokens = payload.tokensAfter;
                        updateContextRing();
                      }
                      renderIfActiveConversation(true);
                    }
                    if (eventName === "browser:status" && payload.active) {
                      if (window._connectBrowserStream) window._connectBrowserStream();
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
                        "- approval required " + _TK +
                        toolName +
                        _TK +
                        (detail ? " (" + detail + ")" : "");
                      assistantMessage._currentTools.push(toolText);
                      assistantMessage.metadata.toolActivity.push(toolText);
                      const approvalId =
                        typeof payload.approvalId === "string" ? payload.approvalId : "";
                      if (approvalId) {
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
                            input: payload.input ?? {},
                            state: "pending",
                          });
                        }
                      }
                      renderIfActiveConversation(true);
                    }
                    if (eventName === "tool:approval:granted") {
                      const approvalId =
                        typeof payload.approvalId === "string" ? payload.approvalId : "";
                      var grantedTool = "tool";
                      if (approvalId && Array.isArray(assistantMessage._pendingApprovals)) {
                        var match = assistantMessage._pendingApprovals.find((r) => r.approvalId === approvalId);
                        if (match && match.tool) grantedTool = match.tool;
                        assistantMessage._pendingApprovals = assistantMessage._pendingApprovals.filter(
                          (req) => req.approvalId !== approvalId || req.state === "resolved",
                        );
                      }
                      const toolText = "- done " + _TK + grantedTool + _TK + " (approved)";
                      assistantMessage._currentTools.push(toolText);
                      assistantMessage.metadata.toolActivity.push(toolText);
                      renderIfActiveConversation(true);
                    }
                    if (eventName === "tool:approval:denied") {
                      const approvalId =
                        typeof payload.approvalId === "string" ? payload.approvalId : "";
                      var deniedTool = "tool";
                      if (approvalId && Array.isArray(assistantMessage._pendingApprovals)) {
                        var match2 = assistantMessage._pendingApprovals.find((r) => r.approvalId === approvalId);
                        if (match2 && match2.tool) deniedTool = match2.tool;
                        assistantMessage._pendingApprovals = assistantMessage._pendingApprovals.filter(
                          (req) => req.approvalId !== approvalId || req.state === "resolved",
                        );
                      }
                      const toolText = "- error " + _TK + deniedTool + _TK + ": denied";
                      assistantMessage._currentTools.push(toolText);
                      assistantMessage.metadata.toolActivity.push(toolText);
                      renderIfActiveConversation(true);
                    }
                    if (eventName === "subagent:spawned" || eventName === "subagent:completed" || eventName === "subagent:error" || eventName === "subagent:stopped" || eventName === "subagent:approval_needed") {
                      if (state.activeConversationId === conversationId || state.subagentsParentId === conversationId) {
                        loadSubagents(conversationId, true);
                      }
                    }
                    if (eventName === "subagent:approval_needed" && payload.approvalId && payload.tool) {
                      var subIdShort = payload.subagentId && payload.subagentId.length > 12 ? payload.subagentId.slice(0, 12) + "..." : (payload.subagentId || "");
                      var approvalReq = {
                        approvalId: payload.approvalId,
                        tool: payload.tool,
                        input: payload.input || {},
                        _subagentId: payload.subagentId,
                        _subagentLabel: "subagent " + subIdShort,
                      };
                      if (!assistantMessage._pendingApprovals) assistantMessage._pendingApprovals = [];
                      assistantMessage._pendingApprovals.push(approvalReq);
                      // Show orange dot on parent conversation in sidebar
                      var parentConv = state.conversations.find(function(c) { return c.conversationId === conversationId; });
                      if (parentConv) parentConv.hasPendingApprovals = true;
                      renderConversationList();
                      renderIfActiveConversation(true);
                    }
                    if (eventName === "subagent:completed" || eventName === "subagent:error" || eventName === "subagent:stopped") {
                      if (payload.subagentId && assistantMessage._pendingApprovals) {
                        assistantMessage._pendingApprovals = assistantMessage._pendingApprovals.filter(
                          function(req) { return req._subagentId !== payload.subagentId; }
                        );
                        // Clear orange dot if no more pending approvals
                        var parentConv2 = state.conversations.find(function(c) { return c.conversationId === conversationId; });
                        if (parentConv2 && (!assistantMessage._pendingApprovals || assistantMessage._pendingApprovals.length === 0)) {
                          parentConv2.hasPendingApprovals = false;
                        }
                        renderConversationList();
                        renderIfActiveConversation(true);
                      }
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
                    if (eventName === "run:cancelled") {
                      assistantMessage._activeActivities = [];
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
                      const errMsg =
                        payload.error?.message || "Something went wrong";
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
              if (_rafId) { cancelAnimationFrame(_rafId); _rafId = 0; }
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
        if (window._resetBrowserPanel) window._resetBrowserPanel();
        const shouldLoadConversation = options.loadConversation !== false;
        const payload = await api("/api/conversations", {
          method: "POST",
          body: JSON.stringify(title ? { title } : {})
        });
        state.activeConversationId = payload.conversation.conversationId;
        state.viewingSubagentId = null;
        state.parentConversationId = null;
        state.subagents = [];
        state.subagentsParentId = null;
        state.confirmDeleteId = null;
        updateSubagentUi();
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
        const canStop = value && !!state.activeStreamRunId;
        elements.send.disabled = value ? !canStop : false;
        elements.send.innerHTML = value ? stopIconMarkup : sendIconMarkup;
        elements.send.classList.toggle("stop-mode", value);
        if (elements.sendBtnWrapper) {
          elements.sendBtnWrapper.classList.toggle("stop-mode", value);
        }
        elements.send.setAttribute("aria-label", value ? "Stop response" : "Send message");
        elements.send.setAttribute(
          "title",
          value ? (canStop ? "Stop response" : "Starting response...") : "Send message",
        );
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

        if (toolName === "spawn_subagent") {
          const task = getStringInputField(input, "task");
          const short = task && task.length > 50 ? task.slice(0, 47) + "..." : task;
          return {
            kind: "tool",
            tool: toolName,
            label: "Spawning subagent" + (short ? ": " + short : ""),
            detail: short ? "task: " + short : "",
          };
        }

        if (toolName === "list_subagents") {
          return {
            kind: "tool",
            tool: toolName,
            label: "Listing subagents",
            detail: "",
          };
        }

        if (toolName === "message_subagent" || toolName === "stop_subagent") {
          const subId = getStringInputField(input, "subagent_id");
          const short = subId && subId.length > 12 ? subId.slice(0, 12) + "..." : subId;
          return {
            kind: "tool",
            tool: toolName,
            label: toolName.replace(/_/g, " ") + (short ? " (" + short + ")" : ""),
            detail: short ? "subagent: " + short : "",
          };
        }

        if (toolName === "bash") {
          const cmd = getStringInputField(input, "command");
          const short = cmd && cmd.length > 80 ? cmd.slice(0, 77) + "..." : cmd;
          return {
            kind: "tool",
            tool: toolName,
            label: short ? "$ " + short : "Running bash",
            detail: short || "",
          };
        }

        if (toolName === "web_search") {
          const query = getStringInputField(input, "query");
          const short = query && query.length > 60 ? query.slice(0, 57) + "..." : query;
          return {
            kind: "tool",
            tool: toolName,
            label: "Searching" + (short ? " \\x22" + short + "\\x22" : ""),
            detail: short ? "\\x22" + short + "\\x22" : "",
          };
        }

        if (toolName === "web_fetch") {
          const url = getStringInputField(input, "url");
          const short = url && url.length > 60 ? url.slice(0, 57) + "..." : url;
          return {
            kind: "tool",
            tool: toolName,
            label: "Fetching " + (short || "page"),
            detail: url || "",
          };
        }

        // Generic: pick the first short string value from input
        var genericDetail = "";
        for (var gk in input) {
          var gv = input[gk];
          if (typeof gv === "string" && gv.length > 0) {
            genericDetail = gv.length > 80 ? gv.slice(0, 77) + "..." : gv;
            break;
          }
        }
        if (genericDetail) genericDetail = genericDetail.replace(/\\n/g, " ");
        return {
          kind: "tool",
          tool: toolName,
          label: "Running " + toolName + (genericDetail ? ": " + genericDetail : ""),
          detail: genericDetail,
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
          const startPrefix = "- start " + _TK;
          for (let idx = assistantMessage._currentTools.length - 1; idx >= 0; idx -= 1) {
            const item = String(assistantMessage._currentTools[idx] || "");
            if (item.startsWith(startPrefix)) {
              const rest = item.slice(startPrefix.length);
              const endIdx = rest.indexOf(_TK);
              const toolName = (endIdx >= 0 ? rest.slice(0, endIdx) : rest).trim();
              if (toolName) {
                return "Running " + toolName + " tool";
              }
            }
          }
        }
        return "";
      };

      const autoResizePrompt = () => {
        const el = elements.prompt;
        el.style.height = "auto";
        const scrollHeight = el.scrollHeight;
        const nextHeight = Math.min(scrollHeight, 200);
        el.style.height = nextHeight + "px";
        el.style.overflowY = scrollHeight > 200 ? "auto" : "hidden";
      };

      const stopActiveRun = async () => {
        const stopRunId = state.activeStreamRunId;
        if (!stopRunId) return;
        const conversationId = state.activeStreamConversationId || state.activeConversationId;
        if (!conversationId) return;
        // Disable the stop button immediately so the user sees feedback.
        state.activeStreamRunId = null;
        setStreaming(state.isStreaming);
        // Signal the server to cancel the run. The server will emit
        // run:cancelled through the still-open SSE stream, which
        // sendMessage() processes naturally – the stream ends on its own
        // and cleanup happens in one finally block. No fetch abort needed.
        try {
          await api(
            "/api/conversations/" + encodeURIComponent(conversationId) + "/stop",
            {
              method: "POST",
              body: JSON.stringify({ runId: stopRunId }),
            },
          );
        } catch (e) {
          console.warn("Failed to stop conversation run:", e);
          // Fallback: abort the local fetch so the UI at least stops.
          const abortController = state.activeStreamAbortController;
          if (abortController && !abortController.signal.aborted) {
            abortController.abort();
          }
        }
      };

      const renderAttachmentPreview = () => {
        const el = elements.attachmentPreview;
        if (state.pendingFiles.length === 0) {
          el.style.display = "none";
          el.innerHTML = "";
          return;
        }
        el.style.display = "flex";
        el.innerHTML = state.pendingFiles.map((f, i) => {
          const isImage = f.type.startsWith("image/");
          const thumbHtml = isImage
            ? '<img src="' + URL.createObjectURL(f) + '" alt="" />'
            : '<span class="file-icon">📎</span>';
          return '<div class="attachment-chip" data-idx="' + i + '">'
            + thumbHtml
            + '<span class="filename">' + escapeHtml(f.name) + '</span>'
            + '<span class="remove-attachment" data-idx="' + i + '">&times;</span>'
            + '</div>';
        }).join("");
      };

      const addFiles = (fileList) => {
        for (const f of fileList) {
          if (f.size > 25 * 1024 * 1024) {
            alert("File too large: " + f.name + " (max 25MB)");
            continue;
          }
          state.pendingFiles.push(f);
        }
        renderAttachmentPreview();
      };

      const sendMessage = async (text) => {
        var messageText = (text || "").trim();
        if (!messageText || state.isStreaming) {
          return;
        }
        // Check if it's a skill slash command
        if (state.slashCommands && messageText.startsWith("/")) {
          var cmdParts = messageText.split(/\s+/);
          var cmdName = cmdParts[0].toLowerCase();
          var matchedSkill = state.slashCommands.find(function(c) { return c.command === cmdName && c.type === "skill"; });
          if (matchedSkill) {
            var skillArgs = messageText.slice(cmdParts[0].length).trim();
            messageText = "Activate the " + matchedSkill.command.slice(1) + " skill" + (skillArgs ? " and " + skillArgs : "");
          }
        }
        if (messageText.toLowerCase().startsWith("/compact")) {
          const focusHint = messageText.slice("/compact".length).trim() || undefined;
          const conversationId = state.activeConversationId;
          if (!conversationId) {
            alert("No active conversation to compact.");
            return;
          }
          const input = elements.prompt;
          input.disabled = true;
          input.value = "Compacting context\u2026";
          input.style.color = "var(--accent)";
          input.style.animation = "compacting-pulse 1.5s ease-in-out infinite";
          try {
            const data = await api(
              "/api/conversations/" + encodeURIComponent(conversationId) + "/compact",
              {
                method: "POST",
                body: JSON.stringify(focusHint ? { instructions: focusHint } : {}),
              },
            );
            if (data.compacted) {
              await loadConversation(conversationId);
            } else {
              alert(data.warning || "Nothing to compact.");
            }
          } catch (e) {
            alert("Compact failed: " + (e.message || e));
          } finally {
            input.style.color = "";
            input.style.animation = "";
            input.disabled = false;
            input.value = "";
            input.focus();
          }
          return;
        }
        const filesToSend = [...state.pendingFiles];
        state.pendingFiles = [];
        renderAttachmentPreview();
        let userContent;
        if (filesToSend.length > 0) {
          userContent = [{ type: "text", text: messageText }];
          for (const f of filesToSend) {
            userContent.push({
              type: "file",
              data: URL.createObjectURL(f),
              mediaType: f.type,
              filename: f.name,
              _localBlob: f,
            });
          }
        } else {
          userContent = messageText;
        }
        const localMessages = [...(state.activeMessages || []), { role: "user", content: userContent }];
        let assistantMessage = {
          role: "assistant",
          content: "",
          _sections: [],
          _currentText: "",
          _currentTools: [],
          _toolImages: [],
          _activeActivities: [],
          _pendingApprovals: [],
          metadata: { toolActivity: [] }
        };
        localMessages.push(assistantMessage);
        state.activeMessages = localMessages;
        state._activeStreamMessages = localMessages;
        renderMessages(localMessages, true, { forceScrollBottom: true });
        let conversationId = state.activeConversationId;
        let didCompact = false;
        const streamAbortController = new AbortController();
        state.activeStreamAbortController = streamAbortController;
        state.activeStreamRunId = null;
        let _rafId = 0;
        let _pendingSubagentsConversation = null;
        setStreaming(true);
        try {
          if (!conversationId) {
            conversationId = await createConversation(messageText, { loadConversation: false });
          }
          state.activeStreamConversationId = conversationId;
          const streamConversationId = conversationId;
          const renderIfActiveConversation = (streaming) => {
            if (state.activeConversationId !== streamConversationId) {
              return;
            }
            state.activeMessages = localMessages;
            if (!streaming) {
              if (_rafId) { cancelAnimationFrame(_rafId); _rafId = 0; }
              renderMessages(localMessages, false);
              return;
            }
            if (!_rafId) {
              _rafId = requestAnimationFrame(() => {
                _rafId = 0;
                if (state.activeConversationId !== streamConversationId) return;
                renderMessages(localMessages, true);
              });
            }
          };
          const finalizeAssistantMessage = () => {
            assistantMessage._activeActivities = [];
            if (assistantMessage._currentTools.length > 0) {
              assistantMessage._sections.push({ type: "tools", content: assistantMessage._currentTools });
              assistantMessage._currentTools = [];
            }
            if (assistantMessage._currentText.length > 0) {
              assistantMessage._sections.push({ type: "text", content: assistantMessage._currentText });
              assistantMessage._currentText = "";
            }
          };
          let _totalSteps = 0;
          let _maxSteps = 0;
          let _receivedTerminalEvent = false;
          let _shouldContinue = false;

          // Helper to read an SSE stream from a fetch response
          const readSseStream = async (response) => {
            _shouldContinue = false;
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              buffer = parseSseChunk(buffer, (eventName, payload) => {
                try {
                  handleSseEvent(eventName, payload);
                } catch (error) {
                  console.error("SSE event handling error:", eventName, error);
                }
              });
            }
          };

          const handleSseEvent = (eventName, payload) => {
                if (eventName === "model:chunk") {
                  const chunk = String(payload.content || "");
                  if (chunk.length > 0) clearResolvedApprovals(assistantMessage);
                  if (assistantMessage._currentTools.length > 0 && chunk.length > 0) {
                    assistantMessage._sections.push({ type: "tools", content: assistantMessage._currentTools });
                    assistantMessage._currentTools = [];
                  }
                  assistantMessage.content += chunk;
                  assistantMessage._currentText += chunk;
                  renderIfActiveConversation(true);
                }
                if (eventName === "run:started") {
                  state.activeStreamRunId = typeof payload.runId === "string" ? payload.runId : null;
                  if (typeof payload.contextWindow === "number" && payload.contextWindow > 0) {
                    state.contextWindow = payload.contextWindow;
                  }
                  setStreaming(state.isStreaming);
                }
                if (eventName === "model:response") {
                  if (typeof payload.usage?.input === "number") {
                    state.contextTokens = payload.usage.input;
                    updateContextRing();
                  }
                }
                if (eventName === "tool:generating") {
                  const toolName = payload.tool || "tool";
                  if (!Array.isArray(assistantMessage._activeActivities)) {
                    assistantMessage._activeActivities = [];
                  }
                  assistantMessage._activeActivities.push({
                    kind: "generating",
                    tool: toolName,
                    label: "Preparing " + toolName,
                  });
                  if (assistantMessage._currentText.length > 0) {
                    assistantMessage._sections.push({ type: "text", content: assistantMessage._currentText });
                    assistantMessage._currentText = "";
                  }
                  if (!assistantMessage.metadata) assistantMessage.metadata = {};
                  if (!assistantMessage.metadata.toolActivity) assistantMessage.metadata.toolActivity = [];
                  const prepText = "- preparing " + _TK + toolName + _TK;
                  assistantMessage._currentTools.push(prepText);
                  assistantMessage.metadata.toolActivity.push(prepText);
                  renderIfActiveConversation(true);
                }
                if (eventName === "tool:started") {
                  clearResolvedApprovals(assistantMessage);
                  const toolName = payload.tool || "tool";
                  removeActiveActivityForTool(assistantMessage, toolName);
                  const startedActivity = addActiveActivityFromToolStart(
                    assistantMessage,
                    payload,
                  );
                  if (assistantMessage._currentText.length > 0) {
                    assistantMessage._sections.push({ type: "text", content: assistantMessage._currentText });
                    assistantMessage._currentText = "";
                  }
                  if (!assistantMessage.metadata) assistantMessage.metadata = {};
                  if (!assistantMessage.metadata.toolActivity) assistantMessage.metadata.toolActivity = [];
                  const prepPrefix = "- preparing " + _TK + toolName + _TK;
                  const prepToolIdx = assistantMessage._currentTools.indexOf(prepPrefix);
                  if (prepToolIdx >= 0) {
                    assistantMessage._currentTools.splice(prepToolIdx, 1);
                  }
                  const prepMetaIdx = assistantMessage.metadata.toolActivity.indexOf(prepPrefix);
                  if (prepMetaIdx >= 0) {
                    assistantMessage.metadata.toolActivity.splice(prepMetaIdx, 1);
                  }
                  const detail =
                    startedActivity && typeof startedActivity.detail === "string"
                      ? startedActivity.detail.trim()
                      : "";
                  const toolText =
                    "- start " + _TK + toolName + _TK + (detail ? " (" + detail + ")" : "");
                  assistantMessage._currentTools.push(toolText);
                  assistantMessage.metadata.toolActivity.push(toolText);
                  renderIfActiveConversation(true);
                }
                if (eventName === "tool:completed") {
                  const toolName = payload.tool || "tool";
                  removeActiveActivityForTool(assistantMessage, toolName);
                  const toolText = buildToolDoneText(payload);
                  assistantMessage._currentTools.push(toolText);
                  if (!assistantMessage.metadata) assistantMessage.metadata = {};
                  if (!assistantMessage.metadata.toolActivity) assistantMessage.metadata.toolActivity = [];
                  assistantMessage.metadata.toolActivity.push(toolText);
                  if (typeof payload.outputTokenEstimate === "number" && payload.outputTokenEstimate > 0 && state.contextWindow > 0) {
                    state.contextTokens += payload.outputTokenEstimate;
                    updateContextRing();
                  }
                  if (toolName !== "todo_list" && toolName.startsWith("todo_") && payload.output && typeof payload.output === "object" && Array.isArray(payload.output.todos)) {
                    state.todos = payload.output.todos;
                    _autoCollapseTodos(true);
                    renderTodoPanel();
                  }
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
                    "- error " + _TK +
                    toolName +
                    _TK +
                    (detail ? " (" + detail + ")" : "") +
                    ": " +
                    errorMsg;
                  assistantMessage._currentTools.push(toolText);
                  if (!assistantMessage.metadata) assistantMessage.metadata = {};
                  if (!assistantMessage.metadata.toolActivity) assistantMessage.metadata.toolActivity = [];
                  assistantMessage.metadata.toolActivity.push(toolText);
                  renderIfActiveConversation(true);
                }
                if (eventName === "compaction:started") {
                  ensureActiveActivities(assistantMessage).push({
                    kind: "compaction",
                    tool: "__compaction__",
                    label: "Compacting context",
                  });
                  renderIfActiveConversation(true);
                }
                if (eventName === "compaction:completed") {
                  didCompact = true;
                  removeActiveActivityForTool(assistantMessage, "__compaction__");
                  if (typeof payload.tokensAfter === "number") {
                    state.contextTokens = payload.tokensAfter;
                    updateContextRing();
                  }
                  renderIfActiveConversation(true);
                }
                if (eventName === "browser:status" && payload.active) {
                  if (window._connectBrowserStream) window._connectBrowserStream();
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
                    "- approval required " + _TK +
                    toolName +
                    _TK +
                    (detail ? " (" + detail + ")" : "");
                  assistantMessage._currentTools.push(toolText);
                  if (!assistantMessage.metadata) assistantMessage.metadata = {};
                  if (!assistantMessage.metadata.toolActivity) assistantMessage.metadata.toolActivity = [];
                  assistantMessage.metadata.toolActivity.push(toolText);
                  const approvalId =
                    typeof payload.approvalId === "string" ? payload.approvalId : "";
                  if (approvalId) {
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
                        input: payload.input ?? {},
                        state: "pending",
                      });
                    }
                  }
                  renderIfActiveConversation(true);
                }
                if (eventName === "tool:approval:granted") {
                  const approvalId =
                    typeof payload.approvalId === "string" ? payload.approvalId : "";
                  var grantedTool = "tool";
                  if (approvalId && Array.isArray(assistantMessage._pendingApprovals)) {
                    var match = assistantMessage._pendingApprovals.find((r) => r.approvalId === approvalId);
                    if (match && match.tool) grantedTool = match.tool;
                    assistantMessage._pendingApprovals = assistantMessage._pendingApprovals.filter(
                      (req) => req.approvalId !== approvalId || req.state === "resolved",
                    );
                  }
                  const toolText = "- done " + _TK + grantedTool + _TK + " (approved)";
                  assistantMessage._currentTools.push(toolText);
                  if (!assistantMessage.metadata) assistantMessage.metadata = {};
                  if (!assistantMessage.metadata.toolActivity) assistantMessage.metadata.toolActivity = [];
                  assistantMessage.metadata.toolActivity.push(toolText);
                  renderIfActiveConversation(true);
                }
                if (eventName === "tool:approval:denied") {
                  const approvalId =
                    typeof payload.approvalId === "string" ? payload.approvalId : "";
                  var deniedTool = "tool";
                  if (approvalId && Array.isArray(assistantMessage._pendingApprovals)) {
                    var match2 = assistantMessage._pendingApprovals.find((r) => r.approvalId === approvalId);
                    if (match2 && match2.tool) deniedTool = match2.tool;
                    assistantMessage._pendingApprovals = assistantMessage._pendingApprovals.filter(
                      (req) => req.approvalId !== approvalId || req.state === "resolved",
                    );
                  }
                  const toolText = "- error " + _TK + deniedTool + _TK + ": denied";
                  assistantMessage._currentTools.push(toolText);
                  if (!assistantMessage.metadata) assistantMessage.metadata = {};
                  if (!assistantMessage.metadata.toolActivity) assistantMessage.metadata.toolActivity = [];
                  assistantMessage.metadata.toolActivity.push(toolText);
                  renderIfActiveConversation(true);
                }
                if (eventName === "subagent:spawned" || eventName === "subagent:completed" || eventName === "subagent:error" || eventName === "subagent:stopped" || eventName === "subagent:approval_needed") {
                  if (state.activeConversationId === conversationId || state.subagentsParentId === conversationId) {
                    loadSubagents(conversationId, true);
                  }
                }
                if (eventName === "subagent:approval_needed" && payload.approvalId && payload.tool) {
                  var subIdShort2 = payload.subagentId && payload.subagentId.length > 12 ? payload.subagentId.slice(0, 12) + "..." : (payload.subagentId || "");
                  var approvalReq2 = {
                    approvalId: payload.approvalId,
                    tool: payload.tool,
                    input: payload.input || {},
                    _subagentId: payload.subagentId,
                    _subagentLabel: "subagent " + subIdShort2,
                  };
                  if (!assistantMessage._pendingApprovals) assistantMessage._pendingApprovals = [];
                  assistantMessage._pendingApprovals.push(approvalReq2);
                  var parentConv3 = state.conversations.find(function(c) { return c.conversationId === conversationId; });
                  if (parentConv3) parentConv3.hasPendingApprovals = true;
                  renderConversationList();
                  renderIfActiveConversation(true);
                }
                if (eventName === "subagent:completed" || eventName === "subagent:error" || eventName === "subagent:stopped") {
                  if (payload.subagentId && assistantMessage._pendingApprovals) {
                    assistantMessage._pendingApprovals = assistantMessage._pendingApprovals.filter(
                      function(req) { return req._subagentId !== payload.subagentId; }
                    );
                    var parentConv4 = state.conversations.find(function(c) { return c.conversationId === conversationId; });
                    if (parentConv4 && (!assistantMessage._pendingApprovals || assistantMessage._pendingApprovals.length === 0)) {
                      parentConv4.hasPendingApprovals = false;
                    }
                    renderConversationList();
                    renderIfActiveConversation(true);
                  }
                }
                if (eventName === "run:completed") {
                  _receivedTerminalEvent = true;
                  _totalSteps += typeof payload.result?.steps === "number" ? payload.result.steps : 0;
                  if (typeof payload.result?.maxSteps === "number") _maxSteps = payload.result.maxSteps;
                  if (payload.result?.continuation === true && (_maxSteps <= 0 || _totalSteps < _maxSteps)) {
                    _shouldContinue = true;
                    if (assistantMessage._currentTools.length > 0) {
                      assistantMessage._sections.push({ type: "tools", content: assistantMessage._currentTools });
                      assistantMessage._currentTools = [];
                    }
                    assistantMessage._activeActivities = [];
                    renderIfActiveConversation(true);
                  } else {
                    finalizeAssistantMessage();
                    if (!assistantMessage.content || assistantMessage.content.length === 0) {
                      assistantMessage.content = String(payload.result?.response || "");
                    }
                    if (payload.pendingSubagents) {
                      _pendingSubagentsConversation = conversationId;
                    }
                    renderIfActiveConversation(false);
                  }
                }
                if (eventName === "run:cancelled") {
                  _receivedTerminalEvent = true;
                  finalizeAssistantMessage();
                  renderIfActiveConversation(false);
                }
                if (eventName === "run:error") {
                  _receivedTerminalEvent = true;
                  finalizeAssistantMessage();
                  const errMsg = payload.error?.message || "Something went wrong";
                  assistantMessage._error = errMsg;
                  renderIfActiveConversation(false);
                }
                if (eventName === "stream:end") {
                  // no-op: server signals empty continuation
                }
          };

          // Initial message POST
          let fetchOpts;
          if (filesToSend.length > 0) {
            const formData = new FormData();
            formData.append("message", messageText);
            for (const f of filesToSend) {
              formData.append("files", f, f.name);
            }
            const _streamHeaders = state.tenantToken
              ? { "Authorization": "Bearer " + state.tenantToken }
              : { "x-csrf-token": state.csrfToken };
            fetchOpts = {
              method: "POST",
              credentials: state.tenantToken ? "omit" : "include",
              headers: _streamHeaders,
              body: formData,
              signal: streamAbortController.signal,
            };
          } else {
            const _streamHeaders = state.tenantToken
              ? { "Content-Type": "application/json", "Authorization": "Bearer " + state.tenantToken }
              : { "Content-Type": "application/json", "x-csrf-token": state.csrfToken };
            fetchOpts = {
              method: "POST",
              credentials: state.tenantToken ? "omit" : "include",
              headers: _streamHeaders,
              body: JSON.stringify({ message: messageText }),
              signal: streamAbortController.signal,
            };
          }
          const response = await fetch(
            "/api/conversations/" + encodeURIComponent(conversationId) + "/messages",
            fetchOpts,
          );
          if (!response.ok || !response.body) {
            throw new Error("Failed to stream response");
          }
          await readSseStream(response);

          // Continuation loop: POST to /continue while the server signals more work
          while (_shouldContinue) {
            _shouldContinue = false;
            _receivedTerminalEvent = false;
            const _contHeaders = state.tenantToken
              ? { "Content-Type": "application/json", "Authorization": "Bearer " + state.tenantToken }
              : { "Content-Type": "application/json", "x-csrf-token": state.csrfToken };
            const contResponse = await fetch(
              "/api/conversations/" + encodeURIComponent(conversationId) + "/continue",
              {
                method: "POST",
                credentials: state.tenantToken ? "omit" : "include",
                headers: _contHeaders,
                signal: streamAbortController.signal,
              },
            );
            if (!contResponse.ok || !contResponse.body) {
              // Server may have already handled continuation (safety net claimed it).
              // Fall back to polling for idle state.
              await pollUntilRunIdle(conversationId);
              break;
            }
            await readSseStream(contResponse);
          }

          // If stream ended without terminal event and no continuation, check server
          if (!_receivedTerminalEvent && !_shouldContinue) {
            try {
              const recoveryPayload = await api("/api/conversations/" + encodeURIComponent(conversationId));
              if (recoveryPayload.hasActiveRun || recoveryPayload.needsContinuation) {
                await pollUntilRunIdle(conversationId);
              }
            } catch (_recoverErr) {
              console.warn("[poncho] Recovery check failed after abrupt stream end");
            }
          }
          // Update active state only if user is still on this conversation.
          if (state.activeConversationId === streamConversationId) {
            state.activeMessages = localMessages;
          }
          await loadConversations();
          // Don't reload the conversation - we already have the latest state with tool chips
        } catch (error) {
          if (_rafId) { cancelAnimationFrame(_rafId); _rafId = 0; }
          if (streamAbortController.signal.aborted) {
            assistantMessage._activeActivities = [];
            if (assistantMessage._currentTools.length > 0) {
              assistantMessage._sections.push({ type: "tools", content: assistantMessage._currentTools });
              assistantMessage._currentTools = [];
            }
            if (assistantMessage._currentText.length > 0) {
              assistantMessage._sections.push({ type: "text", content: assistantMessage._currentText });
              assistantMessage._currentText = "";
            }
            renderMessages(localMessages, false);
          } else {
            assistantMessage._activeActivities = [];
            assistantMessage._error = error instanceof Error ? error.message : "Something went wrong";
            renderMessages(localMessages, false);
          }
        } finally {
          if (_rafId) { cancelAnimationFrame(_rafId); _rafId = 0; }
          if (state.activeStreamAbortController === streamAbortController) {
            state.activeStreamAbortController = null;
          }
          if (state.activeStreamConversationId === conversationId) {
            state.activeStreamConversationId = null;
            state._activeStreamMessages = null;
          }
          state.activeStreamRunId = null;
          setStreaming(false);
          if (didCompact && conversationId) {
            loadConversation(conversationId).catch(function() {});
          } else if (conversationId) {
            // After a normal turn, replace the locally-built activeMessages
            // (which lack metadata.id) with the server's persisted version so
            // the "Reply in thread" affordance and other id-based features work.
            refreshActiveMessagesFromServer(conversationId).catch(function() {});
          }
          elements.prompt.focus();
        }

        // Subagent callback: after sendMessage completes and subagents are
        // still running, start polling so we pick up their results and the
        // parent's callback run (which streams the response to the user).
        if (_pendingSubagentsConversation && state.activeConversationId === _pendingSubagentsConversation) {
          pollForSubagentResults(_pendingSubagentsConversation);
        }
      };

      // --- Tenant settings panel ---
      const _showSettingsPanel = async (tenantSecrets) => {
        if (!tenantSecrets || tenantSecrets.length === 0) return;

        // Fetch current secret status
        let secrets = [];
        try {
          const data = await api("/api/secrets");
          secrets = data.secrets || [];
        } catch { return; }

        // Show cog button in sidebar
        const settingsBtn = $("settings-btn");
        if (settingsBtn) settingsBtn.classList.remove("hidden");

        // Create overlay
        let overlay = $("settings-overlay");
        if (!overlay) {
          overlay = document.createElement("div");
          overlay.id = "settings-overlay";
          overlay.className = "settings-overlay";
          overlay.innerHTML = '<div id="settings-panel" class="settings-panel"></div>';
          document.body.appendChild(overlay);
          overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.style.display = "none"; });
        }

        const renderPanel = (items) => {
          const panel = $("settings-panel");
          if (!panel) return;
          panel.innerHTML = '<h3>Settings</h3>' +
            items.map((s) =>
              '<div class="settings-field">' +
                '<label>' + escapeHtml(s.label || s.name) + '</label>' +
                '<div class="settings-field-row">' +
                  '<input type="password" data-env="' + escapeHtml(s.name) + '" placeholder="' + (s.isSet ? '(set - enter new value to change)' : 'Enter value') + '" />' +
                  '<button class="settings-save-btn" data-save="' + escapeHtml(s.name) + '">Save</button>' +
                  (s.isSet ? '<button class="settings-clear-btn" data-clear="' + escapeHtml(s.name) + '">Clear</button>' : '') +
                '</div>' +
              '</div>'
            ).join("") +
            '<button class="settings-close-btn" id="settings-close">Close</button>';

          panel.querySelectorAll("[data-save]").forEach((btn) => {
            btn.addEventListener("click", async () => {
              const envName = btn.getAttribute("data-save");
              const input = panel.querySelector('input[data-env="' + envName + '"]');
              const val = input ? input.value.trim() : "";
              if (!val) return;
              try {
                await api("/api/secrets/" + encodeURIComponent(envName), { method: "PUT", body: JSON.stringify({ value: val }) });
                input.value = "";
                input.placeholder = "(set - enter new value to change)";
                const parent = btn.parentElement;
                if (parent && !parent.querySelector("[data-clear]")) {
                  const clrBtn = document.createElement("button");
                  clrBtn.className = "settings-clear-btn";
                  clrBtn.setAttribute("data-clear", envName);
                  clrBtn.textContent = "Clear";
                  clrBtn.addEventListener("click", async () => {
                    await api("/api/secrets/" + encodeURIComponent(envName), { method: "DELETE" });
                    clrBtn.remove();
                    input.placeholder = "Enter value";
                  });
                  parent.appendChild(clrBtn);
                }
              } catch (err) {
                alert("Failed to save: " + (err.message || "unknown error"));
              }
            });
          });

          panel.querySelectorAll("[data-clear]").forEach((btn) => {
            btn.addEventListener("click", async () => {
              const envName = btn.getAttribute("data-clear");
              try {
                await api("/api/secrets/" + encodeURIComponent(envName), { method: "DELETE" });
                btn.remove();
                const input = panel.querySelector('input[data-env="' + envName + '"]');
                if (input) input.placeholder = "Enter value";
              } catch (err) {
                alert("Failed to clear: " + (err.message || "unknown error"));
              }
            });
          });

          const closeBtn = $("settings-close");
          if (closeBtn) closeBtn.addEventListener("click", () => { overlay.style.display = "none"; });
        };

        renderPanel(secrets);
        if (settingsBtn) {
          settingsBtn.addEventListener("click", async () => {
            try {
              const data = await api("/api/secrets");
              renderPanel(data.secrets || []);
            } catch {}
            overlay.style.display = "flex";
          });
        }
      };

      const requireAuth = async () => {
        // Tenant token auth — skip login, go straight to app
        if (state.tenantToken) {
          // Fetch session to get tenantSecrets config
          try {
            const session = await api("/api/auth/session");
            if (session.tenantSecrets) {
              _showSettingsPanel(
                Object.entries(session.tenantSecrets).map(([name, label]) => ({ name, label }))
              );
            }
          } catch {}
          elements.auth.classList.add("hidden");
          elements.app.classList.remove("hidden");
          return true;
        }
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
        if (window._resetBrowserPanel) window._resetBrowserPanel();
        state.activeConversationId = null;
        state.activeMessages = [];
        state.confirmDeleteId = null;
        state.contextTokens = 0;
        state.contextWindow = 0;
        state.viewingSubagentId = null;
        state.parentConversationId = null;
        state.subagents = [];
        state.subagentsParentId = null;
        state.todos = [];
        updateSubagentUi();
        updateContextRing();
        renderTodoPanel();
        pushConversationUrl(null);
        elements.chatTitle.textContent = "";
        renderMessages([]);
        renderConversationList();
        elements.prompt.focus();
        if (isMobile()) {
          setSidebarOpen(false);
        }
      };

      // ── Slash command menu ──
      var slashMenuEl = document.createElement("div");
      slashMenuEl.className = "slash-menu hidden";
      var composerShell = elements.composer.querySelector(".composer-shell");
      composerShell.parentNode.insertBefore(slashMenuEl, composerShell);

      const fetchSlashCommands = async () => {
        if (state.slashCommands) return state.slashCommands;
        try {
          const data = await api("/api/slash-commands");
          state.slashCommands = data.commands || [];
        } catch {
          state.slashCommands = [{ command: "/compact", description: "Compact conversation context", type: "command" }];
        }
        return state.slashCommands;
      };

      const renderSlashMenu = (commands, filter) => {
        var query = filter.toLowerCase();
        var filtered = query === "/"
          ? commands
          : commands.filter(function(c) { return c.command.toLowerCase().startsWith(query); });
        if (filtered.length === 0) {
          slashMenuEl.classList.add("hidden");
          return;
        }
        if (state.slashMenuIndex >= filtered.length) state.slashMenuIndex = 0;
        slashMenuEl.innerHTML = filtered.map(function(c, i) {
          var active = i === state.slashMenuIndex ? " slash-menu-item-active" : "";
          var badge = c.type === "skill" ? '<span class="slash-menu-badge">skill</span>' : "";
          return '<div class="slash-menu-item' + active + '" data-index="' + i + '">'
            + '<span class="slash-menu-cmd">' + escapeHtml(c.command) + '</span>'
            + badge
            + '<span class="slash-menu-desc">' + escapeHtml(c.description) + '</span>'
            + '</div>';
        }).join("");
        slashMenuEl.classList.remove("hidden");
        slashMenuEl._filtered = filtered;
        var activeItem = slashMenuEl.querySelector(".slash-menu-item-active");
        if (activeItem) activeItem.scrollIntoView({ block: "nearest" });
      };

      const selectSlashItem = (item) => {
        if (!item) return;
        elements.prompt.value = item.command + " ";
        slashMenuEl.classList.add("hidden");
        elements.prompt.focus();
        autoResizePrompt();
      };

      slashMenuEl.addEventListener("mousedown", function(e) {
        e.preventDefault(); // don't blur prompt
        var target = e.target.closest(".slash-menu-item");
        if (target && slashMenuEl._filtered) {
          var idx = parseInt(target.dataset.index, 10);
          selectSlashItem(slashMenuEl._filtered[idx]);
        }
      });

      elements.newChat.addEventListener("click", startNewChat);
      elements.topbarNewChat.addEventListener("click", startNewChat);

      elements.chatTitle.addEventListener("dblclick", beginTitleEdit);

      elements.prompt.addEventListener("input", async () => {
        autoResizePrompt();
        var val = elements.prompt.value;
        if (val.startsWith("/") && !val.includes("\\n")) {
          var commands = await fetchSlashCommands();
          state.slashMenuIndex = 0;
          renderSlashMenu(commands, val);
        } else {
          slashMenuEl.classList.add("hidden");
        }
      });

      elements.prompt.addEventListener("keydown", (event) => {
        if (!slashMenuEl.classList.contains("hidden")) {
          var filtered = slashMenuEl._filtered || [];
          if (event.key === "ArrowDown") {
            event.preventDefault();
            state.slashMenuIndex = (state.slashMenuIndex + 1) % filtered.length;
            renderSlashMenu(state.slashCommands || [], elements.prompt.value);
            return;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            state.slashMenuIndex = (state.slashMenuIndex - 1 + filtered.length) % filtered.length;
            renderSlashMenu(state.slashCommands || [], elements.prompt.value);
            return;
          }
          if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
            if (filtered.length > 0) {
              event.preventDefault();
              selectSlashItem(filtered[state.slashMenuIndex]);
              return;
            }
          }
          if (event.key === "Escape") {
            slashMenuEl.classList.add("hidden");
            return;
          }
        }
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          elements.composer.requestSubmit();
        }
      });

      elements.prompt.addEventListener("blur", () => {
        setTimeout(function() { slashMenuEl.classList.add("hidden"); }, 150);
      });

      elements.sidebarToggle.addEventListener("click", () => {
        if (isMobile()) setSidebarOpen(!elements.shell.classList.contains("sidebar-open"));
      });

      elements.sidebarBackdrop.addEventListener("click", () => setSidebarOpen(false));

      elements.logout.addEventListener("click", async () => {
        try { await api("/api/auth/logout", { method: "POST" }); } catch {}
        // Clear tenant token if present
        if (state.tenantToken) {
          state.tenantToken = null;
          sessionStorage.removeItem("poncho_tenant_token");
        }
        state.activeConversationId = null;
        state.activeMessages = [];
        state.confirmDeleteId = null;
        state.conversations = [];
        state.csrfToken = "";
        state.contextTokens = 0;
        state.contextWindow = 0;
        updateContextRing();
        renderMessages([]);
        renderConversationList();
        elements.chatTitle.textContent = "";
        const authenticated = await requireAuth();
        if (authenticated) {
          // Auth not required — force reload to reset UI state
          window.location.reload();
        }
      });

      if (elements.threadPanelClose) {
        elements.threadPanelClose.addEventListener("click", () => {
          closeThreadPanel();
        });
      }

      // ── Thread composer (separate from the main composer) ──
      const renderThreadAttachmentPreview = () => {
        const el = elements.threadAttachmentPreview;
        if (!el) return;
        const files = state.threadPanel.pendingFiles || [];
        if (files.length === 0) {
          el.style.display = "none";
          el.innerHTML = "";
          return;
        }
        el.style.display = "";
        el.innerHTML = files.map((f, i) => {
          const isImage = f.type && f.type.startsWith("image/");
          const preview = isImage
            ? '<img src="' + URL.createObjectURL(f) + '" />'
            : '<span class="user-file-badge">📎 ' + escapeHtml(f.name) + '</span>';
          return '<div class="attachment-item">' + preview
            + '<button type="button" class="remove-attachment" data-idx="' + i + '">×</button></div>';
        }).join("");
      };

      const addThreadFiles = (fileList) => {
        const arr = Array.from(fileList || []);
        for (const f of arr) {
          if (f.size > 25 * 1024 * 1024) {
            alert("File too large: " + f.name + " (max 25MB)");
            continue;
          }
          state.threadPanel.pendingFiles.push(f);
        }
        renderThreadAttachmentPreview();
      };

      const autoResizeThreadPrompt = () => {
        const el = elements.threadPrompt;
        if (!el) return;
        el.style.height = "auto";
        el.style.height = Math.min(el.scrollHeight, 200) + "px";
      };

      if (elements.threadAttachBtn && elements.threadFileInput) {
        elements.threadAttachBtn.addEventListener("click", () => elements.threadFileInput.click());
        elements.threadFileInput.addEventListener("change", () => {
          if (elements.threadFileInput.files && elements.threadFileInput.files.length > 0) {
            addThreadFiles(elements.threadFileInput.files);
            elements.threadFileInput.value = "";
          }
        });
      }
      if (elements.threadAttachmentPreview) {
        elements.threadAttachmentPreview.addEventListener("click", (e) => {
          const rm = e.target.closest(".remove-attachment");
          if (rm) {
            const idx = parseInt(rm.dataset.idx, 10);
            state.threadPanel.pendingFiles.splice(idx, 1);
            renderThreadAttachmentPreview();
          }
        });
      }
      if (elements.threadPrompt) {
        elements.threadPrompt.addEventListener("input", autoResizeThreadPrompt);
        elements.threadPrompt.addEventListener("paste", (e) => {
          const items = e.clipboardData && e.clipboardData.items;
          if (!items) return;
          const files = [];
          for (let i = 0; i < items.length; i++) {
            if (items[i].kind === "file") {
              const f = items[i].getAsFile();
              if (f) files.push(f);
            }
          }
          if (files.length > 0) {
            e.preventDefault();
            addThreadFiles(files);
          }
        });
        elements.threadPrompt.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            elements.threadComposer.requestSubmit();
          }
        });
      }
      if (elements.threadComposer) {
        elements.threadComposer.addEventListener("submit", async (event) => {
          event.preventDefault();
          if (!state.threadPanel.open || !state.threadPanel.threadId) return;
          const value = elements.threadPrompt.value;
          const filesToSend = [...state.threadPanel.pendingFiles];
          if (!value.trim() && filesToSend.length === 0) return;
          elements.threadPrompt.value = "";
          state.threadPanel.pendingFiles = [];
          renderThreadAttachmentPreview();
          autoResizeThreadPrompt();
          await submitThreadReply(value, filesToSend);
        });
      }

      // Drag-to-resize between main pane and thread panel — mirrors the
      // browser-panel resize pattern.
      (function () {
        const handle = elements.threadPanelResize;
        const panel = elements.threadPanel;
        const mainEl = document.querySelector(".main-chat");
        if (!handle || !panel || !mainEl) return;
        let dragging = false;
        handle.addEventListener("mousedown", (e) => {
          e.preventDefault();
          dragging = true;
          handle.classList.add("dragging");
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
        });
        document.addEventListener("mousemove", (e) => {
          if (!dragging) return;
          const body = mainEl.parentElement;
          if (!body) return;
          const bodyRect = body.getBoundingClientRect();
          const available = bodyRect.width - 1;
          let chatW = e.clientX - bodyRect.left;
          chatW = Math.max(280, Math.min(chatW, available - 320));
          const panelW = available - chatW;
          mainEl.style.flex = "0 0 " + chatW + "px";
          panel.style.flex = "0 0 " + panelW + "px";
        });
        document.addEventListener("mouseup", () => {
          if (!dragging) return;
          dragging = false;
          handle.classList.remove("dragging");
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
        });
      })();

      elements.composer.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (state.isStreaming) {
          if (!state.activeStreamRunId) {
            return;
          }
          await stopActiveRun();
          return;
        }
        const value = elements.prompt.value;
        elements.prompt.value = "";
        autoResizePrompt();
        await sendMessage(value);
      });

      elements.attachBtn.addEventListener("click", () => elements.fileInput.click());
      elements.fileInput.addEventListener("change", () => {
        if (elements.fileInput.files && elements.fileInput.files.length > 0) {
          addFiles(elements.fileInput.files);
          elements.fileInput.value = "";
        }
      });
      elements.attachmentPreview.addEventListener("click", (e) => {
        const rm = e.target.closest(".remove-attachment");
        if (rm) {
          const idx = parseInt(rm.dataset.idx, 10);
          state.pendingFiles.splice(idx, 1);
          renderAttachmentPreview();
        }
      });

      let dragCounter = 0;
      document.addEventListener("dragenter", (e) => {
        e.preventDefault();
        dragCounter++;
        if (dragCounter === 1) elements.dragOverlay.classList.add("active");
      });
      document.addEventListener("dragleave", (e) => {
        e.preventDefault();
        dragCounter--;
        if (dragCounter <= 0) { dragCounter = 0; elements.dragOverlay.classList.remove("active"); }
      });
      document.addEventListener("dragover", (e) => e.preventDefault());
      document.addEventListener("drop", (e) => {
        e.preventDefault();
        dragCounter = 0;
        elements.dragOverlay.classList.remove("active");
        if (e.dataTransfer && e.dataTransfer.files.length > 0) {
          addFiles(e.dataTransfer.files);
        }
      });

      // Paste files/images from clipboard
      elements.prompt.addEventListener("paste", (e) => {
        const items = e.clipboardData && e.clipboardData.items;
        if (!items) return;
        const files = [];
        for (let i = 0; i < items.length; i++) {
          if (items[i].kind === "file") {
            const f = items[i].getAsFile();
            if (f) files.push(f);
          }
        }
        if (files.length > 0) {
          e.preventDefault();
          addFiles(files);
        }
      });

      // Lightbox: open/close helpers
      const lightboxImg = elements.lightbox.querySelector("img");
      const openLightbox = (src) => {
        lightboxImg.src = src;
        elements.lightbox.style.display = "flex";
        requestAnimationFrame(() => {
          requestAnimationFrame(() => elements.lightbox.classList.add("active"));
        });
      };
      const closeLightbox = () => {
        elements.lightbox.classList.remove("active");
        elements.lightbox.addEventListener("transitionend", function handler() {
          elements.lightbox.removeEventListener("transitionend", handler);
          elements.lightbox.style.display = "none";
          lightboxImg.src = "";
        });
      };
      elements.lightbox.addEventListener("click", closeLightbox);
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && elements.lightbox.style.display !== "none") closeLightbox();
      });

      // Lightbox from message images and tool screenshots
      elements.messages.addEventListener("click", (e) => {
        const img = e.target;
        if (!(img instanceof HTMLImageElement)) return;
        if (img.closest(".user-file-attachments") || img.classList.contains("tool-screenshot")) {
          openLightbox(img.src);
        }
      });

      // Lightbox from attachment preview chips
      elements.attachmentPreview.addEventListener("click", (e) => {
        if (e.target.closest(".remove-attachment")) return;
        const chip = e.target.closest(".attachment-chip");
        if (!chip) return;
        const img = chip.querySelector("img");
        if (!img) return;
        e.stopPropagation();
        openLightbox(img.src);
      });

      const submitApproval = (approvalId, decision) => {
        state.approvalRequestsInFlight[approvalId] = true;
        updatePendingApproval(approvalId, (request) => ({
          ...request,
          state: "resolved",
          resolvedDecision: decision,
        }));
        return api("/api/approvals/" + encodeURIComponent(approvalId), {
          method: "POST",
          body: JSON.stringify({
            approved: decision === "approve",
            conversationId: state.activeConversationId || undefined,
          }),
        }).catch((error) => {
          const isStale = error && error.payload && error.payload.code === "APPROVAL_NOT_FOUND";
          const isNotReady = error && error.payload && error.payload.code === "APPROVAL_NOT_READY";
          if (isNotReady) {
            updatePendingApproval(approvalId, (request) => ({
              ...request,
              state: "pending",
              pendingDecision: null,
              resolvedDecision: null,
            }));
            return;
          }
          if (isStale) {
            updatePendingApproval(approvalId, () => null);
          } else {
            const errMsg = error instanceof Error ? error.message : String(error);
            updatePendingApproval(approvalId, (request) => ({
              ...request,
              state: "pending",
              pendingDecision: null,
              resolvedDecision: null,
              _error: errMsg,
            }));
          }
          renderMessages(state.activeMessages, state.isStreaming);
        }).finally(() => {
          delete state.approvalRequestsInFlight[approvalId];
        });
      };

      elements.messages.addEventListener("click", async (event) => {
        const target = event.target;
        if (!(target instanceof Element)) {
          return;
        }

        // Batch approve/deny all
        const batchBtn = target.closest(".approval-batch-btn");
        if (batchBtn) {
          const decision = batchBtn.getAttribute("data-approval-batch") || "";
          if (decision !== "approve" && decision !== "deny") return;
          const messages = state.activeMessages || [];
          const pending = [];
          for (const m of messages) {
            if (Array.isArray(m._pendingApprovals)) {
              for (const req of m._pendingApprovals) {
                if (req.approvalId && req.state !== "resolved" && !state.approvalRequestsInFlight[req.approvalId]) {
                  pending.push(req.approvalId);
                }
              }
            }
          }
          if (pending.length === 0) return;
          const wasStreaming = state.isStreaming;
          if (!wasStreaming) setStreaming(true);
          // Mark all items as resolved in the UI immediately
          for (const aid of pending) {
            state.approvalRequestsInFlight[aid] = true;
            updatePendingApproval(aid, (request) => ({
              ...request,
              state: "resolved",
              resolvedDecision: decision,
            }));
          }
          renderMessages(state.activeMessages, state.isStreaming);
          loadConversations();
          const streamCid = !wasStreaming && state.activeConversationId
            ? state.activeConversationId
            : null;
          if (streamCid) {
            streamConversationEvents(streamCid, { liveOnly: true }).finally(() => {
              if (state.activeConversationId === streamCid) {
                pollUntilRunIdle(streamCid);
              }
            });
          }
          // Send API calls sequentially so each store write completes
          // before the next read (avoids last-writer-wins in serverless).
          void (async () => {
            for (const aid of pending) {
              await api("/api/approvals/" + encodeURIComponent(aid), {
                method: "POST",
                body: JSON.stringify({
                  approved: decision === "approve",
                  conversationId: state.activeConversationId || undefined,
                }),
              }).catch((error) => {
                const isStale = error && error.payload && error.payload.code === "APPROVAL_NOT_FOUND";
                const isNotReady = error && error.payload && error.payload.code === "APPROVAL_NOT_READY";
                if (isNotReady) {
                  updatePendingApproval(aid, (request) => ({
                    ...request,
                    state: "pending",
                    pendingDecision: null,
                    resolvedDecision: null,
                  }));
                  renderMessages(state.activeMessages, state.isStreaming);
                  return;
                }
                if (isStale) {
                  updatePendingApproval(aid, () => null);
                } else {
                  const errMsg = error instanceof Error ? error.message : String(error);
                  updatePendingApproval(aid, (request) => ({
                    ...request,
                    state: "pending",
                    pendingDecision: null,
                    resolvedDecision: null,
                    _error: errMsg,
                  }));
                }
                renderMessages(state.activeMessages, state.isStreaming);
              }).finally(() => {
                delete state.approvalRequestsInFlight[aid];
              });
            }
          })();
          return;
        }

        // Individual approve/deny
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
        const wasStreaming = state.isStreaming;
        if (!wasStreaming) {
          setStreaming(true);
        }
        submitApproval(approvalId, decision);
        renderMessages(state.activeMessages, state.isStreaming);
        loadConversations();
        if (!wasStreaming && state.activeConversationId) {
          const cid = state.activeConversationId;
          await streamConversationEvents(cid, { liveOnly: true });
          if (state.activeConversationId === cid) {
            pollUntilRunIdle(cid);
          }
        }
      });

      elements.messages.addEventListener("click", (e) => {
        const link = e.target instanceof Element && e.target.closest(".subagent-link");
        if (!link) return;
        e.preventDefault();
        const subId = link.getAttribute("data-subagent-id");
        if (subId) {
          state.viewingSubagentId = subId;
          state.activeConversationId = subId;
          replaceConversationUrl(subId);
          loadConversation(subId);
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
        if (!event.target.closest(".thread-row") && state.confirmDeleteThreadId) {
          state.confirmDeleteThreadId = null;
          renderMessages(state.activeMessages, state.isStreaming);
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
          state.contextTokens = 0;
          state.contextWindow = 0;
          updateContextRing();
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
        updateContextRing();
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

        // Browser viewport panel
        (function initBrowserPanel() {
          var panel = elements.browserPanel;
          var frameImg = elements.browserPanelFrame;
          var urlLabel = elements.browserPanelUrl;
          var placeholder = elements.browserPanelPlaceholder;
          var closeBtn = elements.browserPanelClose;
          if (!panel || !frameImg) return;

          var resizeHandle = elements.browserPanelResize;
          var mainEl = document.querySelector(".main-chat");
          var abortController = null;
          var panelHiddenByUser = false;

          var showPanel = function(show) {
            var visible = show && !panelHiddenByUser;
            panel.style.display = visible ? "flex" : "none";
            if (resizeHandle) resizeHandle.style.display = visible ? "block" : "none";
            if (mainEl) {
              if (visible) mainEl.classList.add("has-browser");
              else mainEl.classList.remove("has-browser");
            }
          };


          closeBtn && closeBtn.addEventListener("click", function() {
            panelHiddenByUser = true;
            showPanel(false);
          });

          var navBack = elements.browserNavBack;
          var navFwd = elements.browserNavForward;
          var sendBrowserNav = function(action) {
            var headers = { "Content-Type": "application/json" };
            if (state.csrfToken) headers["x-csrf-token"] = state.csrfToken;
            if (state.authToken) headers["authorization"] = "Bearer " + state.authToken;
            fetch("/api/browser/navigate", {
              method: "POST",
              headers: headers,
              body: JSON.stringify({ action: action, conversationId: state.activeConversationId }),
            });
          };
          navBack && navBack.addEventListener("click", function() { sendBrowserNav("back"); });
          navFwd && navFwd.addEventListener("click", function() { sendBrowserNav("forward"); });

          window._resetBrowserPanel = function() {
            if (abortController) { abortController.abort(); abortController = null; }
            streamConversationId = null;
            panelHiddenByUser = false;
            showPanel(false);
            frameImg.style.display = "none";
            frameImg.style.pointerEvents = "";
            frameImg.style.opacity = "";
            if (placeholder) {
              placeholder.textContent = "No active browser session";
              placeholder.style.display = "flex";
            }
            if (urlLabel) urlLabel.textContent = "";
            if (navBack) navBack.disabled = true;
            if (navFwd) navFwd.disabled = true;
            var headers = {};
            if (state.csrfToken) headers["x-csrf-token"] = state.csrfToken;
            if (state.authToken) headers["authorization"] = "Bearer " + state.authToken;
            var cid = state.activeConversationId;
            if (!cid) return;
            fetch("/api/browser/status?conversationId=" + encodeURIComponent(cid), { headers: headers }).then(function(r) {
              return r.json();
            }).then(function(s) {
              if (s && s.active && cid === state.activeConversationId) {
                if (urlLabel && s.url) urlLabel.textContent = s.url;
                if (navBack) navBack.disabled = false;
                if (navFwd) navFwd.disabled = false;
                connectBrowserStream();
                showPanel(true);
              }
            }).catch(function() {});
          };

          // Drag-to-resize between conversation and browser panel
          if (resizeHandle && mainEl) {
            var dragging = false;
            resizeHandle.addEventListener("mousedown", function(e) {
              e.preventDefault();
              dragging = true;
              resizeHandle.classList.add("dragging");
              document.body.style.cursor = "col-resize";
              document.body.style.userSelect = "none";
            });
            document.addEventListener("mousemove", function(e) {
              if (!dragging) return;
              var body = mainEl.parentElement;
              if (!body) return;
              var bodyRect = body.getBoundingClientRect();
              var available = bodyRect.width - 1;
              var chatW = e.clientX - bodyRect.left;
              chatW = Math.max(280, Math.min(chatW, available - 280));
              var browserW = available - chatW;
              mainEl.style.flex = "0 0 " + chatW + "px";
              panel.style.flex = "0 0 " + browserW + "px";
            });
            document.addEventListener("mouseup", function() {
              if (!dragging) return;
              dragging = false;
              resizeHandle.classList.remove("dragging");
              document.body.style.cursor = "";
              document.body.style.userSelect = "";
            });
          }

          // --- Browser viewport interaction ---
          var browserViewportW = 1280;
          var browserViewportH = 720;
          var sendBrowserInput = function(kind, event) {
            var headers = { "Content-Type": "application/json" };
            if (state.csrfToken) headers["x-csrf-token"] = state.csrfToken;
            if (state.authToken) headers["authorization"] = "Bearer " + state.authToken;
            fetch("/api/browser/input", {
              method: "POST",
              headers: headers,
              body: JSON.stringify({ kind: kind, event: event, conversationId: state.activeConversationId }),
            }).catch(function() {});
          };
          var toViewportCoords = function(e) {
            var rect = frameImg.getBoundingClientRect();
            var scaleX = browserViewportW / rect.width;
            var scaleY = browserViewportH / rect.height;
            return { x: Math.round((e.clientX - rect.left) * scaleX), y: Math.round((e.clientY - rect.top) * scaleY) };
          };

          frameImg.style.cursor = "default";
          frameImg.setAttribute("tabindex", "0");

          frameImg.addEventListener("click", function(e) {
            var coords = toViewportCoords(e);
            sendBrowserInput("mouse", { type: "mousePressed", x: coords.x, y: coords.y, button: "left", clickCount: 1 });
            setTimeout(function() {
              sendBrowserInput("mouse", { type: "mouseReleased", x: coords.x, y: coords.y, button: "left", clickCount: 1 });
            }, 50);
            frameImg.focus();
          });

          frameImg.addEventListener("wheel", function(e) {
            e.preventDefault();
            var coords = toViewportCoords(e);
            sendBrowserInput("scroll", { deltaX: e.deltaX, deltaY: e.deltaY, x: coords.x, y: coords.y });
          }, { passive: false });

          frameImg.addEventListener("keydown", function(e) {
            e.preventDefault();
            e.stopPropagation();
            if ((e.metaKey || e.ctrlKey) && e.key === "v") {
              navigator.clipboard.readText().then(function(clip) {
                if (clip) sendBrowserInput("paste", { text: clip });
              }).catch(function() {});
              return;
            }
            var text = e.key.length === 1 ? e.key : undefined;
            sendBrowserInput("keyboard", { type: "keyDown", key: e.key, code: e.code, text: text, keyCode: e.keyCode });
          });
          frameImg.addEventListener("keyup", function(e) {
            e.preventDefault();
            e.stopPropagation();
            sendBrowserInput("keyboard", { type: "keyUp", key: e.key, code: e.code, keyCode: e.keyCode });
          });

          var streamConversationId = null;

          var connectBrowserStream = function() {
            var cid = state.activeConversationId;
            if (!cid) return;
            if (streamConversationId === cid && abortController) return;
            if (abortController) abortController.abort();
            streamConversationId = cid;
            abortController = new AbortController();
            frameImg.style.pointerEvents = "";
            frameImg.style.opacity = "";
            var headers = {};
            if (state.csrfToken) headers["x-csrf-token"] = state.csrfToken;
            if (state.authToken) headers["authorization"] = "Bearer " + state.authToken;
            fetch("/api/browser/stream?conversationId=" + encodeURIComponent(cid), { headers: headers, signal: abortController.signal })
              .then(function(res) {
                if (!res.ok || !res.body) return;
                var reader = res.body.getReader();
                var decoder = new TextDecoder();
                var buf = "";
                var sseEvent = "";
                var sseData = "";
                var pump = function() {
                  reader.read().then(function(result) {
                    if (result.done) return;
                    buf += decoder.decode(result.value, { stream: true });
                    var lines = buf.split("\\n");
                    buf = lines.pop() || "";
                    var eventName = sseEvent;
                    var data = sseData;
                    for (var i = 0; i < lines.length; i++) {
                      var line = lines[i];
                      if (line.startsWith("event: ")) {
                        eventName = line.slice(7).trim();
                      } else if (line.startsWith("data: ")) {
                        data += line.slice(6);
                      } else if (line === "" && eventName && data) {
                        try {
                          var payload = JSON.parse(data);
                          if (streamConversationId !== state.activeConversationId) { eventName = ""; data = ""; continue; }
                          if (eventName === "browser:frame") {
                            frameImg.src = "data:image/jpeg;base64," + payload.data;
                            frameImg.style.display = "block";
                            if (payload.width) browserViewportW = payload.width;
                            if (payload.height) browserViewportH = payload.height;
                            if (placeholder) placeholder.style.display = "none";
                            showPanel(true);
                            void panel.offsetHeight;
                          }
                          if (eventName === "browser:status") {
                            if (payload.url && urlLabel) urlLabel.textContent = payload.url;
                            if (navBack) navBack.disabled = !payload.active;
                            if (navFwd) navFwd.disabled = !payload.active;
                            if (payload.active) {
                              showPanel(true);
                            } else {
                              if (abortController) { abortController.abort(); abortController = null; }
                              streamConversationId = null;
                              frameImg.style.pointerEvents = "none";
                              frameImg.style.opacity = "0.6";
                            }
                          }
                        } catch(e) {}
                        eventName = "";
                        data = "";
                      }
                    }
                    sseEvent = eventName;
                    sseData = data;
                    pump();
                  }).catch(function() {});
                };
                pump();
              })
              .catch(function() {});
          };

          window._connectBrowserStream = connectBrowserStream;
        })();
      })();

`;
