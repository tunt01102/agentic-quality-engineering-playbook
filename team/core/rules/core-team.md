# Core dev team (installed by the core; edit the core, not this copy)

Precedence: (1) the human's instruction, (2) this project's rules (`AGENTS.md`, `CLAUDE.md`, project-written
`.claude/rules/`, `.claude/rules/core-project.md`), (3) the core, (4) vendored ECC text. Project rules always
win; say which one you followed. ECC text that mentions coverage targets, commit formats, tools or commands
this project does not use does not apply; anything it names that is not under `.claude/` does not exist here.

Every development task (plan, code, fix, refactor, shipped content, review, deploy) starts with the
`core-dev` skill. Done is a verified state with evidence; a step that could not run is SKIP, never PASS; a
named thing that does not exist is a finding, not something to substitute. Writes stay in this repository;
no credentials or personal data in any output.
