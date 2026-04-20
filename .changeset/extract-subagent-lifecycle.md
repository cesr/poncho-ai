---
"@poncho-ai/harness": minor
"@poncho-ai/cli": patch
---

refactor: extract subagent lifecycle into AgentOrchestrator (phase 5)

Move subagent orchestration (~1100 lines) from the CLI into the
AgentOrchestrator class in the harness package. The orchestrator now
owns all subagent state (activeSubagentRuns, pendingSubagentApprovals,
pendingCallbackNeeded), lifecycle methods (runSubagent,
processSubagentCallback, triggerParentCallback), SubagentManager
creation, approval handling, and stale recovery.

New hooks on OrchestratorHooks allow transport-specific concerns
(child harness creation, serverless dispatch, SSE stream lifecycle,
messaging notifications) to stay in the CLI while the orchestrator
handles all orchestration logic.

Also fixes subagent approval persistence (decisions now explicitly
written to the conversation store) and adds live SSE streaming for
parent callback runs in the web UI.
