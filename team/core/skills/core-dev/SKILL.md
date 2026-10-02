---
name: core-dev
description: Entry point of the core dev team for every development task - feature, change, bug fix, refactor, shipped content, code review, investigation, deployment or hotfix. Classifies the task, reads the project rules first, picks the pipeline stages, the agents and the skills, and states what done requires. Use before planning or editing code in this repository.
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
| plan | `core-plan`, agents `planner`, `architect`, `code-explorer`, `code-architect` | acceptance criteria, files, risks, estimate in minutes |
| plan review | `core-review` (plan mode) | medium and large tasks; before the first edit |
| implement | `ecc-tdd-workflow`, the stack skills below | test first where the project has tests |
| build broken | agents `build-error-resolver`, `react-build-resolver` | smallest change that makes the build pass |
| verify | `core-verify`, agent `core-verifier` | the project's own gates, from `project.json` |
| review | `core-review` | four lenses plus the profile reviewers, on the final diff |
| done | `core-done` | the done predicate, then one task record |

Stack skills, load when the task touches the area (only the installed ones exist):

- API, server routes, errors: `ecc-api-design`, `ecc-error-handling`, `ecc-contract-first`
- React UI: `ecc-react-patterns`, `ecc-frontend-patterns`, `ecc-react-performance`, `ecc-react-testing`
- Build tooling: `ecc-vite-patterns`, `ecc-nextjs-turbopack`
- Accessibility and UX checks: `ecc-accessibility`, `ecc-frontend-a11y`, `ecc-click-path-audit`
- End-to-end: `ecc-e2e-testing`
- Security-sensitive code (auth, payments, uploads, user input, secrets): `ecc-security-review` and agent `security-reviewer`
- SEO, multilingual content: `ecc-seo`, `ecc-i18n-sync`, `ecc-article-writing`, `ecc-brand-voice`, agent `seo-specialist`
- LLM features (chatbots, prompts, evals, cost): `ecc-cost-aware-llm-pipeline`, `ecc-eval-harness`, `ecc-ai-regression-testing`
- Unfamiliar area: `ecc-search-first`, `ecc-codebase-onboarding`, `ecc-iterative-retrieval`
- Hard decision with real trade-offs: `ecc-council`; adversarial check of a finished artefact: `ecc-santa-method`
- Lasting design decision: `ecc-architecture-decision-records`

Projects may install more ECC skills through `extraEcc` in `.claude/team/project.json`; use them where they fit.
If a skill or agent named here is not installed, it is not part of this project's profile: carry on
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
