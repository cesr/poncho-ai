---
"@poncho-ai/harness": patch
---

Fix conversations.rename on Postgres: the JSONB `data` column usually
holds a JSON-encoded string scalar (update() binds JSON.stringify output),
so the 0.59.3 in-blob title update threw `cannot set path in scalar` and
every rename 500'd. The UPDATE now branches on jsonb_typeof(data) and
preserves each row's encoding (objects via jsonb_set; string scalars
unwrapped, set, and re-serialized).
