---
"@poncho-ai/harness": patch
---

Add the `ask_user` built-in tool: the agent can pause the run to ask the
user a structured, multiple-choice question (the in-app analog of Claude
Code's AskUserQuestion) instead of asking in plain prose. Each call
carries 1–4 questions, each with a short header, a `multiSelect` flag,
and pre-made options; a free-text "Other" escape is rendered by the
client.

The tool is forced to client (`device`) dispatch, so the harness pauses
the run on a checkpoint carrying the questions and the consumer resumes
by injecting the user's selections as the tool result — no server-side
execution (the handler is a defensive stub). The default agent prompt
now steers the model to reach for `ask_user` whenever it would otherwise
stop to ask the user to choose between options.
