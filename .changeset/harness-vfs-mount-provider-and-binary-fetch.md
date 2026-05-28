---
"@poncho-ai/harness": minor
---

harness: provider-backed VFS mounts + binary fetch bodies

Two additive isolate/VFS changes.

**`MountProvider` for `VirtualMount`.** A virtual mount can now be backed
by a custom data source instead of a local-disk directory. Set
`provider: { readdir, stat, readFileBuffer }` instead of `source` on a
`VirtualMount`. The adapter routes read operations through the provider
and rejects writes the same way it does for disk-backed mounts. Lets a
host expose database rows / object-store keys as a VFS subtree without
materialising them on disk (e.g. PonchOS exposing user uploads at
`/uploads`). `getAllPaths` advertises only the mount root for provider
mounts (deep listing would require sync IO over a remote backend);
shallow listing is sufficient for bash glob/find at the mount root.

**Binary `fetch()` bodies in `run_code`.** The isolate fetch polyfill
used to coerce `init.body` to a string before sending it to the
`__poncho_fetch` binding, so passing a `Uint8Array`, `ArrayBuffer`, or
`Blob` arrived server-side as `"1,2,3,..."` — every binary upload
(image-edit APIs, file uploads) was corrupted. The polyfill now
base64-encodes binary bodies with a new `bodyEncoding: "base64"` field
on the binding input; the built-in `createFetchBinding` decodes back to
raw bytes before fetching. Custom bindings that replace `__poncho_fetch`
should add the same decoding (cf. PonchOS `createSecretAwareFetchBinding`).
String bodies are unchanged.
