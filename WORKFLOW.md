# The daily loop

One engineer, one AI assistant, one working day. The loop has three model steps (plan, execute, review) and
a set of deterministic scripts around them that decide whether a step really happened. Every model step
runs as a fresh, non-interactive session with a chosen model, a cost cap, a wall-clock cap and a usage check
before it starts. Run output goes to a state directory outside the code repositories and is never pushed.

```
morning      PLANNER   -> day plan (markdown for people + JSON for machines)     strongest model
fixed slots  SLOT 1..N -> one planned task each, fresh session, model per task,   model chosen by the planner
             ceiling = draft pull request, report per slot
end of day   REVIEW    -> structured self-review, lessons, general tips,          strongest model
             then a deterministic script regenerates the score series
weekly       RETRO     -> plan vs actual, health of every scheduled job,          strongest model
             research of public practice worth adopting
```

## 1. Planner

Inputs, read live every run, never from memory: last night's test verdict and report, the standing rules
file (for example "app X admits repair work only"), the ticket tracker inbox, open pull requests from all
authors, the review-findings trend, yesterday's review (its "tomorrow" list and its lessons), yesterday's
slot reports, and the notes the engineer typed into the dashboard over the last few days.

Rules of selection, in order: repair the measuring instrument or triage a new hard failure; overdue or due
today; the current roadmap week; always at least one prevention item (something that moves detection
earlier). Standing rules apply first. Every item rests on a premise that was checked this run and marked
`confirmed` or `plausible`; refuted premises are listed and never planned.

Every item carries two estimates the runner will later compare with the measured actual: minutes of
session time, and thousands of "work tokens" (fresh input + cache writes + output). The planner's header
carries a calibration line computed from recent measured slots (median actual over estimate, per model),
so today's estimates are corrected by yesterday's misses rather than repeated.

Output: a markdown day file (intake, standing rules, items, refuted premises, decisions needed) and a JSON
file with the same items, each carrying slot, start time, title, why, type, ticket id or a ticket draft
with `needs_ticket: true`, model and the reason for it, the two estimates with their basis, acceptance
criterion, approach, evidence, risk, repository and ceiling (`investigate` or `draft-pr`). Both files are
checked by a predicate script before the run counts as a success: item counts match, slots are 1..N, models
are from the allowed set, the minute estimate fits a slot and the token estimate fits the session budget,
every ticket id exists in the inbox, ticketless items carry a draft, at least one prevention item exists,
the summary is not empty. See [templates/day-plan.schema.json](templates/day-plan.schema.json).

## 2. Slots

The runner, not the model, decides whether slot N runs: weekend, no plan, no item, executor switched off,
day on hold, engineer pressed Skip, item owned by the human, or item without a ticket that the engineer has
not approved, all end as a recorded skip with its reason. When the engineer approved a ticketless item, the
runner creates the ticket in the tracker (the only tracker write in the whole system), patches the plan item
with the new id, and then starts the session.

The session gets the item JSON, the engineer's note for it, the ceiling and the report path. It first
re-checks the premise against the live source; refuted work stops immediately with an honest report. For a
`draft-pr` item it works in a fresh git worktree off the trunk, runs the repository's own gates (tests
several times, local verification with a receipt, adversarial review, local code-review scan), commits,
pushes the branch and opens one draft pull request marked as a draft pending review. It never flips a PR to
ready, merges, comments on or edits PRs, force-pushes, or touches the scheduler, settings or the dashboard
data. Near the end of its time box it stops starting new work and writes its report.

The report has a frontmatter (status done / partial / blocked / not started, premise, PR URLs, branches,
worktree, test runs, gate results) and sections What was done / Evidence / Blockers / Lessons (candidate) /
Next action. A predicate checks it. A runner-only JSON record sits beside it: outcome, cost, turns, model,
verified, and the measured actual (minutes from the session's duration; work tokens split into fresh input,
cache writes, cache reads and output). A deterministic script joins the plan's estimates with those actuals
into an estimation file per day: ratio, an on-band verdict, and whether the session stayed small enough that
a second small task could have shared it.

Why fresh sessions: a session that runs out of context or usage mid-task leaves half-done work that a human
must untangle. Several short sessions with a usage check each cannot do that, and each one starts from the
plan and the live state rather than from a long, drifting conversation.

## 3. Review

Reads the plan, the slot reports and records, the engineer's approvals and notes, the live PR state
(including what merged today), last night's verdict and yesterday's review. Then it judges: per task an
outcome and a percentage of the acceptance criterion met with the evidence it saw; four axes 0 to 10
(planning accuracy, execution, verification, communication) and an overall score with a written rationale;
one lesson per miss with cause, fix and prevention; the improvements applied today because of yesterday's
lessons and whether they helped; at most two general tips.

It also copies the day's estimate-versus-actual numbers (never recomputes them; the predicate compares the
copy with the runner's file), explains each miss in one sentence, and writes a calibration note the next
planner must apply. An estimate off by more than double or less than half is itself a planning lesson.

Outputs: the review as JSON and as markdown, the day's lesson file in the private knowledge base, and the
general tips appended to the public `TIPS.md` (existing tips are never deleted). The runner then regenerates
the score series deterministically and refuses the run if the public file gained a project-specific term.
See [templates/review.schema.json](templates/review.schema.json).

The four-question daily report for the engineer lives inside the review: what was done today, where every
PR stands, what tomorrow looks like, what needs the human. It is short on purpose.

## 4. The dashboard: where the two of you talk

A single local HTML page backed by a tiny local API bound to the loopback address only:

- **Today Plan**: the items with slot time, why, ticket link or "needs ticket", model and reason, the two
  estimates, ceiling, live status from the slot records and, once measured, estimate versus actual; buttons
  Approve (create ticket and run), Skip, Undo, a per-task note passed into the session, a day Hold switch,
  an executor On/Off switch, Run planner now, Run review now, and a message box whose text reaches tomorrow's
  planner and today's review.
- **Daily Report**: the four questions, with a Copy-as-Markdown button.
- **Self-review**: today's score and the four axes, the task table with evidence and estimate versus actual,
  the lessons, the improvements applied, the score history.
- **Tips**: the general tips rendered in place.

Approvals, holds, the executor switch and the engineer's notes are the only things the page writes, all into
the state directory as JSON or markdown the runners read. The plan, the slot reports and the reviews are
never edited from the page.

## 5. Controls, in order of trust

1. Server-side and human: branch protection, a senior merges, the engineer flips a PR to ready. The
   assistant's ceiling is a draft pull request.
2. Environment: read-only tracker mode for the model (the runner alone may create an approved ticket),
   dry-run for outward posting, read-only or scoped tokens probed and failing closed.
3. Tool deny-lists per job (proposing jobs cannot write files at all; executor sessions cannot change PR
   state, force-push, or touch the scheduler or settings) and a single path-restricted writer for every file
   a model produces.
4. After-run integrity: the test harness, the scheduled jobs and the settings must be byte-identical after
   every run; other watched trees report a warning.
5. Predicates: a run is a success only when the artefact passes the checks above, not when the model says
   it finished.
6. The usage fence: near the subscription limit a job starts only if the remaining budget covers its static
   need plus a reserve; otherwise it pauses with a checkpoint and a resume job kicks it after the window
   resets.

## 6. Reusing this loop elsewhere

Keep the shape, replace the parts: your own instruments in the planner's intake, your own gates in the
slot's method, your own tracker in the runner's approved-ticket step, your own scheduler, your own
dashboard for the two human clicks that matter (approve, skip). The formats in [templates/](templates/) are
the contract between the steps; the predicates are what make "done" mean something.
