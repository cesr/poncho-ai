---
"@poncho-ai/cli": patch
---

cli: fix `poncho build` Dockerfile scaffolds for docker/railway/fly

Three issues with the scaffolded Dockerfiles:

1. **Base image was `node:20-slim`**, but `isolated-vm@6.1.2` (used by
   the bash sandbox / `run_code`) only ships prebuilt binaries for Node
   22+ ABIs. On Node 20, npm fell back to compiling from source, which
   fails because the C++ code references `v8::SourceLocation` — a V8 12
   API not present in Node 20's V8 11. Bumped to `node:22-slim`.

2. **Server entrypoint couldn't find `@poncho-ai/cli`.** The Dockerfile
   ran `npm install -g @poncho-ai/cli` but `server.js` does
   `import { startDevServer } from "@poncho-ai/cli"`. Globally installed
   packages aren't on Node's ESM resolution path without `NODE_PATH`,
   so the import failed at runtime. Replaced with `npm install --omit=dev`
   so the CLI (and any other deps in the user's `package.json`) is
   installed locally in `/app/node_modules`.

3. **Browser tools didn't work.** When `browser: true` is set in
   `poncho.config.js`, Playwright needs system Chromium libs that
   `node:22-slim` doesn't include. The scaffold now detects browser
   config and conditionally adds an `apt-get install` layer with the
   required libs (`libnss3`, `libxkbcommon0`, etc.) — only when needed,
   so users without browser keep a lean image.

Also reordered `COPY package.json` + `RUN npm install` to run before
copying app code, so `npm install` is cached across edits to `AGENT.md`,
skills, and tests.
