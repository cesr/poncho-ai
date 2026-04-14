---
"@poncho-ai/harness": patch
---

fix: route file tools through MountableFs so `/project/` paths resolve correctly

`edit_file`, `read_file`, and `write_file` were hitting `engine.vfs` directly, which has no knowledge of the `/project/` mount that bash uses via `MountableFs`. This caused `edit_file` to throw "File not found" on `/project/` paths that bash could see fine. All three file tools now receive a filesystem factory from `BashEnvironmentManager.getFs()` that returns the same combined filesystem (VFS + `/project/` overlay) that bash uses.
