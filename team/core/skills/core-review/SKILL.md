---
name: core-review
description: Multi-lens adversarial review for the core dev team, of a plan before code or of the final diff before done. Dispatches one read-only reviewer per lens in parallel, plus the stack reviewers the profile installed, and records every finding with severity and disposition. Use from core-dev at the plan-review and review stages, or when asked to review a diff.
---

# core-review

## Plan mode (before the first edit)

Run these perspectives in parallel as read-only subagents (`core-lens-reviewer` with the lens named, or
`planner` / `architect` where noted), each reading the plan and the live code:

1. Senior engineer of this project: does the plan follow the project rules, conventions, branch and
   deploy policy?
2. Domain specialist for the stack touched (React, server, SEO, LLM, payments).
3. Test engineer: what would make the done claim untrue; which check could pass on an empty world.
4. Architect (`architect` agent): coupling, seams, blast radius, data handling.
5. Operations: deployment order, configuration that arms something not shipped yet, rollback.

Add security for auth, uploads, payments, secrets or user input. Fold findings in; repeat until none is
critical or high.

## Diff mode (before done)

Review the final diff (`git diff <base>...HEAD` plus uncommitted changes). Run in parallel:

- `core-lens-reviewer` four times, one lens each:
  1. **failure-path**: throw midway, run twice, crashed previous run, partial work undone by whom.
  2. **data-scope**: is any write, delete or query wider than the data this code owns.
  3. **contract-coverage**: does a test exercise every new branch, including unhappy ones; would the
     tests fail if the change were reverted.
  4. **config-sequencing**: does a default, env var or flag arm something that does not exist yet;
     ordering against other deploys.
- The profile reviewers that match the diff: `typescript-reviewer` for TS/JS, `react-reviewer` for
  components, `security-reviewer` for security-sensitive code, `silent-failure-hunter` for error
  handling, `pr-test-analyzer` for tests, `seo-specialist` for pages and content.

Every finding needs a file and line; a finding without a location is an opinion. Severity: critical (bug,
security, data loss, broken build or tests), high (logic risk, missing test for a new branch), medium
(convention break, maintainability), low (note).

## Record

For every lens run and every finding:

```bash
node "$CORE/team/tools/team.mjs" review --project . --task <id> --lens <lens> --findings 0
node "$CORE/team/tools/team.mjs" review --project . --task <id> --lens <lens> --severity high --where src/a.ts:42 --disposition fixed --note "<what>"
```

Disposition is `fixed`, `waived` (with the reason in `--note`) or `open`. A critical or high finding left
`open` blocks done. After fixing, rerun `core-verify`: a fix is code that has not been verified yet.

## Rules

- Reviewers are read-only. They report; the main session fixes.
- Do not drop a lens to save time; drop it only when the diff cannot touch it, and record that.
- Never review only the summary of a change; read the full file at the changed lines and its callers.
