import type { ApiSubagentSummary } from "@poncho-ai/sdk";
import type { BaseClient } from "./base.js";

export async function listSubagents(
  this: BaseClient,
  conversationId: string,
): Promise<ApiSubagentSummary[]> {
  return this.json<{ subagents: ApiSubagentSummary[] }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/subagents`,
  ).then((p) => p.subagents);
}
