// Oversized FRESH tool-result guard — pure logic.
//
// `truncateHistoricalToolResults` (in harness.ts) only shrinks results from
// PRIOR runs — it deliberately preserves the latest run's results so the model
// can read what it just fetched. So a single fresh result that is itself larger
// than the context window is never truncated, and the next step fails with
// "prompt is too long" (seen with MCP email-fetch tools returning 1.6M–3.3M
// token payloads). This module decides what to put in front of the model when
// that happens; the I/O (the VFS write + prune) lives on the Harness class,
// which has the per-tenant filesystem. Splitting the pure decision out keeps it
// unit-testable without a Harness instance.

/** Run parameter key carrying the spill policy (a freeform-params bag entry,
 *  same mechanism as `__toolResultArchive`). */
export const SPILL_POLICY_PARAM = "__toolResultSpill";

/** Results whose serialized form exceeds this many chars are guarded. ~125k
 *  tokens — well under any current window, well above any normal result, so
 *  normal-sized results are never touched. */
export const DEFAULT_OVERSIZED_TOOL_RESULT_CHARS = 500_000;
/** Preview kept inline when SPILLING — small, because the full payload is in
 *  the file. */
export const SPILLED_PREVIEW_CHARS = 6_000;
/** Preview kept inline when TRUNCATING — larger, because there's no file to
 *  fall back to. */
export const INLINE_TRUNCATE_PREVIEW_CHARS = 60_000;
export const DEFAULT_SPILL_DIR = "/tmp/tool-results";
export const DEFAULT_SPILL_KEEP_LAST = 20;

export interface ToolResultSpillPolicy {
  enabled: boolean;
  dir: string;
  thresholdChars: number;
  keepLast: number;
}

/** Parse the spill policy out of the run parameters, applying defaults. A
 *  missing/malformed bag yields a disabled policy with safe defaults. */
export const readSpillPolicy = (
  parameters: Record<string, unknown> | undefined,
): ToolResultSpillPolicy => {
  const raw = parameters?.[SPILL_POLICY_PARAM];
  const obj = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const thresholdChars =
    typeof obj.thresholdChars === "number" && obj.thresholdChars > 0
      ? obj.thresholdChars
      : DEFAULT_OVERSIZED_TOOL_RESULT_CHARS;
  const dir =
    typeof obj.dir === "string" && obj.dir.startsWith("/") ? obj.dir : DEFAULT_SPILL_DIR;
  const keepLast =
    typeof obj.keepLast === "number" && obj.keepLast > 0
      ? Math.floor(obj.keepLast)
      : DEFAULT_SPILL_KEEP_LAST;
  return { enabled: obj.enabled === true, dir, thresholdChars, keepLast };
};

/** True when this serialized result is large enough to need guarding. */
export const isOversizedToolResult = (
  serialized: string,
  policy: ToolResultSpillPolicy,
): boolean => serialized.length > policy.thresholdChars;

/** Serialize an oversized payload for the spill file. Arrays become JSONL (one
 *  record per line — bash/jq/sed friendly, line ranges map to records); other
 *  shapes become pretty JSON. */
export const formatSpillPayload = (
  output: unknown,
): { content: string; format: "jsonl" | "json"; records?: number } => {
  if (Array.isArray(output)) {
    return {
      content: output.map((row) => JSON.stringify(row)).join("\n"),
      format: "jsonl",
      records: output.length,
    };
  }
  return { content: JSON.stringify(output ?? null, null, 2), format: "json" };
};

/** The handle object placed in front of the model when a result is spilled to
 *  a file: a small preview plus the path and bash-readback instructions. */
export const buildSpillHandle = (opts: {
  toolName: string;
  toolCallId: string;
  path: string;
  format: "jsonl" | "json";
  serialized: string;
  records?: number;
}): Record<string, unknown> => {
  const { toolName, toolCallId, path, format, serialized, records } = opts;
  const approxTokens = Math.ceil(serialized.length / 4);
  // Byte-offset reads are correct for BOTH formats; line tools (`wc -l`,
  // `grep`, `sed -n`) only behave for JSONL (one record per line). For pretty
  // JSON the payload is a JSON document whose string fields (e.g. a command's
  // stdout) carry escaped `\n` on a single line, so `wc -l`/`grep` mislead —
  // unescape with `jq -r` first. Tailor the hint to the format so the model
  // doesn't act on wrong line/match counts.
  const bytesHint =
    `\`wc -c ${path}\` (size), \`head -c 4000 ${path}\`, ` +
    `\`tail -c +<N> ${path} | head -c 4000\` (read from byte N)`;
  const note =
    format === "jsonl"
      ? `Result too large to return inline (~${approxTokens.toLocaleString()} tokens, ` +
        `${records} records, one JSON object per line). Read it with bash: ${bytesHint}, ` +
        `\`sed -n '1,5p' ${path}\`, \`grep -i <term> ${path}\`, or \`jq -c 'select(...)' ${path}\` ` +
        `per line. Do NOT cat/read_file the whole file (it re-overflows). Or re-run the tool ` +
        `with a narrower request.`
      : `Result too large to return inline (~${approxTokens.toLocaleString()} tokens, JSON). ` +
        `Its string fields are escaped onto single lines, so \`wc -l\`/\`grep\` MISLEAD — ` +
        `read by byte offset (${bytesHint}) or unescape first with ` +
        `\`jq -r '.stdout // .' ${path}\` (then pipe to wc -l / grep). Do NOT cat/read_file the ` +
        `whole file (it re-overflows). Or re-run the tool with a narrower request.`;
  return {
    __toolResultSpilled: true,
    tool: toolName,
    // Expose the id explicitly so the model passes the right value if it
    // reaches for get_tool_result_by_id (the path stem is NOT the id).
    toolResultId: toolCallId,
    toolCallId,
    path,
    format,
    ...(records !== undefined ? { records } : {}),
    totalChars: serialized.length,
    approxTokens,
    preview: serialized.slice(0, SPILLED_PREVIEW_CHARS),
    note,
  };
};

/** The replacement placed in front of the model when a result is too large and
 *  spill is unavailable: a preview plus a "re-run narrower" instruction. */
export const buildInlineTruncation = (
  toolName: string,
  serialized: string,
): Record<string, unknown> => {
  const approxTokens = Math.ceil(serialized.length / 4);
  const omittedChars = Math.max(0, serialized.length - INLINE_TRUNCATE_PREVIEW_CHARS);
  return {
    __toolResultTruncated: true,
    tool: toolName,
    approxTokens,
    omittedChars,
    preview: serialized.slice(0, INLINE_TRUNCATE_PREVIEW_CHARS),
    note:
      `This result was too large (~${approxTokens.toLocaleString()} tokens) and was ` +
      `truncated to fit the context window — only the first ` +
      `${INLINE_TRUNCATE_PREVIEW_CHARS.toLocaleString()} characters are shown. Re-run ` +
      `with a narrower request (fewer items / a filter / metadata only). Do NOT retry ` +
      `the same call unchanged — it will overflow again.`,
  };
};
