---
"@poncho-ai/harness": patch
---

harness: strip `poncho-upload://` scheme in `S3UploadStore.get` / `.delete`

`createUploadStore({ provider: "s3" })` wraps `S3UploadStore` in
`CachedUploadStore`, whose `put` returns a `poncho-upload://<key>` ref
and stores the underlying S3 object at the bare `<key>`. On read,
`CachedUploadStore.get` checks an in-memory cache (10-minute TTL); on
miss it falls through to `S3UploadStore.get(<ref>)`. Pre-fix, the S3
store treated the scheme-prefixed ref as a literal S3 key and hit the
backend with `poncho-upload://<key>` — guaranteed `NoSuchKey`.

In practice this meant a chat message with an attached image worked on
the turn it was uploaded (cache hit) and then started showing as
"[Attached file: … — file is no longer available]" on every follow-up
turn ~10 minutes later (cache miss → S3 NoSuchKey → outer catch in the
harness resolver). The same path worked for the local-fs store, which
strips the scheme in both `get` and `delete`.

`S3UploadStore.get` now strips the scheme before issuing
`GetObjectCommand`. `S3UploadStore.delete` already stripped `https://`
and now strips `poncho-upload://` too.
