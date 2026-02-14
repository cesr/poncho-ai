import { describe, expect, it } from "vitest";
import type { PonchoConfig } from "@poncho-ai/harness";
import { resolveMemoryConfig, resolveStateConfig } from "@poncho-ai/harness";
import { ONBOARDING_FIELDS } from "@poncho-ai/sdk";
import { buildConfigFromOnboardingAnswers } from "../src/init-onboarding.js";

type Primitive = string | number | boolean | bigint | symbol | null | undefined;
type Join<K extends string, P extends string> = `${K}.${P}`;
type DotPath<T> = T extends Primitive
  ? never
  : {
      [K in keyof T & string]: NonNullable<T[K]> extends Primitive
        ? K
        : K | Join<K, DotPath<NonNullable<T[K]>>>;
    }[keyof T & string];

type PonchoConfigPath = DotPath<PonchoConfig>;
type RegistryConfigPath = Extract<
  (typeof ONBOARDING_FIELDS)[number],
  { target: "config" }
>["path"];
type RegistryPathContract = RegistryConfigPath extends PonchoConfigPath ? true : never;
const REGISTRY_PATH_CONTRACT: RegistryPathContract = true;
void REGISTRY_PATH_CONTRACT;

describe("init onboarding registry contract", () => {
  it("maps generated config into harness state and memory resolvers", () => {
    const config = buildConfigFromOnboardingAnswers({
      "model.provider": "openai",
      "storage.provider": "upstash",
      "storage.url": "https://example.upstash.io",
      "storage.token": "token",
      "storage.memory.enabled": true,
      "storage.memory.maxRecallConversations": 10,
      "auth.required": true,
      "auth.type": "bearer",
      "telemetry.enabled": true,
      "telemetry.otlp": "http://localhost:4318",
    });
    const state = resolveStateConfig(config);
    const memory = resolveMemoryConfig(config);

    expect(state?.provider).toBe("upstash");
    expect(state?.url).toBe("https://example.upstash.io");
    expect(memory?.enabled).toBe(true);
    expect(memory?.maxRecallConversations).toBe(10);
  });
});
