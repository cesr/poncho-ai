---
"@poncho-ai/harness": patch
---

harness: properly decode `FileInput.data` per its documented contract

`FileInput.data` is documented in `@poncho-ai/sdk` as accepting raw
base64, `data:<mime>;base64,<…>` URIs, or `https?://` URLs. The
runtime used to call `Buffer.from(data, "base64")` unconditionally,
which silently produced garbage bytes for data URIs (Node's base64
decoder ignores invalid chars like `:` `;` `,` rather than throwing,
so the file's magic bytes were destroyed). Anthropic responded with
"Could not process image" on every turn that attached an image as a
data URI — including PonchOS's `resolveAttachment`, which built data
URIs by following the documented format.

Introduce `decodeFileInputData(data)` in `upload-store.ts` that
detects the three formats and decodes accordingly, and call it from
`AgentHarness.run` and `runConversationTurn` instead of the inline
`Buffer.from(_, "base64")`. Pinned by a new test that exercises raw
base64, simple data URIs, and data URIs with mime parameters.

Callers that have been passing raw base64 all along see no behavior
change.
