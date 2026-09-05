# Lessons: the failure classes and what stops them

Format: what happened, the real cause, the fix applied, and the prevention that now exists. Each entry is
written generally, as a class of failure any team working with an AI assistant can meet; the project that
produced them keeps its own dated, numbered version privately.

## Enforcement and process

### A rule in memory is not a control
- **What happened:** A reviewer bot's comment on a pull request was missed even though the "sweep all
  feedback" rule already existed in the assistant's memory, and the human had already reminded it once.
- **Cause:** The sweep filtered by known reviewer names; a second bot used a different login. The rule
  described the outcome, not the mechanism.
- **Fix:** An author-agnostic sweep script that enumerates every comment, review and thread, subtracts
  only the assistant's own login, requires an explicit acknowledgement per open item, and exits non-zero
  otherwise.
- **Prevention:** A ledger of misses with root causes; every rule that matters gets a mechanism and an
  offline evaluation suite; the session start checks that the mechanisms are still wired.

### An evaluation can pass for the wrong reason
- **What happened:** Most test cases for a trend-check script were green.
- **Cause:** The script exited 0 both on success and on "nothing found"; the cases never asserted content.
- **Fix:** Every evaluation asserts the expected content, not the exit code, and every suite has at least
  one case designed to fail if the mechanism is broken.
- **Prevention:** Rule 9 in PRINCIPLES.md; the "eval must be green in the same session as a mechanism
  change" rule.

### Self-enforcement has a ceiling
- **What happened:** The assistant wrote hooks, tokens and deferral records to constrain itself.
- **Cause:** An agent that writes its own controls can also bypass them; the threat was forgetting, not
  malice, but the design should say so.
- **Fix:** Anchors reordered: server-side protection and the human's approval are the real controls; local
  hooks warn loudly and log; the audit log is append-only and surfaced daily.
- **Prevention:** Every new control states which anchor it is; a hook is never called "the source of
  truth".

## Planning

### Plans written on dead premises
- **What happened:** A two-PR plan targeted work a teammate had already merged; two ticket premises were
  wrong because a policy was paraphrased.
- **Cause:** Planning from memory and from ticket text rather than from the live repository state and the
  policy source itself.
- **Fix:** Planner intake reads all-author PR lists and the policy source each run; every item carries a
  premise verdict and the source read.
- **Prevention:** The planner's verify predicate rejects items without a premise verdict and a source;
  refuted premises get their own section and never enter the item list.

### Fixed slot plans break on external dependencies
- **What happened:** Most of one day's planned test slots were blocked by seed data and credentials only
  the human could provide.
- **Cause:** Plans fixed per day with no substitution rule.
- **Fix:** Work unit changed to "one task or one bound cluster to completion"; a blocked slot is replaced
  by the next feasible task, with dependencies verified live before choosing.
- **Prevention:** Blocked tickets are listed in a lane file the morning drift check reads, so "blocked"
  is distinguishable from "not started".

### The measure itself can rot while everyone is busy
- **What happened:** Over more than a week the nightly end-to-end pass rate fell sharply on two apps and
  hard failures climbed from zero to double digits; dozens of pull requests were written; none fixed a
  standing failure. Product regressions in that period: zero. Every failure was a test bound to a removed
  UI element, a fixture using a role a migration had revoked, or a default date outside the test's own
  permitted window.
- **Cause:** A stop rule existed for review findings but none for the nightly signal, and work-in-progress
  was uncapped, so "fix the instrument" competed with many open threads and lost.
- **Fix:** The "on the line" standing rule (two consecutive valid nights with a hard failure freezes new
  test surface for that app) and a WIP cap, both checked by a morning drift script.
- **Prevention:** The planner reads the drift file's standing rules verbatim and may not recompute them;
  the instrument's validity is the first line of every plan.

### Estimates nobody checks never improve
- **What happened:** Planned tasks carried a minute estimate that no step ever compared with the time the
  session took, so the same optimism repeated daily.
- **Cause:** The estimate had no consumer; nothing measured the actual.
- **Fix:** The runner records the session's duration and token use per task; a deterministic script joins
  them with the estimates; the review copies the comparison and writes a calibration note; the planner's
  header carries the median ratio of recent slots.
- **Prevention:** Rule 17; a planning lesson whenever an estimate is off by more than double or less than
  half.

## Debugging

### Environment before code
- **What happened:** A unit-test runner hung locally but not in CI; many speculative code fixes were tried
  over a long stretch.
- **Cause:** An operating-system difference the handoff notes had already flagged; the symptom blamed
  appeared identically in clean runs.
- **Fix:** One falsifying experiment (toggle the environment) before any code change; compare a failing run
  with a passing one before naming a cause.
- **Prevention:** Rules 10 and 11; a debugging checklist that starts with "what differs between the green
  and red runs".

### A gate that scans the whole tree blocks your own other branches
- **What happened:** A new lint pattern added to a local gate scanned the entire repository, so a few old
  lines still on the trunk blocked every other branch of the same author until the fixing PR merged.
- **Cause:** The pattern was authored as tree-wide without checking the trunk for existing matches.
- **Fix:** Stack the dependent PRs rather than weaken the gate; grep the trunk before adding a tree-wide
  rule.
- **Prevention:** "grep first" is now part of the gate-authoring checklist.

### The fix creates the next defect
- **What happened:** A fix for an unescaped regular expression switched from iterating own entries to an
  indexed lookup and thereby exposed prototype properties to template substitution.
- **Cause:** The rewrite changed a property-access semantics the original code had implicitly relied on.
- **Fix:** An own-property guard; a spec pinning the behaviour.
- **Prevention:** The adversarial four-lens review before every PR (failure path, data integrity scope,
  contract coverage, configuration sequencing) caught this one; it is now a mechanised gate.

## Communication and reporting

### The artefact, not the chat
- **What happened:** A day's standup report was written in full in the conversation and never inserted
  into the file the human copies from; the day was simply missing.
- **Cause:** Treating the notification as the deliverable.
- **Fix:** A grep check that the day's block exists before saying "ready".
- **Prevention:** Rule 25; the headless report job verifies the block after the model run.

### Audience decides the language
- **What happened:** Task names and comments in the engineer's first language landed in the shared tracker.
- **Cause:** The language rule listed PR and code surfaces only, so the tracker did not pattern-match.
- **Fix:** Renamed and rewritten the same day.
- **Prevention:** The rule is now "if anyone else may read it, it is in the shared language", and a
  pre-tool hook denies non-shared-language characters in tracker and PR writes.

### Reports must own what is red
- **What happened:** A deployment stayed red for days without anyone noticing.
- **Cause:** Daily reports did not mention workflows outside the author's stream.
- **Fix:** Any red workflow on the trunk at report time is a named action item with an owner and a link.
- **Prevention:** Rule 26; the report generator checks the trunk's workflow status.

### Red checks with non-code causes stall merges silently
- **What happened:** Several pull requests sat for days with no review decision; the red ones were red
  because a third-party review service reported itself unavailable or an advisory CI job hit its timeout,
  not because of code.
- **Cause:** Merging is gated on a senior who sees only "red" in the list. A vendor outage and a CI-config
  timeout look identical to a real failure, so nobody acts.
- **Fix:** The next message to the merger names the clean PRs and labels each red PR with the non-code
  cause of its failing check.
- **Prevention:** Every PR status report carries a "why red" column (code, vendor, CI-config) with the
  evidence line, and recurring CI-config failures get a ticket the day they are root-caused.

## Automation and infrastructure

### Unattended jobs need their own guard rails
- **What happened:** A headless planner run failed its own integrity check.
- **Cause:** The human was editing files in a watched tree while the run was in flight; the check could
  not distinguish the human's edits from the model's.
- **Fix:** Two-tier tree check: hard for the harness, the scheduled jobs and the settings; warning for
  trees the human may be editing.
- **Prevention:** "Do not edit watched trees during an acceptance run" is written down; run output goes
  only to a state directory that is never synced.

### The scheduler's shell is not your shell
- **What happened:** A scheduled job resolved the wrong source-control account and a different runtime
  version, so author-scoped queries returned nothing.
- **Cause:** The scheduler runs with a minimal PATH and the machine's default account, not the work one.
- **Fix:** Login-shell invocation, pinned runtime path, token probed and verified against the expected
  login, fail closed.
- **Prevention:** Every runner logs the token source and the verified login before doing anything.

### A review job must check that the period it reviews actually happened
- **What happened:** The end-of-day review fired out of band, minutes after the morning planner, with no
  execution records, and scored an empty day into the series.
- **Cause:** Neither the runner nor the review checked that the work window had elapsed or that any
  execution record existed.
- **Fix:** Out-of-band runs are tagged and excluded from the trend; the review states the reason.
- **Prevention:** The review job compares the clock with the end of the last work slot and looks for
  execution records before scoring.

### A usage limit mid-run is a checkpoint, not a failure
- **What happened:** The risk that an unattended run exhausts the subscription window and dies with
  half-written output.
- **Cause:** No reading of usage available inside a headless run.
- **Fix:** A status-line shim records usage from interactive sessions; a fence reads it before each job:
  near the limit a job starts only if the remaining budget covers its static need plus a reserve, otherwise
  it pauses with a checkpoint and a resume job kicks it after the reset.
- **Prevention:** Every job has a cost cap and a wall-clock cap as independent brakes; each daily slot is a
  fresh session so no single session can run out midway.
