/**
 * Interactive CLI session using plain readline + stdout.
 *
 * Previous versions used Ink (React-based terminal UI) but Ink's cursor
 * management produced persistent rendering artifacts (ghost lines, duplicated
 * input bars, frozen streaming fragments). Plain readline is simpler and
 * produces reliable output with native scroll and text selection.
 */
import * as readline from "node:readline";
import { resolve } from "node:path";
import { parseAgentFile, type AgentHarness } from "@agentl/harness";
import type { AgentEvent, Message, TokenUsage } from "@agentl/sdk";

// Re-export types that index.ts references
export type ApprovalRequest = {
  tool: string;
  input: Record<string, unknown>;
  approvalId: string;
  resolve: (approved: boolean) => void;
};

export type SessionSnapshot = {
  messages: Message[];
  nextTurn: number;
};

export type UiMetadata = {
  agentName: string;
  model: string;
  provider: string;
  workingDir: string;
  environment: string;
};

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
  magenta: "\x1b[35m",
} as const;

const cyan = (s: string): string => `${C.cyan}${s}${C.reset}`;
const green = (s: string): string => `${C.green}${s}${C.reset}`;
const yellow = (s: string): string => `${C.yellow}${s}${C.reset}`;
const red = (s: string): string => `${C.red}${s}${C.reset}`;
const gray = (s: string): string => `${C.gray}${s}${C.reset}`;
const magenta = (s: string): string => `${C.magenta}${s}${C.reset}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAUX_TOOL_LOG_PATTERN =
  /Tool Used:|Tool Result:|\blist_skills\b|\bcreate_skill\b|\bedit_skill\b/i;

const formatDuration = (ms: number): string =>
  ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;

const stringifyValue = (v: unknown): string => {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};

const truncate = (v: string, max: number): string =>
  v.length <= max ? v : `${v.slice(0, Math.max(0, max - 3))}...`;

const compactPreview = (v: unknown, max = 120): string =>
  truncate(stringifyValue(v).replace(/\s+/g, " "), max);

const loadMetadata = async (workingDir: string): Promise<UiMetadata> => {
  let agentName = "agent";
  let model = "unknown";
  let provider = "unknown";
  try {
    const parsed = await parseAgentFile(workingDir);
    agentName = parsed.frontmatter.name ?? agentName;
    model = parsed.frontmatter.model?.name ?? model;
    provider = parsed.frontmatter.model?.provider ?? provider;
  } catch {
    // resilient defaults
  }
  return {
    agentName,
    model,
    provider,
    workingDir,
    environment: process.env.AGENTL_ENV ?? process.env.NODE_ENV ?? "development",
  };
};

// ---------------------------------------------------------------------------
// Question helper (promise-based readline.question)
// ---------------------------------------------------------------------------

const ask = (
  rl: readline.Interface,
  prompt: string,
): Promise<string> =>
  new Promise((res) => {
    rl.question(prompt, (answer) => res(answer));
  });

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

const handleSlash = (command: string): void => {
  const norm = command.trim().toLowerCase();
  if (norm === "/help") {
    console.log(gray("commands> /help /clear /exit"));
    return;
  }
  if (norm === "/clear") {
    process.stdout.write("\x1b[2J\x1b[H"); // clear screen
    return;
  }
  if (norm === "/exit") {
    // handled in main loop
    return;
  }
  console.log(yellow(`Unknown command: ${command}`));
};

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export const runInteractiveInk = async ({
  harness,
  params,
  workingDir,
  onSetApprovalCallback,
}: {
  harness: AgentHarness;
  params: Record<string, string>;
  workingDir: string;
  onSetApprovalCallback?: (cb: (req: ApprovalRequest) => void) => void;
}): Promise<void> => {
  const metadata = await loadMetadata(workingDir);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  // --- Approval bridge -------------------------------------------------------
  // When the harness needs tool approval, it calls the approval handler in
  // index.ts, which creates a pending promise and fires our callback.
  // We use readline to prompt the user for y/n.
  if (onSetApprovalCallback) {
    onSetApprovalCallback((req: ApprovalRequest) => {
      // Print approval prompt — we're mid-turn so stdout might have partial text
      process.stdout.write("\n");
      const preview = compactPreview(req.input, 100);
      rl.question(
        `${C.yellow}${C.bold}Tool "${req.tool}" requires approval${C.reset}\n` +
          `${C.gray}input: ${preview}${C.reset}\n` +
          `${C.yellow}approve? (y/n): ${C.reset}`,
        (answer) => {
          const approved = answer.trim().toLowerCase() === "y";
          console.log(
            approved
              ? green(`  approved ${req.tool}`)
              : magenta(`  denied ${req.tool}`),
          );
          req.resolve(approved);
        },
      );
    });
  }

  // --- Print header ----------------------------------------------------------

  console.log(
    gray(
      `\n${metadata.agentName} | ${metadata.provider}/${metadata.model} | ${metadata.environment}`,
    ),
  );
  console.log(gray('Type "exit" to quit, "/help" for commands\n'));

  // --- State -----------------------------------------------------------------

  const messages: Message[] = [];
  let turn = 1;
  let showToolPayloads = false;

  // --- Main loop -------------------------------------------------------------

  const prompt = `${C.cyan}you> ${C.reset}`;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let task: string;
    try {
      task = await ask(rl, prompt);
    } catch {
      // readline closed (e.g. Ctrl+D)
      break;
    }

    const trimmed = task.trim();
    if (!trimmed) continue;

    if (trimmed.toLowerCase() === "exit") break;

    if (trimmed.startsWith("/")) {
      if (trimmed.toLowerCase() === "/exit") break;
      if (trimmed.toLowerCase() === "/tools") {
        showToolPayloads = !showToolPayloads;
        console.log(gray(`tool payloads: ${showToolPayloads ? "on" : "off"}`));
        continue;
      }
      handleSlash(trimmed);
      continue;
    }

    // --- Run a turn ----------------------------------------------------------

    console.log(gray(`\n--- turn ${turn} ---`));

    // Show a "thinking" indicator that we'll clear when the first chunk arrives
    process.stdout.write(gray("thinking..."));
    let thinkingCleared = false;
    const clearThinking = (): void => {
      if (thinkingCleared) return;
      thinkingCleared = true;
      // Move to beginning of line and clear it
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
    };

    let responseText = "";
    let streamedText = "";
    let committedText = false;
    let sawChunk = false;
    let toolEvents = 0;
    let runFailed = false;
    let usage: TokenUsage | undefined;
    const startedAt = Date.now();

    try {
      for await (const event of harness.run({
        task: trimmed,
        parameters: params,
        messages,
      })) {
        if (event.type === "model:chunk") {
          sawChunk = true;
          responseText += event.content;
          streamedText += event.content;

          if (!thinkingCleared) {
            clearThinking();
            process.stdout.write(`${C.green}assistant> ${C.reset}`);
          }
          // Stream the text directly to stdout
          process.stdout.write(event.content);
        } else if (
          event.type === "tool:started" ||
          event.type === "tool:completed" ||
          event.type === "tool:error" ||
          event.type === "tool:approval:required" ||
          event.type === "tool:approval:granted" ||
          event.type === "tool:approval:denied"
        ) {
          // Flush any streaming text before tool output
          if (streamedText.length > 0) {
            committedText = true;
            streamedText = "";
            process.stdout.write("\n");
          }
          clearThinking();

          if (event.type === "tool:started") {
            const preview = showToolPayloads
              ? compactPreview(event.input, 400)
              : compactPreview(event.input, 100);
            console.log(yellow(`tools> start ${event.tool} input=${preview}`));
            toolEvents += 1;
          } else if (event.type === "tool:completed") {
            const preview = showToolPayloads
              ? compactPreview(event.output, 400)
              : compactPreview(event.output, 100);
            console.log(
              yellow(
                `tools> done  ${event.tool} in ${formatDuration(event.duration)}`,
              ),
            );
            if (showToolPayloads) {
              console.log(yellow(`tools> output ${preview}`));
            }
          } else if (event.type === "tool:error") {
            console.log(
              red(`tools> error ${event.tool}: ${event.error}`),
            );
          } else if (event.type === "tool:approval:required") {
            console.log(
              magenta(`tools> approval required for ${event.tool}`),
            );
          } else if (event.type === "tool:approval:granted") {
            console.log(
              gray(`tools> approval granted (${event.approvalId})`),
            );
          } else if (event.type === "tool:approval:denied") {
            console.log(
              magenta(`tools> approval denied (${event.approvalId})`),
            );
          }
        } else if (event.type === "run:error") {
          clearThinking();
          runFailed = true;
          console.log(red(`error> ${event.error.message}`));
        } else if (event.type === "model:response") {
          usage = event.usage;
        } else if (event.type === "run:completed" && !sawChunk) {
          clearThinking();
          responseText = event.result.response ?? "";
          if (responseText.length > 0) {
            process.stdout.write(
              `${C.green}assistant> ${C.reset}${responseText}\n`,
            );
          }
        }
      }
    } catch (error) {
      clearThinking();
      runFailed = true;
      console.log(
        red(
          `error> ${error instanceof Error ? error.message : "Unknown error"}`,
        ),
      );
    }

    // End the streaming line if needed
    if (sawChunk && streamedText.length > 0) {
      process.stdout.write("\n");
    } else if (!sawChunk && !runFailed && responseText.length === 0) {
      clearThinking();
      console.log(green("assistant> (no response)"));
    }

    // Fabricated tool-call warning
    const fullResponse = responseText || streamedText;
    if (
      !runFailed &&
      toolEvents === 0 &&
      FAUX_TOOL_LOG_PATTERN.test(fullResponse)
    ) {
      console.log(
        magenta(
          "warning> assistant described tool execution but no real tool events occurred.",
        ),
      );
    }

    const durationMs = Date.now() - startedAt;
    console.log(
      gray(`meta> ${formatDuration(durationMs)} | tools: ${toolEvents}\n`),
    );

    messages.push({ role: "user", content: trimmed });
    messages.push({ role: "assistant", content: responseText });
    turn += 1;
  }

  rl.close();
};
