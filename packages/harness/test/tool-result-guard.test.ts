import { describe, expect, it } from "vitest";
import {
  DEFAULT_OVERSIZED_TOOL_RESULT_CHARS,
  DEFAULT_SPILL_DIR,
  DEFAULT_SPILL_KEEP_LAST,
  INLINE_TRUNCATE_PREVIEW_CHARS,
  SPILLED_PREVIEW_CHARS,
  buildInlineTruncation,
  buildSpillHandle,
  formatSpillPayload,
  isOversizedToolResult,
  readSpillPolicy,
} from "../src/tool-result-guard.js";

describe("readSpillPolicy", () => {
  it("defaults to disabled with safe defaults when the param is absent", () => {
    expect(readSpillPolicy(undefined)).toEqual({
      enabled: false,
      dir: DEFAULT_SPILL_DIR,
      thresholdChars: DEFAULT_OVERSIZED_TOOL_RESULT_CHARS,
      keepLast: DEFAULT_SPILL_KEEP_LAST,
    });
  });

  it("defaults when the param is malformed", () => {
    expect(readSpillPolicy({ __toolResultSpill: "nope" }).enabled).toBe(false);
    expect(readSpillPolicy({ __toolResultSpill: 42 }).dir).toBe(DEFAULT_SPILL_DIR);
  });

  it("reads enabled + dir + threshold + keepLast", () => {
    const p = readSpillPolicy({
      __toolResultSpill: { enabled: true, dir: "/tmp/x", thresholdChars: 1000, keepLast: 5 },
    });
    expect(p).toEqual({ enabled: true, dir: "/tmp/x", thresholdChars: 1000, keepLast: 5 });
  });

  it("rejects a non-absolute dir, a non-positive threshold, and a bad keepLast", () => {
    const p = readSpillPolicy({
      __toolResultSpill: { enabled: true, dir: "relative", thresholdChars: 0, keepLast: -3 },
    });
    expect(p.dir).toBe(DEFAULT_SPILL_DIR);
    expect(p.thresholdChars).toBe(DEFAULT_OVERSIZED_TOOL_RESULT_CHARS);
    expect(p.keepLast).toBe(DEFAULT_SPILL_KEEP_LAST);
  });

  it("only treats enabled === true as enabled (not truthy strings)", () => {
    expect(readSpillPolicy({ __toolResultSpill: { enabled: "yes" } }).enabled).toBe(false);
    expect(readSpillPolicy({ __toolResultSpill: { enabled: 1 } }).enabled).toBe(false);
  });
});

describe("isOversizedToolResult", () => {
  const policy = readSpillPolicy({ __toolResultSpill: { enabled: true, thresholdChars: 100 } });
  it("is false at or below the threshold (boundary)", () => {
    expect(isOversizedToolResult("a".repeat(100), policy)).toBe(false);
    expect(isOversizedToolResult("a".repeat(99), policy)).toBe(false);
  });
  it("is true above the threshold", () => {
    expect(isOversizedToolResult("a".repeat(101), policy)).toBe(true);
  });
});

describe("formatSpillPayload", () => {
  it("formats an array as JSONL with a record count", () => {
    const r = formatSpillPayload([{ a: 1 }, { b: 2 }, { c: 3 }]);
    expect(r.format).toBe("jsonl");
    expect(r.records).toBe(3);
    expect(r.content.split("\n")).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it("formats a non-array as pretty JSON with no record count", () => {
    const r = formatSpillPayload({ hello: "world" });
    expect(r.format).toBe("json");
    expect(r.records).toBeUndefined();
    expect(r.content).toBe('{\n  "hello": "world"\n}');
  });

  it("handles null", () => {
    expect(formatSpillPayload(null)).toEqual({ content: "null", format: "json" });
  });
});

describe("buildSpillHandle", () => {
  it("returns a handle with path, format, records, preview, the call id, and bash instructions", () => {
    const serialized = "x".repeat(SPILLED_PREVIEW_CHARS + 50_000);
    const h = buildSpillHandle({
      toolName: "mcp_gmail_GMAIL_FETCH_EMAILS",
      toolCallId: "toolu_01Ctij",
      path: "/tmp/tool-results/mcp_gmail_GMAIL_FETCH_EMAILS_toolu_01Ctij.jsonl",
      format: "jsonl",
      serialized,
      records: 312,
    });
    expect(h.__toolResultSpilled).toBe(true);
    expect(h.records).toBe(312);
    expect(h.totalChars).toBe(serialized.length);
    expect((h.preview as string).length).toBe(SPILLED_PREVIEW_CHARS);
    // Issue 1: the call id is exposed explicitly (not just embedded in the path).
    expect(h.toolCallId).toBe("toolu_01Ctij");
    expect(h.toolResultId).toBe("toolu_01Ctij");
    expect(String(h.note)).toContain("/tmp/tool-results/");
    expect(String(h.note)).toContain("Do NOT cat");
    // JSONL: line tools are valid (one record per line).
    expect(String(h.note)).toContain("sed -n");
  });

  it("json format steers AWAY from line tools and toward byte-offset / jq (Issue 3)", () => {
    const h = buildSpillHandle({
      toolName: "run_code",
      toolCallId: "toolu_2",
      path: "/tmp/tool-results/run_code_toolu_2.json",
      format: "json",
      serialized: "y".repeat(10),
    });
    expect(h.records).toBeUndefined();
    const note = String(h.note);
    // It must warn that wc -l / grep mislead, and point at byte-offset + jq -r.
    expect(note).toContain("MISLEAD");
    expect(note).toContain("tail -c +");
    expect(note).toContain("jq -r");
    // It must NOT suggest sed-by-line for escaped-JSON.
    expect(note).not.toContain("sed -n");
  });
});

describe("buildInlineTruncation", () => {
  it("returns a truncation marker with a capped preview and omitted-char count", () => {
    const serialized = "z".repeat(INLINE_TRUNCATE_PREVIEW_CHARS + 1234);
    const t = buildInlineTruncation("some_tool", serialized);
    expect(t.__toolResultTruncated).toBe(true);
    expect((t.preview as string).length).toBe(INLINE_TRUNCATE_PREVIEW_CHARS);
    expect(t.omittedChars).toBe(1234);
    expect(String(t.note)).toContain("Do NOT retry");
  });
});
