---
"@poncho-ai/cli": patch
---

dev: capture heap snapshot on OOM in `poncho dev`

`poncho dev` now re-execs itself with `NODE_OPTIONS=--heapsnapshot-near-heap-limit=2 --max-old-space-size=4096`
so that when the dev server hits the heap limit, V8 writes a
`Heap.<ts>.heapsnapshot` file to the working directory before terminating.
Open it in Chrome DevTools → Memory to inspect retainers when investigating
memory leaks. Skipped if the user already set `NODE_OPTIONS`.
