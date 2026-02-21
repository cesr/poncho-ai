# @poncho-ai/messaging

## 0.2.0

### Minor Changes

- [#10](https://github.com/cesr/poncho-ai/pull/10) [`d5bce7b`](https://github.com/cesr/poncho-ai/commit/d5bce7be5890c657bea915eb0926feb6de66b218) Thanks [@cesr](https://github.com/cesr)! - Add generic messaging layer with Slack as the first adapter. Agents can now respond to @mentions in Slack by adding `messaging: [{ platform: 'slack' }]` to `poncho.config.js`. Includes signature verification, threaded conversations, processing indicators, and Vercel `waitUntil` support.

### Patch Changes

- Updated dependencies [[`d5bce7b`](https://github.com/cesr/poncho-ai/commit/d5bce7be5890c657bea915eb0926feb6de66b218)]:
  - @poncho-ai/sdk@1.0.1
