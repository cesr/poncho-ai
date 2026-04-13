---
"@poncho-ai/harness": minor
---

perf: promote parentConversationId, pendingApprovals, and channelMeta to dedicated columns so list/summary queries no longer fetch the full data JSONB blob — dramatically reduces database egress
