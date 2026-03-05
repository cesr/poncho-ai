import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Email address parsing
// ---------------------------------------------------------------------------

const ADDR_RE = /<([^>]+)>/;

/** Extract the bare email address from a formatted string like `"Name <addr>"`. */
export function extractEmailAddress(formatted: string): string {
  const match = ADDR_RE.exec(formatted);
  return (match ? match[1] : formatted).trim().toLowerCase();
}

/** Extract the display name from `"Name <addr>"`, or return `undefined`. */
export function extractDisplayName(formatted: string): string | undefined {
  const idx = formatted.indexOf("<");
  if (idx <= 0) return undefined;
  const name = formatted.slice(0, idx).trim().replace(/^["']|["']$/g, "");
  return name || undefined;
}

// ---------------------------------------------------------------------------
// RFC 2822 References / threading
// ---------------------------------------------------------------------------

const MSG_ID_RE = /<[^>]+>/g;

/**
 * Parse a `References` header value into an ordered array of message IDs.
 * Handles both space-separated and newline-folded formats.
 */
export function parseReferences(
  headers: Array<{ name: string; value: string }> | Record<string, string> | undefined,
): string[] {
  if (!headers) return [];

  let refValue: string | undefined;

  if (Array.isArray(headers)) {
    const entry = headers.find((h) => h.name.toLowerCase() === "references");
    refValue = entry?.value;
  } else if (typeof headers === "object") {
    const key = Object.keys(headers).find((k) => k.toLowerCase() === "references");
    refValue = key ? headers[key] : undefined;
  }

  if (!refValue) return [];
  const matches = refValue.match(MSG_ID_RE);
  return matches ?? [];
}

/**
 * Derive a stable root message ID for a conversation.
 *
 * 1. First entry in the `References` chain (the original message).
 * 2. Fallback: hash of normalised subject + sender (for clients that strip References).
 * 3. Last resort: the current message's own ID.
 */
export function deriveRootMessageId(
  references: string[],
  currentMessageId: string,
  fallback?: { subject: string; sender: string },
): string {
  if (references.length > 0) return references[0]!;
  if (fallback) {
    const normalised = normaliseSubject(fallback.subject) + "\0" + fallback.sender.toLowerCase();
    const hash = createHash("sha256").update(normalised).digest("hex").slice(0, 16);
    return `<fallback:${hash}>`;
  }
  return currentMessageId;
}

/** Strip `Re:`, `Fwd:`, and similar prefixes for normalisation. */
function normaliseSubject(subject: string): string {
  return subject.replace(/^(?:re|fwd?|aw|sv|vs)\s*:\s*/gi, "").trim();
}

// ---------------------------------------------------------------------------
// Reply construction
// ---------------------------------------------------------------------------

/** Prepend `Re:` if the subject doesn't already have it. */
export function buildReplySubject(subject: string): string {
  if (/^re\s*:/i.test(subject)) return subject;
  return `Re: ${subject}`;
}

/**
 * Build `In-Reply-To` and `References` headers for an outbound reply.
 */
export function buildReplyHeaders(
  inReplyTo: string,
  existingReferences: string[],
): Record<string, string> {
  const refs = [...existingReferences];
  if (!refs.includes(inReplyTo)) refs.push(inReplyTo);
  return {
    "In-Reply-To": inReplyTo,
    "References": refs.join(" "),
  };
}

// ---------------------------------------------------------------------------
// Quoted reply stripping
// ---------------------------------------------------------------------------

/**
 * Strip quoted reply content from an email body (plain text).
 *
 * Handles common patterns from Gmail, Apple Mail, Outlook, and Thunderbird.
 * Best-effort heuristic — the full original text should be preserved elsewhere
 * (e.g. `IncomingMessage.raw`) for debugging.
 */
export function stripQuotedReply(text: string): string {
  const lines = text.split("\n");
  let cutIndex = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();

    // Gmail / Apple Mail: "On <date>, <name> wrote:"
    if (/^on\s+.+wrote:\s*$/i.test(line)) {
      cutIndex = i;
      break;
    }

    // Outlook: "-----Original Message-----"
    if (/^-{2,}\s*original message\s*-{2,}$/i.test(line)) {
      cutIndex = i;
      break;
    }

    // Outlook: block starting with "From:" after a blank line
    if (
      /^from:\s/i.test(line) &&
      i > 0 &&
      lines[i - 1]!.trim() === ""
    ) {
      // Verify next lines look like an Outlook header block
      const nextLine = lines[i + 1]?.trim() ?? "";
      if (/^(sent|to|cc|subject|date):\s/i.test(nextLine)) {
        cutIndex = i;
        break;
      }
    }

    // Standard "> " quoting: cut at first block of quoted lines
    if (line.startsWith(">")) {
      // Only cut if the previous line is blank or a "wrote:" line
      if (i === 0 || lines[i - 1]!.trim() === "" || /wrote:\s*$/i.test(lines[i - 1]!)) {
        cutIndex = i;
        break;
      }
    }
  }

  return lines.slice(0, cutIndex).join("\n").trimEnd();
}

// ---------------------------------------------------------------------------
// Markdown → email-safe HTML
// ---------------------------------------------------------------------------

/**
 * Convert a markdown-ish agent response to simple email-safe HTML.
 *
 * This is intentionally lightweight — no external dependency. It handles the
 * most common patterns agents produce: paragraphs, bold, italic, inline code,
 * code blocks, unordered/ordered lists, and headings.
 */
export function markdownToEmailHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  let html = escaped;

  // Fenced code blocks
  html = html.replace(
    /```(?:\w*)\n([\s\S]*?)```/g,
    (_m, code: string) =>
      `<pre style="background:#f5f5f5;padding:12px;border-radius:4px;overflow-x:auto;font-family:monospace;font-size:13px;">${code.trimEnd()}</pre>`,
  );

  // Inline code
  html = html.replace(
    /`([^`]+)`/g,
    '<code style="background:#f5f5f5;padding:2px 4px;border-radius:3px;font-family:monospace;font-size:13px;">$1</code>',
  );

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

  // Italic
  html = html.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");

  // Headings (### before ## before #)
  html = html.replace(/^### (.+)$/gm, '<h3 style="margin:16px 0 8px;">$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2 style="margin:16px 0 8px;">$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1 style="margin:16px 0 8px;">$1</h1>');

  // Unordered lists
  html = html.replace(
    /(?:^[*-] .+(?:\n|$))+/gm,
    (block) => {
      const items = block.trim().split("\n").map((l) => `<li>${l.replace(/^[*-] /, "")}</li>`);
      return `<ul style="margin:8px 0;padding-left:24px;">${items.join("")}</ul>`;
    },
  );

  // Ordered lists
  html = html.replace(
    /(?:^\d+\. .+(?:\n|$))+/gm,
    (block) => {
      const items = block.trim().split("\n").map((l) => `<li>${l.replace(/^\d+\. /, "")}</li>`);
      return `<ol style="margin:8px 0;padding-left:24px;">${items.join("")}</ol>`;
    },
  );

  // Paragraphs: double newlines become paragraph breaks
  html = html
    .split(/\n{2,}/)
    .map((p) => {
      const trimmed = p.trim();
      if (!trimmed) return "";
      // Don't wrap block-level elements
      if (/^<(?:h[1-6]|ul|ol|pre|blockquote)/i.test(trimmed)) return trimmed;
      return `<p style="margin:8px 0;">${trimmed.replace(/\n/g, "<br>")}</p>`;
    })
    .join("\n");

  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.6;color:#1a1a1a;">${html}</div>`;
}

// ---------------------------------------------------------------------------
// Sender allowlist matching
// ---------------------------------------------------------------------------

/**
 * Check whether a sender email matches any pattern in an allowlist.
 * Patterns can be exact addresses or domain wildcards like `*@example.com`.
 * Returns `true` if the list is empty/undefined (no restriction).
 */
export function matchesSenderPattern(
  sender: string,
  patterns: string[] | undefined,
): boolean {
  if (!patterns || patterns.length === 0) return true;
  const addr = sender.toLowerCase();
  return patterns.some((pattern) => {
    const p = pattern.toLowerCase();
    if (p.startsWith("*@")) {
      return addr.endsWith(p.slice(1));
    }
    return addr === p;
  });
}
