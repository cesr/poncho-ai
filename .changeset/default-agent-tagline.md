---
"@poncho-ai/harness": patch
---

`defaultAgentDefinition()` accepts an optional `tagline` to override the
opening line's descriptor ("You are **{name}**, {tagline}."). Default is
unchanged ("a helpful assistant built with Poncho"). Lets SDK consumers
shipping a differently-branded product keep the framework name out of the
agent's system prompt.
