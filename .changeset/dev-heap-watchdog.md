---
"@poncho-ai/cli": patch
---

dev: add proactive heap-snapshot watchdog and SIGUSR2 trigger

`--heapsnapshot-near-heap-limit` can fail to fire on real OOMs because V8 is
too memory-starved to allocate the snapshot buffer by the time the hook
runs. `poncho dev` now also runs a watchdog that calls
`v8.writeHeapSnapshot()` proactively when `heapUsed` crosses 1.5 GB, 2.5 GB,
and 3.3 GB — so we get evidence before the process is doomed. Snapshots
land in cwd as `poncho-heap-auto-<threshold>mb-<ts>.heapsnapshot`.

Also handles SIGUSR2: `kill -USR2 <pid>` writes a snapshot on demand for
when you want to grab one without waiting for a threshold.
