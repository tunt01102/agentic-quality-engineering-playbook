# Core dev team (installed by the core, do not edit here; edit the core and reinstall)

## Precedence, highest first

1. The human's explicit instruction in this session.
2. This project's own rules: `AGENTS.md`, `CLAUDE.md`, rules the project wrote under `.claude/rules/`,
   and `.claude/rules/core-project.md`. **Project rules always win over the core.** When one overrides a
   core default, follow the project rule and say which rule you followed.
3. The core: this file, the `core-*` skills and agents.
4. Vendored ECC text (`ecc-*` skills, ECC agents, `.claude/rules/ecc/`). Where it says 80% coverage,
   conventional commits, a package manager, a formatter or a command this project does not use, the
   project and the core win. Anything ECC mentions that is not under `.claude/` does not exist here.

## Every development task goes through `core-dev`

Before planning, editing code, fixing a bug, refactoring, writing content that ships, reviewing or
deploying, load the `core-dev` skill and follow its pipeline. It picks the stages, the agents and the
skills for the task class and states what "done" requires. Questions that change nothing (explain, look
up) do not need it.

## Hard rules

- "Done" is a verified state: acceptance criteria met, the project's gates run, evidence quoted. A step
  that could not run is SKIP, never PASS.
- A named thing that does not exist is a finding. Report it; never substitute the nearest lookalike.
- Writes stay inside this repository. Global settings, other repositories, credentials, scheduled jobs
  and outward posting are the human's to approve.
- Never store or repeat credentials or personal data; placeholders only.
- Record every finished task with `core-done`. Record facts, never a self-assigned score.
