---
"@poncho-ai/harness": patch
---

fix(harness): surface real `isolated-vm` load error instead of generic message

The previous error told users "Run: pnpm add isolated-vm" even when the
package was installed but the native binary couldn't be loaded — typically
because a Node upgrade left the installed prebuilds with the wrong ABI
version (e.g. Node 25 reports ABI 141 but `isolated-vm@6.1.2` only ships
abi127/abi137 prebuilds). Now the error includes the underlying load
message, the current Node version + ABI, and a hint to rebuild rather
than reinstall when the cause is a binary mismatch.
