---
name: core-done
description: The done gate of the core dev team. Checks the done predicate against receipts and review records, then closes the task record that the core collector scores. Use from core-dev as the last stage of every task, including partial, blocked and refuted ones.
---

# core-done

## The predicate

A task is `done` only when all hold:

1. Every acceptance criterion has evidence (command and result, screenshot path, URL checked).
2. The latest `core-verify` receipt is for the current commit and every required gate passed.
3. Review ran with the lenses the class requires; no critical or high finding is `open`.
4. The project's own definition of done holds (for example deployment checks, a spec folder, a log
   entry). Project rules win.
5. Nothing under blockers says missing, not run, skipped or could not run.

Otherwise the outcome is `partial`, `blocked` or `refuted`. Say so plainly; an honest partial is worth
more than a false done.

## Close the record

```bash
node "$CORE/team/tools/team.mjs" task done --project . --task <id> --outcome done|partial|blocked|refuted --evidence "<criterion: proof>" [--evidence "..."]
```

The CLI assembles the record from facts it holds: the start time and estimate from `task start`, the
gates from receipts, rework rounds from failed receipts before the passing one, findings from `review`.
It appends one line to `.claude/team/ledger.jsonl`. You supply only the outcome and evidence. Never write
the ledger by hand and never assign a score; the collector scores.

Without the CLI, put the same facts in the final report under "Task record (unrecorded)".

## Report

Class, stages run, project rules applied, gate table, findings and dispositions, what was skipped and why,
the task id, and the next unblocked step.
