import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
// eslint-disable-next-line @typescript-eslint/no-require-imports
import { ScrollView as RawScrollView, type ScrollViewRef } from "ink-scroll-view";

// Work around React types version mismatch between ink-scroll-view and @types/react@19
const ScrollView = RawScrollView as any;
import type { AgentEvent, Message, TokenUsage } from "@agentl/sdk";
import type { AgentHarness } from "@agentl/harness";

type UiLine = {
  id: string;
  kind: "meta" | "user" | "assistant" | "tool" | "warning" | "error";
  text: string;
  turn: number;
  timestamp: number;
};
type Notice = { kind: UiLine["kind"]; text: string };

const FAUX_TOOL_LOG_PATTERN =
  /Tool Used:|Tool Result:|\blist_skills\b|\bcreate_skill\b|\bedit_skill\b/i;

const MAX_PERSISTED_LINES = 500;
const MAX_PERSISTED_TIMELINE = 200;
const STREAM_FLUSH_MS = 33;
const INPUT_FLUSH_MS = 33;
const CONTROL_SEQUENCE_PATTERN = /[\u0000-\u001f\u007f\u001b]/;
const MOUSE_SEQUENCE_FRAGMENT_PATTERN = /^\[?<\d+(;\d+){0,2}[mM]?$/;

const formatDuration = (ms: number): string => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

const randomId = (): string => `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

const colorForKind = (kind: UiLine["kind"]): string => {
  if (kind === "user") return "cyan";
  if (kind === "assistant") return "green";
  if (kind === "tool") return "yellow";
  if (kind === "warning") return "magenta";
  if (kind === "error") return "red";
  return "gray";
};

type TurnSummary = {
  turn: number;
  durationMs: number;
  toolEvents: number;
  status: "ok" | "error";
  usage?: TokenUsage;
};

export type SessionSnapshot = {
  messages: Message[];
  lines: UiLine[];
  timeline: TurnSummary[];
  nextTurn: number;
  lastPrompt?: string;
};

export type UiMetadata = {
  agentName: string;
  model: string;
  provider: string;
  workingDir: string;
  environment: string;
};

const stringifyValue = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const truncate = (value: string, maxLength: number): string =>
  value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 3))}...`;

const compactPreview = (value: unknown, maxLength = 120): string =>
  truncate(stringifyValue(value).replace(/\s+/g, " "), maxLength);

const withLimit = <T,>(items: T[], max: number): T[] => (items.length <= max ? items : items.slice(items.length - max));

const toUiLineEntries = (kind: UiLine["kind"], text: string, turn: number): UiLine[] =>
  text.split(/\r?\n/).map((lineText) => ({
    id: randomId(),
    kind,
    text: lineText,
    turn,
    timestamp: Date.now(),
  }));

const createInitialLines = (): UiLine[] => [
  {
    id: randomId(),
    kind: "meta",
    text: "AgentL Interactive (Ink) - full screen mode",
    turn: 0,
    timestamp: Date.now(),
  },
  {
    id: randomId(),
    kind: "meta",
    text: "Enter to send | Shift+Enter newline | /help for commands",
    turn: 0,
    timestamp: Date.now(),
  },
];

const HeaderBar = memo(function HeaderBar({ text }: { text: string }): JSX.Element {
  return (
    <Box>
      <Text color="cyan">{text}</Text>
    </Box>
  );
});

/* TranscriptPane is no longer a separate component — ScrollView is used directly in the main render. */

const InputBar = memo(function InputBar({
  inputHeight,
  inputPreview,
  cursorVisible,
}: {
  inputHeight: number;
  inputPreview: string;
  cursorVisible: boolean;
}): JSX.Element {
  const cursor = cursorVisible ? "█" : " ";
  return (
    <Box height={inputHeight} paddingLeft={1}>
      <Text color="cyan">
        you&gt; {inputPreview}
        {cursor}
      </Text>
    </Box>
  );
});

const StatusBar = memo(function StatusBar({
  notice,
  runStateText,
  scrollOffset,
}: {
  notice?: Notice;
  runStateText: string;
  scrollOffset: number;
}): JSX.Element {
  const scrollHint = scrollOffset > 0 ? ` | ↑ scrolled ${scrollOffset}` : "";
  return (
    <Box flexDirection="column">
      <Text color={notice ? colorForKind(notice.kind) : "gray"}>
        {notice ? notice.text : runStateText}{scrollHint}
      </Text>
      <Text color="gray">
        Ctrl+L clear | Ctrl+R resend | Ctrl+S toggle mouse/select | Ctrl+U/D scroll | Ctrl+O tools
      </Text>
    </Box>
  );
});

export const InteractiveInkApp = ({
  harness,
  params,
  metadata,
  initialSnapshot,
  persistenceEnabled,
  onPersist,
}: {
  harness: AgentHarness;
  params: Record<string, string>;
  metadata: UiMetadata;
  initialSnapshot?: SessionSnapshot;
  persistenceEnabled: boolean;
  onPersist?: (snapshot: SessionSnapshot) => Promise<void>;
}): JSX.Element => {
  const { exit } = useApp();
  const [dimensions, setDimensions] = useState({
    columns: process.stdout.columns ?? 120,
    rows: process.stdout.rows ?? 40,
  });
  const [input, setInput] = useState("");
  const [lines, setLines] = useState<UiLine[]>(
    initialSnapshot?.lines?.length ? initialSnapshot.lines : createInitialLines(),
  );
  const [timeline, setTimeline] = useState<TurnSummary[]>(initialSnapshot?.timeline ?? []);
  const [isRunning, setIsRunning] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [showToolPayloads, setShowToolPayloads] = useState(false);
  const [notice, setNotice] = useState<Notice | undefined>();
  const [scrollInfo, setScrollInfo] = useState(0); // just for status bar display
  const scrollRef = useRef<ScrollViewRef>(null);
  const autoScrollRef = useRef(true); // auto-scroll to bottom on new content
  const [toolState, setToolState] = useState<{
    tool?: string;
    state: "idle" | "started" | "completed" | "error";
    startedAt?: number;
    durationMs?: number;
    input?: string;
    output?: string;
    error?: string;
  }>({ state: "idle" });
  const messagesRef = useRef<Message[]>(initialSnapshot?.messages ?? []);
  const turnRef = useRef(initialSnapshot?.nextTurn ?? 1);
  const lastPromptRef = useRef(initialSnapshot?.lastPrompt ?? "");
  const persistTimer = useRef<NodeJS.Timeout | undefined>();
  const streamBufferRef = useRef("");
  const streamFlushRef = useRef<NodeJS.Timeout | undefined>();
  const inputBufferRef = useRef(initialSnapshot?.lastPrompt ?? "");
  const inputFlushRef = useRef<NodeJS.Timeout | undefined>();
  const [cursorVisible, setCursorVisible] = useState(true);

  useEffect(() => {
    const onResize = (): void => {
      setDimensions({
        columns: process.stdout.columns ?? 120,
        rows: process.stdout.rows ?? 40,
      });
      scrollRef.current?.remeasure();
    };
    process.stdout.on("resize", onResize);
    return () => {
      process.stdout.off("resize", onResize);
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      setCursorVisible((current) => !current);
    }, 500);
    return () => clearInterval(timer);
  }, []);

  const [mouseEnabled, setMouseEnabled] = useState(true);
  const mouseEnabledRef = useRef(true);

  useEffect(() => {
    const stdout = process.stdout;
    const stdin = process.stdin;
    const enableMouse = (): void => {
      stdout.write("\u001B[?1000h\u001B[?1006h");
    };
    const disableMouse = (): void => {
      stdout.write("\u001B[?1000l\u001B[?1006l");
    };
    const onData = (chunk: Buffer): void => {
      if (!mouseEnabledRef.current) {
        return;
      }
      const value = chunk.toString("utf8");
      const matches = [...value.matchAll(/\u001B\[<(\d+);(\d+);(\d+)([mM])/g)];
      if (matches.length === 0) {
        return;
      }
      for (const match of matches) {
        const button = Number(match[1] ?? -1);
        if (button === 64) {
          // scroll up
          scrollRef.current?.scrollBy(-1);
          autoScrollRef.current = false;
        } else if (button === 65) {
          // scroll down
          scrollRef.current?.scrollBy(1);
          // If at bottom, re-enable auto-scroll
          const sv = scrollRef.current;
          if (sv && sv.getScrollOffset() >= sv.getBottomOffset()) {
            autoScrollRef.current = true;
          }
        }
      }
    };
    enableMouse();
    stdin.on("data", onData);
    return () => {
      stdin.off("data", onData);
      disableMouse();
    };
  }, []);

  // Sync mouse tracking with toggle state
  useEffect(() => {
    mouseEnabledRef.current = mouseEnabled;
    if (mouseEnabled) {
      process.stdout.write("\u001B[?1000h\u001B[?1006h");
    } else {
      process.stdout.write("\u001B[?1000l\u001B[?1006l");
    }
  }, [mouseEnabled]);

  const persistSnapshot = useCallback(() => {
    if (!persistenceEnabled || !onPersist) {
      return;
    }
    if (persistTimer.current) {
      clearTimeout(persistTimer.current);
    }
    persistTimer.current = setTimeout(() => {
      void onPersist({
        messages: messagesRef.current,
        lines: withLimit(lines, MAX_PERSISTED_LINES),
        timeline: withLimit(timeline, MAX_PERSISTED_TIMELINE),
        nextTurn: turnRef.current,
        lastPrompt: lastPromptRef.current,
      }).catch(() => {
        // Keep the UI responsive even if session persistence fails.
      });
    }, 60);
  }, [lines, onPersist, persistenceEnabled, timeline]);

  const appendLine = useCallback((kind: UiLine["kind"], text: string, turn: number) => {
    const entries = toUiLineEntries(kind, text, turn);
    setLines((previous) =>
      withLimit(
        [
          ...previous,
          ...entries,
        ],
        MAX_PERSISTED_LINES,
      ),
    );
  }, []);

  const flushInputBuffer = useCallback(() => {
    setInput(inputBufferRef.current);
  }, []);

  const queueInputFlush = useCallback(() => {
    if (inputFlushRef.current) {
      return;
    }
    inputFlushRef.current = setTimeout(() => {
      inputFlushRef.current = undefined;
      flushInputBuffer();
    }, INPUT_FLUSH_MS);
  }, [flushInputBuffer]);

  const runSlashCommand = useCallback(
    (command: string) => {
      const normalized = command.trim().toLowerCase();
      if (normalized === "/help") {
        appendLine(
          "meta",
          "commands> /help /clear /sidebar /tools /export /exit",
          Math.max(1, turnRef.current - 1),
        );
        return;
      }
      if (normalized === "/clear") {
        setLines(createInitialLines());
        setNotice({ kind: "meta", text: "Cleared scrollback." });
        scrollRef.current?.scrollToTop();
        autoScrollRef.current = true;
        return;
      }
      if (normalized === "/sidebar") {
        appendLine("meta", "sidebar> removed for now", Math.max(1, turnRef.current - 1));
        return;
      }
      if (normalized === "/tools") {
        setShowToolPayloads((value) => !value);
        return;
      }
      if (normalized === "/export") {
        appendLine(
          "meta",
          persistenceEnabled
            ? "export> session is saved to .agentl/interactive-session.json"
            : "export> session persistence is disabled (set AGENTL_INTERACTIVE_PERSIST=true)",
          0,
        );
        return;
      }
      if (normalized === "/exit") {
        exit();
        return;
      }
      setNotice({ kind: "warning", text: `Unknown command: ${command}` });
    },
    [appendLine, exit, persistenceEnabled],
  );

  const handleToolEvent = useCallback(
    (event: AgentEvent, turn: number) => {
      if (event.type === "tool:started") {
        const inputPreview = showToolPayloads
          ? compactPreview(event.input, 400)
          : compactPreview(event.input, 100);
        setToolState({
          tool: event.tool,
          state: "started",
          startedAt: Date.now(),
          input: inputPreview,
        });
        appendLine("tool", `tools> start ${event.tool} input=${inputPreview}`, turn);
        return 1;
      }
      if (event.type === "tool:completed") {
        const outputPreview = showToolPayloads
          ? compactPreview(event.output, 400)
          : compactPreview(event.output, 100);
        setToolState((current) => ({
          ...current,
          tool: event.tool,
          state: "completed",
          durationMs: event.duration,
          output: outputPreview,
        }));
        appendLine("tool", `tools> done  ${event.tool} in ${formatDuration(event.duration)}`, turn);
        if (showToolPayloads) {
          appendLine("tool", `tools> output ${outputPreview}`, turn);
        }
        return 0;
      }
      if (event.type === "tool:error") {
        setToolState((current) => ({
          ...current,
          tool: event.tool,
          state: "error",
          error: event.error,
        }));
        appendLine("error", `tools> error ${event.tool}: ${event.error}`, turn);
        setNotice({ kind: "error", text: `Tool error on ${event.tool}` });
      }
      if (event.type === "tool:approval:required") {
        appendLine("warning", `tools> approval required for ${event.tool}`, turn);
      }
      if (event.type === "tool:approval:granted") {
        appendLine("meta", `tools> approval granted (${event.approvalId})`, turn);
      }
      if (event.type === "tool:approval:denied") {
        appendLine("warning", `tools> approval denied (${event.approvalId})`, turn);
      }
      return 0;
    },
    [appendLine, showToolPayloads],
  );

  const runTurn = useCallback(
    async (task: string) => {
      if (isRunning) {
        return;
      }
      setIsRunning(true);
      setStreamingText("");
      streamBufferRef.current = "";
      const turn = turnRef.current;
      turnRef.current = turn + 1;
      const startedAt = Date.now();
      setToolState({ state: "idle" });
      setNotice(undefined);
      lastPromptRef.current = task;

      appendLine("meta", "", turn);
      appendLine("meta", `--- turn ${turn} ---`, turn);
      appendLine("meta", "", turn);
      appendLine("user", `you> ${task}`, turn);
      appendLine("meta", "", turn);

      let responseText = "";
      let streamedText = "";
      let sawChunk = false;
      let toolEvents = 0;
      let runFailed = false;
      let usage: TokenUsage | undefined;

      try {
        const flushStreamBuffer = (): void => {
          if (streamBufferRef.current.length === 0) {
            return;
          }
          setStreamingText(streamBufferRef.current);
        };
        const queueStreamFlush = (): void => {
          if (streamFlushRef.current) {
            return;
          }
          streamFlushRef.current = setTimeout(() => {
            streamFlushRef.current = undefined;
            flushStreamBuffer();
          }, STREAM_FLUSH_MS);
        };
        for await (const event of harness.run({
          task,
          parameters: params,
          messages: messagesRef.current,
        })) {
          if (event.type === "model:chunk") {
            sawChunk = true;
            responseText += event.content;
            streamedText += event.content;
            streamBufferRef.current = streamedText;
            queueStreamFlush();
          } else if (
            event.type === "tool:started" ||
            event.type === "tool:completed" ||
            event.type === "tool:error" ||
            event.type === "tool:approval:required" ||
            event.type === "tool:approval:granted" ||
            event.type === "tool:approval:denied"
          ) {
            toolEvents += handleToolEvent(event, turn);
          } else if (event.type === "run:error") {
            runFailed = true;
            appendLine("error", `error> ${event.error.message}`, turn);
            setNotice({ kind: "error", text: event.error.message });
          } else if (event.type === "model:response") {
            usage = event.usage;
          } else if (event.type === "run:completed" && !sawChunk) {
            responseText = event.result.response ?? "";
            streamBufferRef.current = responseText;
            setStreamingText(responseText);
          }
        }
        if (streamFlushRef.current) {
          clearTimeout(streamFlushRef.current);
          streamFlushRef.current = undefined;
        }
        flushStreamBuffer();
      } catch (error) {
        runFailed = true;
        appendLine(
          "error",
          `error> ${error instanceof Error ? error.message : "Unknown error"}`,
          turn,
        );
        setNotice({
          kind: "error",
          text: error instanceof Error ? error.message : "Unknown error",
        });
      } finally {
        if (streamFlushRef.current) {
          clearTimeout(streamFlushRef.current);
          streamFlushRef.current = undefined;
        }
        appendLine("meta", "", turn);
        if (streamedText.length > 0 || responseText.length > 0) {
          appendLine("assistant", `assistant> ${streamedText || responseText}`, turn);
        } else {
          appendLine("assistant", "assistant> (no response)", turn);
        }
        appendLine("meta", "", turn);

        if (!runFailed && toolEvents === 0 && FAUX_TOOL_LOG_PATTERN.test(streamedText || responseText)) {
          appendLine(
            "warning",
            "warning> assistant described tool execution but no real tool events occurred.",
            turn,
          );
          setNotice({
            kind: "warning",
            text: "Assistant described tool calls, but no real tool events occurred.",
          });
        }

        const durationMs = Date.now() - startedAt;
        appendLine("meta", `meta> ${formatDuration(durationMs)} | tools: ${toolEvents}`, turn);
        setTimeline((previous) =>
          withLimit(
            [
              ...previous,
              {
                turn,
                durationMs,
                toolEvents,
                status: runFailed ? "error" : "ok",
                usage,
              },
            ],
            MAX_PERSISTED_TIMELINE,
          ),
        );
        messagesRef.current = [
          ...messagesRef.current,
          { role: "user", content: task },
          { role: "assistant", content: streamedText || responseText },
        ];
        setStreamingText("");
        streamBufferRef.current = "";
        setIsRunning(false);
        persistSnapshot();
      }
    },
    [appendLine, handleToolEvent, harness, isRunning, params, persistSnapshot],
  );

  useEffect(
    () => () => {
      if (persistTimer.current) {
        clearTimeout(persistTimer.current);
      }
      if (streamFlushRef.current) {
        clearTimeout(streamFlushRef.current);
      }
      if (inputFlushRef.current) {
        clearTimeout(inputFlushRef.current);
      }
    },
    [],
  );

  useInput((value, key) => {
    if (MOUSE_SEQUENCE_FRAGMENT_PATTERN.test(value)) {
      return;
    }
    if ((key.ctrl && value.toLowerCase() === "c") || value === "\u0003") {
      exit();
      return;
    }
    if (key.ctrl && value.toLowerCase() === "l") {
      setLines(createInitialLines());
      setNotice({ kind: "meta", text: "Cleared scrollback." });
      persistSnapshot();
      return;
    }
    if (key.ctrl && value.toLowerCase() === "r") {
      if (lastPromptRef.current.trim().length > 0 && !isRunning) {
        void runTurn(lastPromptRef.current);
      }
      return;
    }
    if (key.ctrl && value.toLowerCase() === "o") {
      setShowToolPayloads((current) => !current);
      return;
    }
    if (key.ctrl && value.toLowerCase() === "s") {
      setMouseEnabled((current) => {
        const next = !current;
        setNotice({
          kind: "meta",
          text: next
            ? "Mouse scroll enabled (text selection disabled)"
            : "Mouse scroll disabled (text selection enabled)",
        });
        return next;
      });
      return;
    }
    if (key.ctrl && value.toLowerCase() === "u") {
      scrollRef.current?.scrollBy(-3);
      autoScrollRef.current = false;
      return;
    }
    if (key.ctrl && value.toLowerCase() === "d") {
      scrollRef.current?.scrollBy(3);
      const sv = scrollRef.current;
      if (sv && sv.getScrollOffset() >= sv.getBottomOffset()) {
        autoScrollRef.current = true;
      }
      return;
    }
    if (key.pageUp) {
      const height = scrollRef.current?.getViewportHeight() ?? 12;
      scrollRef.current?.scrollBy(-height);
      autoScrollRef.current = false;
      return;
    }
    if (key.pageDown) {
      const height = scrollRef.current?.getViewportHeight() ?? 12;
      scrollRef.current?.scrollBy(height);
      const sv = scrollRef.current;
      if (sv && sv.getScrollOffset() >= sv.getBottomOffset()) {
        autoScrollRef.current = true;
      }
      return;
    }
    if (key.return) {
      if (key.shift) {
        inputBufferRef.current = `${inputBufferRef.current}\n`;
        queueInputFlush();
        return;
      }
      const task = inputBufferRef.current.trimEnd();
      if (task.length === 0 || isRunning) {
        return;
      }
      if (task.toLowerCase() === "exit") {
        exit();
        return;
      }
      if (task.startsWith("/")) {
        inputBufferRef.current = "";
        flushInputBuffer();
        runSlashCommand(task);
        persistSnapshot();
        return;
      }
      inputBufferRef.current = "";
      flushInputBuffer();
      scrollRef.current?.scrollToBottom();
      autoScrollRef.current = true;
      void runTurn(task);
      return;
    }

    if (key.backspace || key.delete) {
      inputBufferRef.current = inputBufferRef.current.slice(0, -1);
      queueInputFlush();
      return;
    }

    if (!key.ctrl && !key.meta && value.length > 0) {
      if (CONTROL_SEQUENCE_PATTERN.test(value) || MOUSE_SEQUENCE_FRAGMENT_PATTERN.test(value)) {
        return;
      }
      inputBufferRef.current += value;
      queueInputFlush();
    }
  });

  const { columns, rows } = dimensions;
  const headerText = `agent: ${metadata.agentName} | provider: ${metadata.provider} | model: ${metadata.model} | env: ${metadata.environment}`;
  const inputLines = input.split("\n");
  const inputHeight = Math.max(3, Math.min(6, inputLines.length + 1));
  const contentLines = useMemo(() => {
    if (streamingText.length === 0) {
      return lines;
    }
    const streamSegments = streamingText.split(/\r?\n/);
    return [
      ...lines,
      ...streamSegments.map((segment, index) => ({
        id: `streaming-live-${index}`,
        kind: "assistant" as const,
        text: index === 0 ? `assistant> ${segment}` : segment,
        turn: turnRef.current,
        timestamp: Date.now(),
      })),
    ];
  }, [lines, streamingText]);

  // Auto-scroll to bottom when new content arrives.
  // Use a small delay so ScrollView has time to re-measure new children first.
  useEffect(() => {
    if (!autoScrollRef.current) return;
    const timer = setTimeout(() => {
      scrollRef.current?.scrollToBottom();
    }, 16);
    return () => clearTimeout(timer);
  }, [contentLines]);

  const handleScroll = useCallback((offset: number) => {
    setScrollInfo(offset);
    // Detect if user is at (or very near) the bottom to toggle auto-scroll
    const sv = scrollRef.current;
    if (sv) {
      const atBottom = offset >= sv.getBottomOffset() - 1;
      autoScrollRef.current = atBottom;
    }
  }, []);

  const runStateText = useMemo(() => {
    if (isRunning && streamingText.length === 0 && toolState.state !== "started") {
      return "assistant thinking...";
    }
    if (isRunning && streamingText.length > 0) {
      return "assistant streaming...";
    }
    if (isRunning && toolState.state === "started") {
      return `running tool: ${toolState.tool ?? "unknown"}`;
    }
    return "ready";
  }, [isRunning, streamingText, toolState.state, toolState.tool]);
  const inputPreview = inputLines.slice(-inputHeight).join("\n");

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <HeaderBar text={truncate(headerText, Math.max(30, columns - 4))} />
      <Box flexGrow={1} flexShrink={1} flexDirection="column" paddingLeft={1} paddingRight={1}>
        <ScrollView
          ref={scrollRef}
          onScroll={handleScroll}
          onContentHeightChange={() => {
            if (autoScrollRef.current) {
              scrollRef.current?.scrollToBottom();
            }
          }}
          flexGrow={1}
          flexShrink={1}
        >
          {contentLines.map((line) => (
            <Text key={line.id} color={colorForKind(line.kind)}>
              {line.text}
            </Text>
          ))}
        </ScrollView>
      </Box>
      <Box height={1} />
      <InputBar inputHeight={inputHeight} inputPreview={inputPreview} cursorVisible={cursorVisible} />
      <StatusBar notice={notice} runStateText={runStateText} scrollOffset={scrollInfo} />
    </Box>
  );
};
