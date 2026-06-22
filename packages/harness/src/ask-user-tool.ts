import { defineTool, type ToolDefinition } from "@poncho-ai/sdk";

// ---------------------------------------------------------------------------
// ask_user — pause the run to ask the user a structured, multiple-choice
// question with pre-made options (the in-app analog of Claude Code's
// AskUserQuestion). The client renders tappable option chips so the user
// answers with a tap instead of typing prose.
//
// This tool is dispatched to the client ("device" dispatch, forced in
// AgentHarness.resolveToolMode): the harness pauses the run, emits a
// checkpoint carrying the questions payload, and the consumer (PonchOS)
// resumes the run by POSTing the user's selections back as this tool's
// result. The handler below is a defensive stub — device dispatch
// intercepts the call before any server-side execution, so it must never
// actually run.
// ---------------------------------------------------------------------------

export const createAskUserTool = (): ToolDefinition =>
  defineTool({
    name: "ask_user",
    description:
      "Ask the user one or more structured multiple-choice questions and wait for their answer. " +
      "Use this INSTEAD of writing a question as plain text whenever you would otherwise pause to " +
      "let the user choose between options — clarifying ambiguous requirements, picking an approach, " +
      "confirming a direction. The user sees tappable option chips and answers with a tap. " +
      "Prefer this over a prose question: it is faster for the user and gives you a clean answer. " +
      "Guidelines: ask 1–4 questions at once, each with 2–4 concrete options; keep `header` very short " +
      "(a few words); write each option `label` short and its `description` to one line. The user can " +
      "always type a custom 'Other' answer, so you do not need to add one. Do NOT call any other tool " +
      "in the same turn as ask_user, and call it at most once per turn. After the user answers you will " +
      "receive their selections and may continue.",
    inputSchema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          description: "1–4 questions to ask the user at once.",
          items: {
            type: "object",
            properties: {
              question: {
                type: "string",
                description: "The full question text shown to the user.",
              },
              header: {
                type: "string",
                description:
                  "A very short label for this question (a few words, ~12 chars), shown as a chip.",
              },
              multiSelect: {
                type: "boolean",
                description:
                  "If true, the user may select multiple options. Defaults to false (single choice).",
              },
              options: {
                type: "array",
                description:
                  "The pre-made options. A free-text 'Other' option is added automatically by the client.",
                items: {
                  type: "object",
                  properties: {
                    label: {
                      type: "string",
                      description: "Short, selectable label for this option.",
                    },
                    description: {
                      type: "string",
                      description: "A one-line explanation of what this option means.",
                    },
                  },
                  required: ["label"],
                  additionalProperties: false,
                },
              },
            },
            required: ["question", "header", "options"],
            additionalProperties: false,
          },
        },
      },
      required: ["questions"],
      additionalProperties: false,
    },
    handler: async () => {
      // Unreachable in normal operation: ask_user is forced to client/device
      // dispatch, so the harness checkpoints before this handler is invoked.
      // If it ever runs, the tool was misconfigured (dispatch not forced) —
      // surface an error rather than silently resolving with no user input.
      return {
        error:
          "ask_user must be answered by the user on the client; it cannot run server-side. " +
          "This indicates a dispatch misconfiguration.",
      };
    },
  });
