---
"@poncho-ai/harness": minor
---

VFS adapter now supports read-only virtual mounts. `HarnessOptions.virtualMounts` accepts entries like `{ prefix: "/system/", source: "/path/on/disk" }`; reads under the prefix are served from the local filesystem source directory, writes are rejected with `EROFS`. Used by platforms (e.g. PonchOS) to expose deployment-shipped defaults without persisting them in each tenant's VFS — improvements ship via normal deploys and tenant data stays portable. Empty by default; CLI/dev workflows are unaffected.
