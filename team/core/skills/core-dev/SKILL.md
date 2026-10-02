---
name: core-dev
description: Start here for every development task (feature, change, fix, refactor, shipped content, review, deploy): reads the project rules, picks stages, agents and skills, and states what done needs.
---

# core-dev: the router

Project rules win over everything in this skill (see `.claude/rules/core-team.md`). This skill fills the
gaps the project rules leave.

## Step 0: read the project rules (never skipped)

Read `AGENTS.md`, `CLAUDE.md` (if present), every project-written file under `.claude/rules/`, and
`.claude/rules/core-project.md`. Read `.claude/team/project.json` for the gate commands. Note every rule
that applies to this task: a mandatory spec format, a deployment definition of done, a docs language,
a branch policy. Those rules replace the matching stage below, and you say so in the plan.

## Step 1: classify

| Class | When | Stages |
|---|---|---|
| feature | capability does not exist yet | premise, plan, plan review, implement (test first), verify, review, done |
| change | works, but should behave differently | premise, plan, implement (amend tests first), verify, review, done |
| fix | behaviour is wrong | premise (reproduce), failing test, fix, verify, review, done |
| refactor | behaviour stays, structure improves | plan, implement with tests green throughout, verify, review, done |
| content | copy, articles, SEO pages, translations that ship | premise (sources), plan, write, verify (build + SEO checks), review, done |
| investigate | find out, no change yet | premise, evidence, report; no edits |
| review | review a diff or a PR | `core-review` only |
| deploy | release to an environment | the project's deployment rules verbatim, then done |
| hotfix | production is broken now | reproduce, smallest fix, verify, review (may be after release if the project allows), done with cause, scope, rollback |

Size: small (one file, under 50 lines), medium, large (over 400 lines or several subsystems). Large work
is split before it starts.

## Step 2: run the stages

| Stage | Use | Notes |
|---|---|---|
| premise | `core-plan` | confirm the claim against the live code or data today: confirmed, plausible or refuted. Refuted stops the task. |
| plan | `core-plan`, agents `planner`, `architect` | acceptance criteria, files, risks, estimate in minutes |
| plan review | `core-review` (plan mode) | medium and large tasks; before the first edit |
| implement | library `tdd-workflow` and the stack skills in the library | test first where the project has tests |
| build broken | agents `build-error-resolver`, `react-build-resolver` | smallest change that makes the build pass |
| verify | `core-verify`, agent `core-verifier` | the project's own gates, from `project.json` |
| review | `core-review` | four lenses plus the profile reviewers, on the final diff |
| done | `core-done` | the done predicate, then one task record |

The skill library: `.claude/team/library/INDEX.md` lists every vendored ECC skill with its file and when to
use it (testing, React, Vite, accessibility, API design, error handling, security review, SEO, i18n,
articles, LLM cost and evaluation, architecture decisions, adversarial checks). They are not loaded every
session. When the task touches one of those areas, read the matching `SKILL.md` from the library and follow
it. The index also lists coding rules by language (`rules/typescript/*`, `rules/react/*`, `rules/web/*`): read
the ones for the files you are about to change before the first edit of a session. Projects add more through
`extraEcc` in `.claude/team/project.json`.

Security-sensitive code (auth, payments, uploads, user input, secrets): the library's `security-review`
skill and the `security-reviewer` agent are mandatory.

If a skill or agent named anywhere is not installed, it is not part of this project's profile: carry on
without it and say so, never invent its content.

## Step 3: report

The final message states: class, stages run, project rules applied, gates with results and the exact
commands, review findings and how each was handled, what was skipped and why, and the task record id.

## Core CLI

Some stages call the core CLI. Find it once per session:

```bash
CORE="${AGENTIC_TEAM_CORE:-$(node -p "try{require(require('os').homedir()+'/.agentic-team/registry.json').coreRoot}catch(e){''}")}"
test -n "$CORE" && node "$CORE/team/tools/team.mjs" --version
```

If it is not available on this machine, run the gate commands from `project.json` yourself and mark the
gates `self-reported` in the task record. Never fake a receipt.
