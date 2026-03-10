---
"@poncho-ai/harness": patch
"@poncho-ai/cli": patch
---

Fix LocalUploadStore ENOENT on Vercel: use /tmp for uploads on serverless environments instead of the read-only working directory.
