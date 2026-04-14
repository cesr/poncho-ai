import type { ApiApprovalResponse } from "@poncho-ai/sdk";
import type { BaseClient } from "./base.js";

export async function submitApproval(
  this: BaseClient,
  approvalId: string,
  approved: boolean,
  conversationId?: string,
): Promise<ApiApprovalResponse> {
  return this.json<ApiApprovalResponse>(
    `/api/approvals/${encodeURIComponent(approvalId)}`,
    {
      method: "POST",
      body: JSON.stringify({ approved, conversationId }),
    },
  );
}
