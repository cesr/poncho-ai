import { describe, expect, it } from "vitest";
import { decodeFileInputData } from "../src/upload-store.js";

// FileInput.data is documented in @poncho-ai/sdk as accepting three formats:
// raw base64, `data:<mime>;base64,<…>` URIs, and `http(s)://…` URLs. The
// runtime used to call `Buffer.from(data, "base64")` unconditionally, which
// silently produced garbage bytes for data URIs (Node's base64 decoder
// ignores invalid chars like `:` `;` `,` rather than throwing, so the JPEG
// magic bytes were destroyed and Anthropic responded with "Could not
// process image"). These tests pin the contract so it can't regress.

// 1x1 transparent PNG, base64-encoded.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PNG_FIRST_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // ‰PNG

describe("decodeFileInputData", () => {
  it("decodes raw base64", async () => {
    const out = await decodeFileInputData(PNG_BASE64);
    expect(out.subarray(0, 4).equals(PNG_FIRST_BYTES)).toBe(true);
  });

  it("decodes a data: URI", async () => {
    const out = await decodeFileInputData(`data:image/png;base64,${PNG_BASE64}`);
    expect(out.subarray(0, 4).equals(PNG_FIRST_BYTES)).toBe(true);
  });

  it("decodes a data: URI even when the mime has parameters", async () => {
    // The contract allows arbitrary `data:<anything>;base64,` prefixes — only
    // the `;base64,` part is load-bearing. Used in the wild for things like
    // `data:image/svg+xml;base64,...`.
    const out = await decodeFileInputData(
      `data:image/svg+xml;charset=utf-8;base64,${PNG_BASE64}`,
    );
    expect(out.subarray(0, 4).equals(PNG_FIRST_BYTES)).toBe(true);
  });

  it("decoded bytes from raw base64 and data URI match", async () => {
    const raw = await decodeFileInputData(PNG_BASE64);
    const uri = await decodeFileInputData(`data:image/png;base64,${PNG_BASE64}`);
    expect(raw.equals(uri)).toBe(true);
  });
});
