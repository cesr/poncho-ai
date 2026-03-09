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

export interface SubagentManager {
  spawn(opts: {
    task: string;
    parentConversationId: string;
    ownerId: string;
  }): Promise<SubagentResult>;

  sendMessage(subagentId: string, message: string): Promise<SubagentResult>;

  stop(subagentId: string): Promise<void>;

  list(parentConversationId: string): Promise<SubagentSummary[]>;
}
