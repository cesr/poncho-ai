---
"@poncho-ai/harness": minor
---

harness: add `systemSkillPaths` for platform-shipped system skills

New optional `HarnessOptions.systemSkillPaths` (absolute directories,
each scanned for `<name>/SKILL.md` at init). System skills are surfaced
in `<available_skills>` like any other skill, with their bodies read
from local disk on activation — letting a platform ship default skills
with the deploy instead of writing them into every tenant's VFS.

Precedence is purely additive: per tenant the skill set resolves as
repo skills > the tenant's own VFS skills > system skills. So a tenant's
`/skills/<same-name>/` overrides a same-named system skill (mirroring
the VFS override behavior platforms already rely on for system jobs),
and the existing repo-vs-VFS precedence is unchanged. Empty by default —
no behavior change for existing consumers.

Also exports `loadSkillMetadataFromDirs(dirs)` (extracted from
`loadSkillMetadata`) for scanning an explicit list of absolute skill
directories.
