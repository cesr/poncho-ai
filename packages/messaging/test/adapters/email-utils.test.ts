import { describe, expect, it } from "vitest";
import {
  buildReplyHeaders,
  buildReplySubject,
  deriveRootMessageId,
  extractDisplayName,
  extractEmailAddress,
  markdownToEmailHtml,
  matchesSenderPattern,
  parseReferences,
  stripQuotedReply,
} from "../../src/adapters/email/utils.js";

// ---------------------------------------------------------------------------
// extractEmailAddress
// ---------------------------------------------------------------------------

describe("extractEmailAddress", () => {
  it("extracts from formatted address", () => {
    expect(extractEmailAddress("Alice <alice@example.com>")).toBe("alice@example.com");
  });

  it("handles bare email", () => {
    expect(extractEmailAddress("bob@test.com")).toBe("bob@test.com");
  });

  it("lowercases the result", () => {
    expect(extractEmailAddress("Alice <Alice@Example.COM>")).toBe("alice@example.com");
  });

  it("handles quoted display name", () => {
    expect(extractEmailAddress('"Alice B" <alice@example.com>')).toBe("alice@example.com");
  });
});

// ---------------------------------------------------------------------------
// extractDisplayName
// ---------------------------------------------------------------------------

describe("extractDisplayName", () => {
  it("extracts name from formatted address", () => {
    expect(extractDisplayName("Alice <alice@example.com>")).toBe("Alice");
  });

  it("returns undefined for bare email", () => {
    expect(extractDisplayName("bob@test.com")).toBeUndefined();
  });

  it("strips surrounding quotes", () => {
    expect(extractDisplayName('"Alice B" <alice@example.com>')).toBe("Alice B");
  });
});

// ---------------------------------------------------------------------------
// parseReferences
// ---------------------------------------------------------------------------

describe("parseReferences", () => {
  it("parses space-separated message IDs", () => {
    const headers = [
      { name: "References", value: "<msg1@a.com> <msg2@b.com> <msg3@c.com>" },
    ];
    expect(parseReferences(headers)).toEqual([
      "<msg1@a.com>",
      "<msg2@b.com>",
      "<msg3@c.com>",
    ]);
  });

  it("returns empty array when no References header", () => {
    expect(parseReferences([{ name: "Subject", value: "hi" }])).toEqual([]);
  });

  it("returns empty array for undefined headers", () => {
    expect(parseReferences(undefined)).toEqual([]);
  });

  it("is case-insensitive for header name", () => {
    const headers = [{ name: "references", value: "<msg@a.com>" }];
    expect(parseReferences(headers)).toEqual(["<msg@a.com>"]);
  });

  it("handles object-style headers (Record<string, string>)", () => {
    const headers = { References: "<msg1@a.com> <msg2@b.com>" };
    expect(parseReferences(headers)).toEqual(["<msg1@a.com>", "<msg2@b.com>"]);
  });

  it("handles object-style headers case-insensitively", () => {
    const headers = { references: "<msg@a.com>" };
    expect(parseReferences(headers)).toEqual(["<msg@a.com>"]);
  });

  it("returns empty array for object headers without References", () => {
    const headers = { Subject: "hi", From: "alice@a.com" };
    expect(parseReferences(headers)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// deriveRootMessageId
// ---------------------------------------------------------------------------

describe("deriveRootMessageId", () => {
  it("returns first reference when available", () => {
    expect(
      deriveRootMessageId(["<root@a.com>", "<reply@a.com>"], "<current@a.com>"),
    ).toBe("<root@a.com>");
  });

  it("falls back to subject+sender hash when no references", () => {
    const result = deriveRootMessageId([], "<current@a.com>", {
      subject: "Hello",
      sender: "alice@example.com",
    });
    expect(result).toMatch(/^<fallback:[0-9a-f]+>$/);
  });

  it("produces stable fallback for same subject+sender", () => {
    const a = deriveRootMessageId([], "<a@a.com>", { subject: "Hello", sender: "alice@a.com" });
    const b = deriveRootMessageId([], "<b@b.com>", { subject: "Hello", sender: "alice@a.com" });
    expect(a).toBe(b);
  });

  it("normalises Re: prefixes in fallback", () => {
    const a = deriveRootMessageId([], "<a@a.com>", { subject: "Hello", sender: "alice@a.com" });
    const b = deriveRootMessageId([], "<b@b.com>", { subject: "Re: Hello", sender: "alice@a.com" });
    expect(a).toBe(b);
  });

  it("falls back to current message ID as last resort", () => {
    expect(deriveRootMessageId([], "<current@a.com>")).toBe("<current@a.com>");
  });
});

// ---------------------------------------------------------------------------
// buildReplySubject
// ---------------------------------------------------------------------------

describe("buildReplySubject", () => {
  it("prepends Re: to a plain subject", () => {
    expect(buildReplySubject("Q4 Revenue")).toBe("Re: Q4 Revenue");
  });

  it("does not double-prefix", () => {
    expect(buildReplySubject("Re: Q4 Revenue")).toBe("Re: Q4 Revenue");
  });

  it("handles case-insensitive Re:", () => {
    expect(buildReplySubject("RE: Q4 Revenue")).toBe("RE: Q4 Revenue");
  });
});

// ---------------------------------------------------------------------------
// buildReplyHeaders
// ---------------------------------------------------------------------------

describe("buildReplyHeaders", () => {
  it("builds In-Reply-To and References headers", () => {
    const headers = buildReplyHeaders("<msg2@a.com>", ["<msg1@a.com>"]);
    expect(headers["In-Reply-To"]).toBe("<msg2@a.com>");
    expect(headers["References"]).toBe("<msg1@a.com> <msg2@a.com>");
  });

  it("does not duplicate inReplyTo in references", () => {
    const headers = buildReplyHeaders("<msg1@a.com>", ["<msg1@a.com>"]);
    expect(headers["References"]).toBe("<msg1@a.com>");
  });
});

// ---------------------------------------------------------------------------
// stripQuotedReply
// ---------------------------------------------------------------------------

describe("stripQuotedReply", () => {
  it("strips Gmail-style quoted replies", () => {
    const text = "Thanks for the info.\n\nOn Mon, Jan 1, 2024, Alice wrote:\n> Previous message";
    expect(stripQuotedReply(text)).toBe("Thanks for the info.");
  });

  it("strips Outlook-style original message markers", () => {
    const text = "Got it.\n\n-----Original Message-----\nFrom: Bob\nSent: Monday";
    expect(stripQuotedReply(text)).toBe("Got it.");
  });

  it("strips Outlook From:/Sent: header blocks", () => {
    const text = "Sure thing.\n\nFrom: Alice <alice@example.com>\nSent: Monday, January 1\nTo: Bob";
    expect(stripQuotedReply(text)).toBe("Sure thing.");
  });

  it("strips > quoting after a blank line", () => {
    const text = "My reply.\n\n> Previous line 1\n> Previous line 2";
    expect(stripQuotedReply(text)).toBe("My reply.");
  });

  it("preserves text with no quoted content", () => {
    const text = "Just a plain message.";
    expect(stripQuotedReply(text)).toBe("Just a plain message.");
  });

  it("preserves > that is not a quote (no blank line before)", () => {
    const text = "The value should be > 5\nand also > 10";
    expect(stripQuotedReply(text)).toBe("The value should be > 5\nand also > 10");
  });
});

// ---------------------------------------------------------------------------
// markdownToEmailHtml
// ---------------------------------------------------------------------------

describe("markdownToEmailHtml", () => {
  it("wraps output in a styled div", () => {
    const html = markdownToEmailHtml("Hello");
    expect(html).toContain("<div");
    expect(html).toContain("font-family:");
  });

  it("converts bold text", () => {
    const html = markdownToEmailHtml("This is **bold** text.");
    expect(html).toContain("<strong>bold</strong>");
  });

  it("converts inline code", () => {
    const html = markdownToEmailHtml("Use `npm install`.");
    expect(html).toContain("<code");
    expect(html).toContain("npm install");
  });

  it("converts fenced code blocks", () => {
    const html = markdownToEmailHtml("```js\nconsole.log('hi');\n```");
    expect(html).toContain("<pre");
    expect(html).toContain("console.log");
  });

  it("converts unordered lists", () => {
    const html = markdownToEmailHtml("- Item A\n- Item B");
    expect(html).toContain("<ul");
    expect(html).toContain("<li>Item A</li>");
  });

  it("converts ordered lists", () => {
    const html = markdownToEmailHtml("1. First\n2. Second");
    expect(html).toContain("<ol");
    expect(html).toContain("<li>First</li>");
  });

  it("escapes HTML entities", () => {
    const html = markdownToEmailHtml("Use <script> & stuff");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
  });
});

// ---------------------------------------------------------------------------
// matchesSenderPattern
// ---------------------------------------------------------------------------

describe("matchesSenderPattern", () => {
  it("returns true when no patterns (open inbox)", () => {
    expect(matchesSenderPattern("anyone@anywhere.com", undefined)).toBe(true);
    expect(matchesSenderPattern("anyone@anywhere.com", [])).toBe(true);
  });

  it("matches exact email", () => {
    expect(matchesSenderPattern("alice@example.com", ["alice@example.com"])).toBe(true);
  });

  it("rejects non-matching email", () => {
    expect(matchesSenderPattern("bob@other.com", ["alice@example.com"])).toBe(false);
  });

  it("matches domain wildcard", () => {
    expect(matchesSenderPattern("anyone@myco.com", ["*@myco.com"])).toBe(true);
  });

  it("rejects non-matching domain", () => {
    expect(matchesSenderPattern("anyone@other.com", ["*@myco.com"])).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(matchesSenderPattern("Alice@EXAMPLE.com", ["alice@example.com"])).toBe(true);
    expect(matchesSenderPattern("Alice@MYCO.COM", ["*@myco.com"])).toBe(true);
  });

  it("matches against multiple patterns", () => {
    const patterns = ["alice@a.com", "*@b.com"];
    expect(matchesSenderPattern("alice@a.com", patterns)).toBe(true);
    expect(matchesSenderPattern("bob@b.com", patterns)).toBe(true);
    expect(matchesSenderPattern("carol@c.com", patterns)).toBe(false);
  });
});
