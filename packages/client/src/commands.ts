import type { ApiSlashCommand } from "@poncho-ai/sdk";
import type { BaseClient } from "./base.js";

export async function listSlashCommands(
  this: BaseClient,
): Promise<ApiSlashCommand[]> {
  return this.json<{ commands: ApiSlashCommand[] }>(
    "/api/slash-commands",
  ).then((p) => p.commands);
}
