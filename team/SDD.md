# SDD: the core dev team

Status: implemented (v0.1.0) and installed in three projects. Evidence: the test suite and mutation run in
[REVIEW.md](REVIEW.md), the context measurement in section 6.1, the rollout record in section 11. Language: English (shared surface).

This document designs a reusable, specialised team of Claude Code agents and skills that any project can
install. It merges three sources:

1. **ECC** (the "everything Claude Code" harness by affaan-m, MIT, pinned at tag `v2.2.3`, commit
   `c05b2d6614f62f6db0047669aa4eefb223d478f9`): 68 agents, 293 skills, 94 commands, 22 rule packs.
2. **This playbook**: [WORKFLOW.md](../WORKFLOW.md), [PRINCIPLES.md](../PRINCIPLES.md),
   [LESSONS.md](../LESSONS.md), [VERIFICATION.md](../VERIFICATION.md), [TIPS.md](../TIPS.md).
3. **The maintainer's own working method**: plan / open-PR / finish-PR / review skills and a QA
   automation repository that vendored part of ECC with a pin table, a byte-identical sync check, a local
   verify loop and fail-closed hooks. Genericised before entering this public repository.

The result is called **the core**. Every development task in an installed project goes through it.

## 1. Goals and non-goals

Goals:

- G1. One entry point for every development task: the `core-dev` skill classifies the task, reads the
  project rules, chooses the stages, the agents and the skills, and states what makes "done" true. A
  `UserPromptSubmit` hook in the project reminds every session of it (section 4.2).
- G2. **Project rules beat the core; the core beats vendored ECC text.** Install-time guarantees plus an
  always-loaded rule; see section 4 for exactly what is and is not mechanical.
- G3. All of ECC is pinned and reachable; each project receives a profile subset, byte for byte except
  for recorded patches, with a lock proving it.
- G4. The core scores its agents (static rubric now, outcome scores from receipts-backed task records when
  there is enough data) and turns the scores into an improvement roadmap.
- G5. The core scouts well-starred public repositories for skills that close gaps in its agents,
  trust-scans them and proposes upgrades. Adoption is one human click.
- G6. A local dashboard: quality, schedules for scans and evaluations, quality over time, which projects
  call the core, and a score plus a comparison for every completed task.

Non-goals:

- ECC's hook runtime, plugin or installer (section 3.3).
- Changing a project's `AGENTS.md` or `CLAUDE.md`. The core adds files and creates
  `.claude/settings.json` only where none exists.
- Unattended adoption of third-party content (section 7.5).
- Committing third-party content to this public repository: ECC is fetched at its pin, adopted skills live
  in the local state directory.

## 2. Architecture

```
playbook repo (public)                      each project
team/                                       .claude/
  SDD.md  README.md                           settings.json        created if absent; project-owned after
  core/   first-party payload   ----------->  rules/core-team.md   always loaded, installed
    rules/ skills/ agents/ templates/          rules/core-project.md  overlay, project-owned
  profiles/*.json                              skills/core-*/       first-party skills, listed every session
  ecc.lock.json   upstream pin                 team/library/        ECC skills and rules on demand (+INDEX.md)
  tools/team.mjs  CLI, no dependencies         agents/*.md (+LICENSE-ECC)
  tools/lib/  tools/tests/                     team/lock.json       installed files and hashes
  dashboard/                                   team/project.json    gate commands, project-owned
  .cache/ (ignored) pinned ECC checkout        team/ledger.jsonl, receipts/, open/   gitignored

state directory ($AGENTIC_TEAM_HOME, default $HOME/.agentic-team), outside every repository:
  registry.json  schedules.json  tasks.jsonl  agent-scores.jsonl  runs/  candidates/  adopted/  locks/
```

- First-party skills and agents are prefixed `core-`; a vendored skill promoted to a live skill is prefixed
  `ecc-`. Claude Code lists a skill by its directory name (verified), so the prefix is real even though
  upstream `name:` stays verbatim. Library skills keep their upstream directory names.
  Vendored agents keep upstream names; the installer refuses a name collision.
- ECC is fetched with `gh repo clone affaan-m/ECC` at the pinned tag into the ignored `team/.cache/`, and
  the CLI refuses to continue unless `HEAD` equals the pinned commit. Reason: this repository is public
  and guarded by `tools/publish-check.sh`; admitting a vendored tree would mean weakening the gate
  (PRINCIPLES rule 21). Per-file sha256 in every project lock gives the same reproducibility.
- Projects receive committed copies: a fresh clone works offline and review shows what agents read.
- State lives outside every code repository, as [WORKFLOW.md](../WORKFLOW.md) prescribes for run output.

### 2.1 Verified platform facts (Claude Code 2.1.287, throwaway repositories)

- Skills load only from `.claude/skills/<name>/SKILL.md`, one level deep; a nested skill is invisible.
- The Skill tool lists the directory name (`ecc-x` with `name: y` is listed as `ecc-x`).
- Agents load from `.claude/agents/<name>.md`.
- A project `.claude/settings.json` `UserPromptSubmit` hook printing `hookSpecificOutput.additionalContext`
  reaches the model on every prompt, including `claude -p`.
- `AGENTS.md` is loaded as project instructions when no `CLAUDE.md` exists (observed in a target project).
- Rules with `paths:` stay out of context until a matching file is read; unscoped rules always load
  (verified on 2.1.286 in the sibling repository).
- Baseline context in an empty repository: 26 433 tokens (one sample; section 10 requires three).
- Not verified, so not relied on: which project rule files a subagent receives. Vendored agents are
  therefore run by the main session, which holds the rules, and their output is checked there.

## 3. ECC intake

### 3.1 Triage

Every agent, command, rule and hook was read in full; every skill by frontmatter, file listing and a
risk-pattern search with each hit read by hand. Tiers: `core`, `web-ts`, `nextjs`, `seo-content`,
`ai-llm`, `ops`, `research`, `domain-other`, `meta-ecc`. Risks: `ok`, `writes-outside-repo`,
`network-unpinned`, `edits-harness`, `needs-missing-deps`, `mandatory-trigger`.

Skills: domain-other 143, core 41, meta-ecc 30, web-ts 26, ai-llm 24, research 11, seo-content 10,
ops 7, nextjs 1. Risk: ok 222, needs-missing-deps 30, network-unpinned 17, edits-harness 11,
writes-outside-repo 11, other 2. Only `ok` items enter a profile, and a second review against the target
projects removed more (section 6).

### 3.2 Drop criteria (any one suffices; also the trust rubric for scouted skills)

Writes or caches outside the repository; runs unpinned remote code (`npx` of a package the project does
not have, `pip install` without a version, piping a download into a shell); rewrites settings,
permissions or hooks; sends repository content or the user's question to an external service or an
unapproved MCP server; references hooks, commands, scripts or agents it does not ship and the profile
does not install; mostly a catalogue of things the project does not have; self-declares as mandatory for
every session; an agent with write tools that may change hooks or settings; a rule with no `paths:` that
contradicts project rules; a document for hooks we do not install.

Dropped from every profile: `rules/common/*` (unscoped; 80% coverage gate, conventional commits, global
settings), `rules/*/hooks.md` (global settings edits; a Stop hook running a build); agents
`harness-optimizer`, `docs-lookup`, `gan-*`, `loop-operator`, `chief-of-staff`, `e2e-runner` (global
install), `tdd-guide` (coverage gate), `refactor-cleaner` and `performance-optimizer` (unpinned `npx`
tools); skills `eval-harness` (ships a script), `click-path-audit` (external commands), `delivery-gate`,
`gateguard`, `plankton-code-quality`, `config-gc`, `continuous-learning*`, `strategic-compact`,
`safety-guard`, `ck`, `documentation-lookup`, `council-multi-model`, `security-scan`, `configure-ecc`,
the `orch-*` family, `dev-team`, `team-builder`.

### 3.3 Why our own installer

ECC's installer targets a project but installs whole modules (one agent pulls every agent; one skill pulls
four modules including unrelated domains), every language rule pack plus unscoped `common/`, and unprefixed
skills. The plugin loads all 293 skills and 94 commands. A whitelist copier is the only way to a subset.

### 3.4 Transforms and patches

- `strip-auto-triggers` (every vendored agent): removes from the `description:` line each sentence
  containing an auto-invocation phrase (`PROACTIVELY`, `MUST BE USED`, `immediately after`, `Use for all`,
  `Use for any change`, `Automatically activate`). Otherwise Claude Code delegates every edit to them and
  the core loses the routing. A test fails if any phrase survives.
- Literal patches declared in a profile (`file`, `search`, `replace`, `reason`). A patch whose search text
  matches zero times fails the install, so a re-pin cannot silently drop a patch. v0.1 patches:
  `build-error-resolver` loses `npx eslint . --fix` and the "delete node_modules and the lock file"
  recipe.
- The lock records the upstream sha256, the installed sha256 and the transforms applied. Everything else
  is byte-identical.

### 3.5 Conflicts left in vendored text

Vendored text still mentions coverage percentages, `pnpm`, conventional commits or ECC commands that are
not installed. `core-team.md` says project rules and the core win and anything not under `.claude/` does
not exist here. The installer also lists every `/command` and agent name a vendored file mentions that is
not installed, in the lock as `unresolved`, so the gap is visible rather than discovered mid-task.

## 4. Precedence: project rules beat the core

Authority, highest first: (1) the human's explicit instruction in the session; (2) the project's rules:
`AGENTS.md`, `CLAUDE.md`, project-written `.claude/rules/*.md`, `.claude/rules/core-project.md`;
(3) the core; (4) vendored ECC text. Personal or organisation skills written for other repositories do
not apply in a project unless its rules say so.

### 4.1 What is mechanical

- The installer never writes `AGENTS.md` or `CLAUDE.md`; it creates `.claude/settings.json`,
  `core-project.md` and `team/project.json` only when absent and never touches them again.
- It refuses to overwrite any file it did not install (it compares with its own lock) and refuses symlinks
  anywhere in source or destination.
- On a reinstall it refuses to run with uncommitted changes under `.claude/` unless `--force`. A first
  install skips that guard (there is nothing of its own to protect yet) but still refuses to overwrite any
  existing file, and warns when an existing `settings.json` lacks the reminder hook.
- Every lock entry must name a path under `.claude/` without `..` or symlinks, so a tampered lock cannot
  make an install delete or overwrite anything elsewhere.
- `check` reports drift on installed files, missing files, and unknown files inside installed directories;
  project-owned files are excluded from drift.

### 4.2 What is guidance, honestly

Claude Code concatenates memory files; load order confers no authority. Precedence therefore rests on
explicit text: `core-team.md` opens with the order, `core-dev` makes "read the project rules" step zero
and asks for the overriding rule to be cited, and each `core-project.md` points to the project's own rules
rather than copying them (copies drift). The `UserPromptSubmit` hook makes the router hard to miss but
cannot force a skill to load; the done record shows when it was skipped (a task with no record is visible
as `unrecorded` once `collect` matches commits, a v0.2 item).

## 5. The team

| Role | Agent or skill | From |
|---|---|---|
| Router and lead | `core-dev` | core |
| Premise and plan | `core-plan`; agents `planner`, `architect`, `code-architect`, `code-explorer` | core + ECC |
| Plan review | `core-review` plan mode; `core-lens-reviewer`, `architect` | core |
| Implementer | main session; `ecc-tdd-workflow`, stack skills; `code-simplifier`, `a11y-architect` (write tools) | ECC |
| Build fixer | `build-error-resolver` (patched), `react-build-resolver` | ECC |
| Adversarial review (read-only) | `core-review` diff mode: `core-lens-reviewer` x4, `typescript-reviewer`, `react-reviewer`, `security-reviewer`, `silent-failure-hunter`, `pr-test-analyzer`, `type-design-analyzer`, `comment-analyzer`, `code-reviewer`, `seo-specialist` | core + ECC |
| Verifier (read-only) | `core-verifier`, `core-verify` | core |
| Done and record | `core-done` | core |
| Agent quality | `core-improve` | core |

Pipeline, classes and stages: see `core/skills/core-dev/SKILL.md` (the skill is the source of truth).

## 6. Profiles

JSON files in `team/profiles/`: `extends`, `ecc.skills`, `ecc.agents`, `ecc.rules` (files, never
directories), `patches`, `core.skills`, `core.agents`, `excluded` with reasons. A project adds ECC items on
top of its profiles through `extraEcc` in its own `project.json` (the project decides; `check` honours it).

| Profile | Content |
|---|---|
| `core` | core payload; library skills search-first, council, tdd-workflow, verification-loop, security-review, coding-standards, architecture-decision-records, codebase-onboarding, santa-method, iterative-retrieval, agentic-engineering, error-handling, api-design; agents planner, architect, typescript-reviewer, security-reviewer, silent-failure-hunter, pr-test-analyzer, build-error-resolver |
| `web-ts` (extends core) | library skills frontend-patterns, react-patterns, react-testing, react-performance, e2e-testing, accessibility, frontend-a11y, production-audit, contract-first; agents react-reviewer, react-build-resolver; library rules typescript, web and react: coding-style, patterns, security, testing (+ web design-quality, performance, react hooks) |
| `vite` | vite-patterns |
| `nextjs` | nextjs-turbopack (only for projects building with Turbopack) |
| `seo-content` | seo, i18n-sync, article-writing, brand-voice, content-engine; agent seo-specialist |
| `ai-llm` | cost-aware-llm-pipeline, ai-regression-testing, regex-vs-llm-structured-text, agent-harness-construction, agent-introspection-debugging |

### 6.1 Always loaded versus on demand

Claude Code lists every installed skill's and agent's description in every session, and loads a `paths:` rule
whenever a matching file is read (in a TypeScript project: nearly every session). The first rollout installed
the ECC selection as live skills, agents and scoped rules and measured +24 to +27% context at idle and +35 to
+38% after reading one `.tsx` file, far over the budget. So:

- ECC skills and rules install into an on-demand library, `.claude/team/library/`, with a generated
  `INDEX.md` (name, file, when to use). `core-dev` reads the index and the matching files when a task needs
  them. A profile or `project.json` can promote an item with `activeSkills` or `activeRules`.
- Agents are kept to the roles the pipeline actually dispatches (planner, architect, the reviewers named in
  `core-review`, the build fixers, the SEO specialist). The rest overlap with core agents or built-in commands.
- Always-loaded text (`core-team.md`, the project overlay, core descriptions) is kept short.

Measured after the change (median of 3, Claude Code 2.1.287, before = the same repository without `.claude/`):

| Project | Idle prompt | After reading one TS file |
|---|---|---|
| first target (Vite) | 29 905 -> 32 197 (+7.7%) | 60 107 -> 64 615 (+7.5%) |
| second target (Vite) | 27 844 -> 30 222 (+8.5%) | 55 968 -> 60 668 (+8.4%) |
| third target (Next.js) | 27 212 -> 29 506 (+8.4%) | 54 723 -> 59 251 (+8.3%) |

Every profile file is Markdown (verified: zero non-`.md` files in the profile skills). The installer
still skips any `.ts .tsx .js .mjs .cjs .py .sh` file and fails if a selected skill's body depends on one,
because one target type-checks every `.ts` file in the tree.

## 7. Self-assessment and self-improvement

### 7.1 Facts come from the CLI, not from the agent

| Fact | Written by | When |
|---|---|---|
| task id, class, title, premise, estimate, start time | `task start` | before the first edit |
| gate results: command, exit codes, runs, test count, duration, output sha256, redacted tail, commit, dirty flag | `verify` (runs the commands itself) | each verify round |
| lens runs and findings (severity, location, disposition, reason) | `review` | during review |
| outcome, evidence lines | `task done` (agent supplies only these) | end |
| actual minutes, rework rounds | derived by `task done` from timestamps and failed receipts | end |

The required gate set comes from `project.json`, never from the record. A gate with no receipt for the
record's final commit is `claimed`. Free text (title, notes, evidence) is length-capped and redacted
against credential patterns before it is written; `collect` redacts again.

Receipts are signed with an HMAC key kept in the state directory; a hand-written receipt is ignored by
`task done` and `gate`. This raises the bar but does not stop an agent with shell access that reads the key
and imitates the CLI; the human review of the final report remains the control.

Remaining trust gap, stated: review findings are agent-entered. The score requires every lens to be
recorded and every critical or high finding to be dispositioned, and the dashboard marks review data as
`self-reported`.

### 7.2 Task score (0 to 100, computed by `collect`)

- gates 40: the project's required gates share it equally. Each earns its share only with a receipt on
  the final commit, every run passing, the required run count met (tests: 3 before a PR, 5 for merge), and
  for test gates a parsed test count above zero. `claimed`, `skip`, missing or `fail` earn 0.
- review 25: for classes that change shipped code or content (feature, change, fix, refactor, content,
  hotfix), 0 unless all four diff lenses are recorded; then 25 minus 10 per open critical, 5 per open high,
  2 per open medium, minus 2 per waiver without a reason. Investigate, review and deploy tasks need no
  lenses and are scored on recorded findings only.
- outcome 20: done 20, partial 8, blocked 4, refuted 8.
- rework 8 and estimate 7: only for done or partial. Rework 8 minus 3 per failed verify round before the
  passing one. Estimate 7 when actual over estimate is within 0.5 to 2, 3 within 0.33 to 3.
- `not-started`, a record failing the schema, or one without a matching `task start` scores `null` with a
  reason. An empty world is never a score.

Comparison shows a task's delta against the previous task of the same project, and against the project's
median, always with `n` and the spread; deltas are suppressed below five earlier tasks in the project.

### 7.3 Agent scores

Static rubric (0 to 100) from the agent file: frontmatter complete 15; description says when to use it 15;
no auto-trigger phrase 10; least privilege 20 (analysis, review and planning roles without Write, Edit or
NotebookEdit; a missing `tools` field counts as all tools); prompt-defence section 10; output format
section 10; verification or evidence step 10; under 400 lines 5; references only installed agents and
skills 5. A sabotage test proves a keyword-only stub scores low.

Outcome: median task score of tasks that used the agent, `insufficient data (n<5)` below five. Escaped
findings are `unmeasured` in v0.1 (no source yet); never shown as zero.

Core quality index: the static mean and the 30-day median task score shown side by side, never blended.

### 7.4 Roadmap

`evaluate` writes `runs/evaluate-<ts>.json` and `.md`: per agent, the failed rubric items as concrete
edits, the outcome trend, and the ids and fit scores of matching scout candidates. It never copies fetched
text into the roadmap, because `core-improve` reads the roadmap.

### 7.5 Scouting and adoption

`scout` uses `gh search repos` and `gh api --method GET` (no credentials handled, no URL hard-coded):

1. Queries from `team/scout.json`, filtered by minimum stars and recent activity.
2. Per repository: one tree listing at a resolved commit sha (truncated listings are reported, not
   ignored), collecting `SKILL.md` files, capped per repository.
3. Per candidate skill directory: every file listed with its blob sha; only `.md` files allowed (any other
   file fails the candidate); size cap.
4. Fit: token overlap of the candidate's description with each agent's description and failed rubric
   items, and with the registered projects' stack keywords.
5. Trust scan of every file after NFKC normalisation, zero-width removal and comment stripping: the
   section 3.2 criteria as patterns, prompt-injection phrases, encoded blobs, frontmatter keys outside an
   allowlist (`name`, `description`, `license`, `metadata`). The scan is advisory; human review is the
   control.
6. Licence read from the licence file at the pinned commit (skill-level overrides repository-level); MIT,
   Apache-2.0, the two- and three-clause BSD licences, ISC pass; anything else or unknown fails.

Output: `candidates/scout-<ts>.json` with ids matching `^[a-z0-9-]{1,64}$`. Fetched content is stored as
data in the state directory, rendered as text, never executed, never loaded as instructions.

`adopt <id>` (CLI or the dashboard button behind a confirmation that lists every file with its size, the
licence and the trust flags, and points to the stored copies the human reads first): refuses a
candidate that failed trust or licence; re-fetches exactly the recorded blob shas and refuses on any
mismatch; writes `adopted/<id>/` (files plus licence) and `adopted.lock.json` in the state directory.
Profiles opt in with `adopted: ["<id>"]`; install copies them as `skills/ext-<id>/` after verifying their
hashes against the lock. This applies PRINCIPLES rules 19 and 38: search, scan and propose are scheduled;
the change to what agents read waits for a person.

## 8. Dashboard

`node team/tools/team.mjs serve` binds `127.0.0.1` only (default port 4417), no dependencies. The
`run-core-dev` command (`team/bin/run-core-dev`, put on the PATH by `team.mjs install-command` as a
symlink) starts it and opens the default browser in one step, or reopens a dashboard that is already running.

Pages: **Overview** (core version, projects using the core with profile, installed version, drift, last
task, tasks in 7 and 30 days; quality index parts over time), **Tasks** (score, breakdown, deltas with n,
filter by project and class), **Agents** (static and outcome scores, history, roadmap), **Scout**
(candidates with fit, stars, licence, trust verdict; Adopt only for passing ones), **Schedules** (enable,
cadence, run now, recent runs with status and duration).

Security: exact `Host` match against the bound address on every route including static files; `Origin`
must match on mutating requests, `null` rejected; no CORS headers; a per-process random key delivered in a
`<meta>` tag and required in a custom header on every mutating request, compared in constant time; CSP
`default-src 'self'` with no inline script; every value rendered with `textContent`; job names from a
fixed list run through `execFile` without a shell; schedule fields range-checked; adoption eligibility
enforced on the server.

### 8.1 Schedules

`schedules.json` per job: `enabled`, `every` (`hourly`, `daily`, `weekly`), `hour`, `weekday`, `lastRun`.
`tick` runs due jobs once each under a tick lock, and every job (from `tick`, the dashboard or another
process) also takes a per-job lock, so a job never runs twice at once. Locks are created atomically with
their content (a hard link from a temp file) and a stale lock is moved aside with a rename that only one
process can win. `collect` takes its own lock as well. All state writes go through a temp file and rename; collected
records are de-duplicated by id. The server ticks every minute while running. For closed-dashboard runs,
`schedule print-macos` prints a macOS background job (property list) with absolute `node` and `gh` paths and log files; the
human installs it (a machine-wide change). Failed runs are recorded with their exit code and shown.

## 9. CLI

```
team.mjs fetch                                    clone the pinned ECC tag, verify the commit
team.mjs install <project> --profile a,b [--dry-run] [--force]
team.mjs check <project>                          exit 1 on drift, 2 if the cache is missing
team.mjs task start|done ...                      open and close a task record (run inside a project)
team.mjs verify --project . --task <id> [--stage pr|merge]
team.mjs review --project . --task <id> --lens <l> ...
team.mjs collect | evaluate | scout | adopt <id> | tick | serve | measure <project>
team.mjs schedule print-macos
```

Exit codes: 0 success, 1 the check said no, 2 could not run.

## 10. Verification plan

- `node --test team/tools/tests`: profile composition; transforms (no trigger phrase survives); a patch
  matching nothing fails; executable files skipped; symlink refused; lock round trip; foreign file not
  overwritten; drift sabotage (one changed byte, one extra file, one missing file each turn `check` red);
  missing cache exits 2; task scoring with a sabotage case per rule (claimed gate, partial gate list, zero
  tests, not-started, missing lens, estimate written late); invalid record scores `null`; redaction;
  agent rubric (reviewer given Write loses least privilege; missing `tools`; keyword stub); trust scan
  (each pattern positive and negative, zero-width and split-string evasions); scout with a stubbed `gh`;
  adoption hash mismatch refused; schedule due logic and stale lock takeover; dashboard Host, Origin and
  key checks, path traversal.
- Integration per target project: install from the real pinned checkout; `check`; the project's lint,
  tests and build unchanged; a headless session lists `core-dev` and receives the hook context; context
  cost measured three times before and after on the same CLI version, median reported, once with an
  empty prompt and once after reading a `.ts` file (scoped rules included). Budget: +10% for the first.
- Multi-lens review of design and code (security and operations, test and verification, architecture and
  project fit); findings and fixes recorded in `team/REVIEW.md`.
- `tools/publish-check.sh` and `--staged` clean before pushing.

## 11. Rollout

1. This repository: payload, profiles, CLI, tests, dashboard; publish-check clean; push.
2. Each project, after `git fetch` and fast-forward to `origin/main`, staging explicit paths only:
   adoption record in the project's convention (visa-run `docs/sdd-core-dev-team.md` plus a config-only
   line in `docs/deploy-log.md`; ai-tuvan a full `docs/specs/2026-10-core-dev-team/` with 00 to 04 because
   its CI audits every spec folder; pod-us `docs/sdd/13-spec-core-dev-team.md`); install; `check`; the
   project's gates; measure; register; `.gitignore` lines for `.claude/team/ledger.jsonl`, `receipts/`,
   `open/`; commit; push to `main`.

Result: installed in all three; `check` clean; every project's own gates passed through `verify` on the
final tree; a headless session in each lists the six core skills and receives the routing hook; context
within budget (section 6.1). The rollout itself was run as core tasks (task start, verify, four-lens review,
done) and scored 96 in each project. It also surfaced a pre-existing red CI in one project (the CI Node
version was below the build tool's engine range, which hid a second defect: tests that read build output ran
before the build); fixed as a core task, CI green again.

Decision recorded: the maintainer chose direct commits to `main` for the three first projects (all three
are the maintainer's own), overriding PRINCIPLES rule 18 for this rollout. The commits touch no runtime
code and need no deployment.

## 12. Risks

| Risk | Mitigation |
|---|---|
| Context bloat | profiles, path-scoped rules, measured budget |
| Vendored text contradicts a project | precedence text, `unresolved` list, patches |
| Upstream tag moves | fetch verifies the commit; lock hashes |
| Prompt injection in scouted content | trust scan, data-only handling, human adoption, no fetched text in roadmap |
| Scores become the goal | facts from the CLI, `null` for missing data, outcome beside proxy |
| Dashboard driven by another site | loopback, exact Host, Origin, key header, CSP, textContent |
| Secrets in records | length caps, redaction at write and collect |
| Router skipped | hook reminder; unrecorded tasks visible (v0.2) |

## 13. Rule to mechanism map

A rule that lives only in prose gets skipped under pressure (PRINCIPLES rule 7). Each core rule, the
mechanism that enforces it, and the test that proves the mechanism can fail:

| Rule | Mechanism | Test (sabotage case) |
|---|---|---|
| Project rules win | installer never writes `AGENTS.md`/`CLAUDE.md`, never overwrites foreign or project-owned files | `install.test`: foreign file kept; project-owned files kept on reinstall |
| Every dev task goes through `core-dev` | `UserPromptSubmit` hook in project settings; always-loaded `core-team.md` | `install.test`: hook prints valid JSON naming `core-dev`; verified live in a headless session |
| Vendored text is what the pin says | sha256 per file in the lock; `check` | `install.test`: changed byte, extra file, missing file each turn `check` red |
| Patches cannot silently stop applying | a patch matching nothing fails the install | `install.test`: patch-miss |
| No auto-triggered vendored agents | `strip-auto-triggers` transform | `install.test`: no trigger phrase survives |
| Done is a verified state | `task done` refuses done without a passing receipt for the current tree, missing lenses, open critical/high, or evidence admitting an omission | `task.test`: fabricated pass, edit after verify, open high, omission |
| SKIP is never PASS | a gate earns only with a receipt; zero tests fails a test gate | `task.test` and `score.test`: zero tests, claimed gate |
| An empty world is not a score | invalid or not-started records score `null` | `score.test`: null cases; `collect` reports a missing ledger |
| The agent does not grade itself | scores computed by `collect` from CLI-written facts | `score.test`: partial gate list does not raise the score |
| Fetched content is data | trust scan, no fetched text in the roadmap, `textContent` rendering, CSP | `trust.test`, `score.test` (roadmap), `server.test` |
| Adoption is a human step | `adopt` refuses ineligible candidates and re-verifies blob shas | `scout.test`: ineligible, sha mismatch, tampered file |
| The dashboard cannot be driven by another site | exact Host, Origin, key header, CSP | `server.test`: wrong Host, missing key, wrong Origin, null Origin |

## 14. Ideas taken from the maintainer's private knowledge base

The maintainer keeps a private store of agent memory, hooks, skills, an unattended scheduler with its own
evaluations, and a local dashboard. Nineteen transferable ideas were extracted and written fresh here
(nothing copied). Adopted in v0.1:

- Done-report predicate: evidence that admits something missing, skipped or not run refuses `done`.
- A publish gate predicate: `team.mjs gate` passes only when the current tree has a passing receipt; a
  project may wire it into a `PreToolUse` hook on its push or pull-request command.
- Estimate calibration: `evaluate` reports the median actual over estimate per task class (five samples
  minimum) for the next plan to apply.
- Freshness kept separate from results on the Schedules page (fresh, stale, missed, disabled).
- The rule to mechanism map above.

Delivered in v0.2:

- CI results feed the task score. `collect` lists the commits a task made (`startHead..head`), asks GitHub
  Actions for the runs those commits caused (`push`, `pull_request`; scheduled runs on the same commit do not
  count), and counts each red run as a rework round. A task closed before its commit, or a record from before
  commit tracking, has no attributable commits: CI is `none` or `unknown` and costs nothing. `register
  <project> --gh-user <login>` picks the account used to read a project's CI. `core-done` now says to commit
  before closing the record, and the record carries `uncommittedFiles`. The first live run proved the rule:
  without it, a task closed before its commit was charged with five scheduled-workflow failures on the
  previous commit.
- Commit coverage: `collect` writes `coverage.json` with the last 30 days of non-merge, non-bot commits that
  no task covers; the dashboard shows "commits without a task" per project.
- Review findings per task (median of the last ten, five minimum) in the evaluation and roadmap.
- Adopted skills install into the on-demand library (`library/ext-<id>/`, listed in the index), chosen per
  project with `extraEcc.adopted` in its own `project.json`; the public profiles never name machine state.

Still open:

- Findings per pull request from other reviewers with a stop threshold, each finding turned into a check.
- A miss ledger: a rule existed but was not applied, versus no rule existed.
- An append-only audit log of hook decisions that stores command classes only.
- A weekly retro judged by a separate model, with one prevention item checked the next week.
- Earned versus granted trust, never averaged.
