---
name: core-verify
description: Runs this project's own gates (lint, tests, build, project checks) through the core CLI, which writes a receipt keyed to the commit with exit codes, test counts and output hashes. Use from core-dev at the verify stage, after every fix round, and before done.
---

# core-verify

The gate list lives in `.claude/team/project.json` (project-owned). Project rules decide which gates are
required for which change; this skill runs them and keeps the evidence.

## Run

```bash
node "$CORE/team/tools/team.mjs" verify --project . --task <id> [--stage pr|merge]
```

- Runs every required gate in order, each the number of times it asks for (tests three times before a
  pull request, five with `--stage merge`).
- Writes `.claude/team/receipts/<task>-<n>.json`: commit, dirty flag, per gate the command, exit codes,
  durations, parsed test count, output hash and a redacted tail.
- Exit 0 only when every required gate passed every run. A test gate that ran zero tests fails.
- Paste its result table into the report as is.

The `core-verifier` agent runs the same command when a separate, read-only verifier is wanted.

## When a gate fails

Fix the cause, never the gate. Do not loosen a lint rule, skip a test, raise a threshold, add
`--passWithNoTests` or edit the gate command to get green. If a gate cannot run on this machine, it is
SKIP with the reason; SKIP is never PASS.

## Without the CLI

Run each gate command from `project.json` yourself, quote the command and the last lines of output, and
mark gates `self-reported`. A self-reported gate does not count as verified on the dashboard.

## Beyond the gates

Gates check the code; the acceptance criteria check the outcome. Also run what proves each criterion:
the page in a browser at the project's viewports for UI work, the real request for an API change, the
project's deployment verification for a release. Record that evidence in the task record.
