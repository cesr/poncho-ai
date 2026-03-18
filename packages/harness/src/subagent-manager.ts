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

export interface SubagentManager {
  spawn(opts: {
    task: string;
    parentConversationId: string;
    ownerId: string;
  }): Promise<SubagentSpawnResult>;

  sendMessage(subagentId: string, message: string): Promise<SubagentSpawnResult>;

  stop(subagentId: string): Promise<void>;

  list(parentConversationId: string): Promise<SubagentSummary[]>;
}
