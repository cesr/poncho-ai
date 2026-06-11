import type { AgentFailure, Message, RunResult } from "@poncho-ai/sdk";

export interface SubagentResult {
  subagentId: string;
  status: "completed" | "error" | "stopped";
  latestMessages?: Message[];
  result?: RunResult;
  error?: AgentFailure;
}

export interface SubagentSummary {
  subagentId: string;
  task: string;
  status: string;
  messageCount: number;
}

export interface SubagentSpawnResult {
  subagentId: string;
}

export type SubagentTranscriptMode = "final" | "assistant" | "full";

export interface SubagentTranscript {
  subagentId: string;
  task: string;
  status: string;
  totalMessages: number;
  startIndex: number;
  messages: Message[];
  truncated: boolean;
}

export interface SubagentManager {
  spawn(opts: {
    task: string;
    parentConversationId: string;
    ownerId: string;
    tenantId?: string | null;
    /** Inherit the parent run's telemetry choice — when true, the subagent
     *  run (and its re-runs) emit no telemetry. */
    suppressTelemetry?: boolean;
    /** The id of the `spawn_subagent` tool call that produced this subagent,
     *  so its events can carry `parentToolCallId` and a client can attach
     *  subagent state to the spawning tool's pill. */
    parentToolCallId?: string;
  }): Promise<SubagentSpawnResult>;

  sendMessage(subagentId: string, message: string): Promise<SubagentSpawnResult>;

  stop(subagentId: string): Promise<void>;

  list(parentConversationId: string): Promise<SubagentSummary[]>;

  getTranscript(opts: {
    subagentId: string;
    parentConversationId: string;
    mode: SubagentTranscriptMode;
    sinceIndex?: number;
    maxMessages?: number;
  }): Promise<SubagentTranscript>;
}
