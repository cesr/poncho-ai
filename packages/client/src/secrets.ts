import type { ApiSecretEntry } from "@poncho-ai/sdk";
import type { BaseClient } from "./base.js";

export async function listSecrets(
  this: BaseClient,
  tenant?: string,
): Promise<ApiSecretEntry[]> {
  const url = this.buildUrl("/api/secrets", { tenant });
  return this.json<{ secrets: ApiSecretEntry[] }>(url).then((p) => p.secrets);
}

export async function setSecret(
  this: BaseClient,
  name: string,
  value: string,
  tenant?: string,
): Promise<void> {
  const url = this.buildUrl(
    `/api/secrets/${encodeURIComponent(name)}`,
    { tenant },
  );
  await this.json(url, {
    method: "PUT",
    body: JSON.stringify({ value }),
  });
}

export async function deleteSecret(
  this: BaseClient,
  name: string,
  tenant?: string,
): Promise<void> {
  const url = this.buildUrl(
    `/api/secrets/${encodeURIComponent(name)}`,
    { tenant },
  );
  await this.json(url, { method: "DELETE" });
}
