# Review record: core dev team v0.1

Every finding below came from an independent reviewer that read the design or the code without editing it.
Each was reproduced before it was fixed, and each fix has a test that fails if the fix is removed.

## Round 1: design (three perspectives, 44 findings)

| Perspective | Findings | Main changes to the design |
|---|---|---|
| Test and verification | 14 (2 critical) | The agent no longer writes the facts it is scored on: gate results come from receipts the CLI writes; the estimate is fixed at `task start`; actual time and rework are derived; gate denominator comes from `project.json`; not-started and invalid records score `null`; deltas suppressed below five samples |
| Security and operations | 15 (1 critical) | Dashboard renders with `textContent` under a strict CSP; exact Host, Origin and key checks; adopted content stays in the state directory, pinned by blob sha at scan time; symlinks refused; free text redacted; atomic writes and locks |
| Architecture and project fit | 15 | `UserPromptSubmit` reminder hook for routing; trigger phrases rewritten rather than only removed; profile items that ship scripts or call unpinned tools dropped; rules listed by file; per-project adoption records in each project's own convention |

## Round 2: code (three perspectives)

| Perspective | Confirmed | Fixed |
|---|---|---|
| Correctness | 12 | concurrent `collect` double-counting (lock and de-duplication); task id collisions (random suffix, exclusive create); receipt numbering after deletion (highest plus one, exclusive create); registry clash for equal folder names; omission check matching fixes of missing things; three agent descriptions losing their scope; comparison against the previous task of the project; scout exit code when every search fails; `print-macos` without `gh`; warning when an existing `settings.json` lacks the hook; `project.json` edits void receipts; nested scouted skills |
| Security | 6 | tampered lock entries cannot reach outside `.claude/` (high); atomic lock creation and single-winner takeover, per-job locks across processes; frontmatter lines that are not plain allowlisted keys fail the trust scan; receipts signed with a state-directory HMAC key; gate commands redacted; 500 responses carry no paths; the adopt confirmation lists files, licence and flags |
| Tests and false greens | 34 mutants, 8 survived | a test was added for each survivor; rerun: 34 of 34 killed |

Accepted limits, stated in the design: the trust scan is advisory (homoglyphs pass; the human review is the
control); a receipt signature stops hand-written receipts but not an agent that reads the key; review
findings are agent-entered and marked self-reported.

## Evidence

- `node --test 'team/tools/tests/*.test.mjs'`: 137 passed, 0 failed (run three times without a flake).
- Mutation run: 34 of 34 mutants killed.
- `bash tools/publish-check.sh`: 0 findings.
- Dashboard checked in a real browser at 1280 and 375 pixels, light and dark: no runtime errors, no
  horizontal overflow.
