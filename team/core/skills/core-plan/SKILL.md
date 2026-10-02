---
name: core-plan
description: Premise check against live code and the task plan with acceptance criteria and an estimate recorded before the first edit. Use from core-dev.
---

# core-plan

Project rules win (for example a mandatory spec folder or template). If the project prescribes its own
plan format, write that format and use this skill only for what it leaves out.

## 1. Premise, checked today

- Read the actual source the task rests on: the code on the current branch after `git fetch`, the data,
  the page, the log. Never the ticket text alone, never memory from an earlier session.
- If local `main` is behind `origin/main`, compare against `origin/main`.
- Verdict: `confirmed` (seen), `plausible` (consistent, not yet seen), `refuted` (the claim is false or
  already done). A refuted premise ends the task: report what you read and stop.
- A named thing that does not exist is a finding. Report it; never pick the nearest lookalike.

## 2. Open the task record before the first edit

```bash
node "$CORE/team/tools/team.mjs" task start --project . --class <class> --title "<one line>" --estimate <minutes> --premise <verdict>
```

It prints the task id and stores the estimate with a timestamp, so the estimate cannot be written after
the fact. Keep the id for `core-verify` and `core-done`. Without the CLI, write the same facts in the plan.

## 3. The plan

- Acceptance criteria: each one observable, each with the check that proves it.
- Files to touch, and their callers (blast radius). Report a high blast radius before editing.
- Risks: data shapes, storage keys, migrations, public URLs, SEO, auth, money, outward messages, anything
  that does not revert with a code rollback.
- Size: expected changed lines. Above 400, split; above 800, the split is mandatory.
- Test approach: which test fails first (fix), which tests change (change), what stays green (refactor).
- Rollback: how to undo it.

## 4. Plan review (medium and large tasks)

Run `core-review` in plan mode before the first edit. Fold the findings into the plan; repeat until no
critical or high finding is open.

## 5. Ask or decide

Ask the human only at a real fork: the answer changes what you do and neither the request, the code, the
project rules nor a convention settles it. Otherwise choose the conventional default, state it, continue.
