# The core dev team

A reusable team of Claude Code agents and skills that any project can install. It merges the ECC harness
(pinned, MIT) with the method in this playbook. Design and reasons: [SDD.md](SDD.md).

Requirements: Node 20 or later, git, the GitHub CLI (`gh`) for fetching the pin and for scouting, and
Claude Code. No npm dependencies.

## Install into a project

```bash
node team/tools/team.mjs fetch                         # once: clone the pinned ECC tag into team/.cache
node team/tools/team.mjs profiles                      # core, web-ts, vite, nextjs, seo-content, ai-llm
node team/tools/team.mjs install ../my-app --profile web-ts,vite --dry-run
node team/tools/team.mjs install ../my-app --profile web-ts,vite
node team/tools/team.mjs check ../my-app               # exit 1 on drift
```

The install adds files under `.claude/` only:

| Path | Owner | What |
|---|---|---|
| `rules/core-team.md` | core | always loaded: precedence and the "every development task goes through `core-dev`" rule |
| `skills/core-*`, `agents/core-*` | core | router, plan, review, verify, done, improve; verifier and lens reviewer |
| `team/library/` | core (vendored) | the profile's ECC skills and rules, read on demand through `INDEX.md`; byte-identical except recorded patches |
| ECC agents (`agents/*.md`) | core (vendored) | the reviewers, planners and build fixers the pipeline dispatches |
| `team/lock.json` | core | every installed file with its sha256 and source |
| `settings.json` | project, created if absent | a `UserPromptSubmit` hook that reminds every session of `core-dev` |
| `rules/core-project.md` | project, created if absent | the project's overlay: where its rules live, its gates, its stage rules |
| `team/project.json` | project, created if absent | gate commands for `core-verify`, and `extraEcc` additions |

Project rules always win over the core. The core never writes `AGENTS.md` or `CLAUDE.md`, never overwrites a
file it did not install, and leaves project-owned files alone after creating them.

Add to the project's `.gitignore`:

```
.claude/team/ledger.jsonl
.claude/team/receipts/
.claude/team/open/
```

## How a task runs

`core-dev` classifies the task and picks the stages. The facts the score uses are written by the CLI, not
by the agent:

```bash
CORE=<path to this repository>
node $CORE/team/tools/team.mjs task start --class fix --title "Fix rounding" --estimate 30 --premise confirmed
node $CORE/team/tools/team.mjs verify --task <id>              # runs the project's gates, writes a receipt
node $CORE/team/tools/team.mjs review --task <id> --lens failure-path --findings 0
node $CORE/team/tools/team.mjs task done --task <id> --outcome done --evidence "rounding: unit test passes"
```

`task done --outcome done` is refused without a passing receipt for the current tree, without the four
review lenses (for classes that need review), with an open critical or high finding, or with evidence that
admits an omission. `gate` exits 1 unless the current tree has a passing receipt, for use in hooks.

## Scores, roadmap, scouting, dashboard

```bash
node team/tools/team.mjs collect      # score new task records, read their CI, count commits without a task
node team/tools/team.mjs register ../my-app --gh-user <login>   # account used to read that project's CI
node team/tools/team.mjs evaluate     # agent rubric scores, calibration, roadmap
node team/tools/team.mjs scout        # well-starred public skills, trust-scanned and ranked
node team/tools/team.mjs adopt <id>   # the one human step: vendor a passing candidate
node team/tools/team.mjs serve        # dashboard on 127.0.0.1:4417 (server only)
```

### One command: `run-core-dev`

```bash
node team/tools/team.mjs install-command   # once: symlink run-core-dev into a writable directory on PATH
run-core-dev                               # start the dashboard and open it in the browser
run-core-dev --port 4500 --no-open         # another port; do not open a browser
```

If a dashboard is already running on the port, `run-core-dev` just opens it again. `install-command` prefers
the home `bin` directories, never overwrites a file it did not create, and `CORE_NO_OPEN=1` disables the
browser for scripted use. Ctrl+C stops the server.

State lives in `$AGENTIC_TEAM_HOME` (default `$HOME/.agentic-team`), outside every repository. The
dashboard runs due jobs every minute while it is open; `schedule print-macos` prints a background job
definition for when it is closed, which you install yourself.

## Tests

```bash
node --test 'team/tools/tests/*.test.mjs'
```
