# Tips for working effectively with an AI assistant

last_updated: 2026-09-06

General, reusable tips distilled from three months of daily work between one engineer and one AI
assistant on a real product. Each tip has a why and a how. The end-of-day review appends new tips here
and strengthens the evidence line of existing ones; nothing is deleted, only refined. Evidence lines
describe the class of situation, never a project, product, ticket or person.

## 1. Set up the relationship

### Decide what the assistant may never do, and enforce it outside the assistant
- Why: an assistant's promise is the weakest control. The actions that must stay human (merge, release,
  post outward, write to shared trackers) need a mechanism that does not depend on the model remembering.
- How: branch protection, a human who flips a pull request to ready, tool deny-lists per job, read-only
  tokens for unattended runs, an after-run check that nothing outside allowed paths changed.
- Evidence: controls redesigned after a review found the assistant had been writing its own guard rails.

### Speak in your language; ship in the team's language
- Why: you think fastest in your own language, but anything a teammate may read must be in the shared one.
  The test is audience, not tool.
- How: say it once as a rule ("if anyone else may read it, it is in the shared language"), and add a check
  on the tools that write to shared surfaces.
- Evidence: first-language text reached a shared tracker twice before the check existed.

### Give every correction a reason, and ask the assistant to restate it
- Why: a rule without its reason gets misapplied at the edges; a restated rule catches misunderstanding
  before it costs a day.
- How: when you correct the assistant, say what went wrong and why it matters; ask it to restate the rule
  and confirm; have it write the rule and reason somewhere it re-reads.
- Evidence: rules restated and confirmed before adoption stopped drifting; rules applied from a guess did
  not.

## 2. Plan the work

### Plan from live evidence, not from memory or ticket text
- Why: the repository, the pull-request list and the test results move while the plan sits still. Plans
  written from yesterday's picture die on merged pull requests and stale premises.
- How: make the assistant read the live sources each time (open pull requests from all authors, last
  night's results, the policy text itself) and mark each planned item with the premise it rests on and
  where it checked it. Refuted premises are listed, not planned.
- Evidence: a ticket's stated fix had merged days earlier and the case still failed every repeat; the
  planner listed it as refuted instead of planning it.

### Put the measuring instrument first
- Why: when the test signal is invalid, every other decision is guesswork, and busy weeks let the signal
  rot unnoticed.
- How: the first line of every daily plan is "was last night's run valid?"; an invalid or missing run
  becomes the first task; a standing rule freezes new test surface on an app that keeps failing.
- Evidence: a nightly signal decayed for over a week while a one-line fix waited for a merge.

### One task per fresh session, one model each
- Why: long sessions drift and can run out of context or budget mid-task; a fresh session starts from the
  plan and the live state. Different tasks need different model strengths and costs.
- How: let the planner pick the model per task with a stated reason (deep triage and design to the
  strongest model, implementation with tests to a strong coder, mechanical work to a fast model), fix the
  time slots, and check remaining budget before each session starts.
- Evidence: adopted after several long sessions ended mid-task on a usage limit.

### Estimate in minutes and tokens, then measure
- Why: an estimate nobody checks never improves, and the question "can two small tasks share one session?"
  can only be answered with measured numbers.
- How: every planned task carries a minute estimate and a token estimate with the basis they rest on; the
  runner records the session's duration and token use; a script computes actual over estimate; the review
  explains each miss and writes a calibration note; the next plan states the ratio it applied.
- Evidence: adopted when the plan's estimates had no consumer at all.

### Keep one prevention item in every plan
- Why: fixing after the fact never catches up with discovery (far more defects were open than resolved at
  one snapshot). Something that moves detection earlier must be scheduled, not hoped for.
- How: the plan is invalid without at least one item tagged prevention (a contract check, a static rule,
  a test written before the code, a flaky test eliminated).
- Evidence: a planner predicate now refuses a plan without one.

## 3. Execute

### Isolate the assistant's work
- Why: an unattended session editing your working checkout collides with what you are doing.
- How: fresh worktree off the trunk per task, named so a human can find and review it; leave it in place
  until reviewed.
- Evidence: an integrity check tripped on the human's own edits while a run was in flight.

### Verify repeatedly and treat variance as a defect
- Why: a single green run proves little; a result that flips between runs is a bug in the test or the
  environment, and it will reach CI as noise.
- How: three consistent local runs before a pull request, five before a merge; record the runs.
- Evidence: flaky local results reached CI as noise until the repeat rule existed.

### When CI and local disagree, suspect the environment before the code
- Why: hours vanish into fix-on-fix when the real difference is OS, runtime version or network.
- How: run the cheapest falsifying experiment first (switch the environment variable, the runtime version,
  the OS) and compare a failing run with a passing one before naming a cause.
- Evidence: a runner hang that existed on one operating system only.

### A refused gate is information
- Why: a gate that can be routed around is a suggestion; the assistant's job when refused is to report,
  not to find another path.
- How: state it in the assistant's instructions and in the tooling ("record the denial and stop").
- Evidence: gates were mechanised after the same checklist was skipped three times.

## 4. Review and learn

### "Done" is a verified state
- Why: a report that says done without evidence shifts the checking onto you.
- How: define done as acceptance criteria met with linked evidence (pull-request URL and state, test
  counts, report lines); anything less is partial or blocked, said plainly.
- Evidence: repeated corrections over three months.

### Sweep all feedback, from everyone
- Why: filtering by a known reviewer's name misses the next reviewer; missed comments are the most common
  class of "done but not done".
- How: enumerate every comment, review and thread, subtract only your own, and account for each one.
- Evidence: a second review bot with a different login was missed by a name filter.

### Say why a check is red before asking anyone to act on it
- Why: a failed check from a vendor outage or a timed-out advisory job looks identical in the pull-request
  list to a real code failure, so the person who could merge waits for a fix that is not coming.
- How: in every pull-request status report, annotate each red check as code, vendor or CI-config with the
  evidence line, so the reader can decide whether to accept, rerun or wait.
- Evidence: several pull requests sat red for days on a vendor outage and an advisory-job timeout.

### Review the day, score it, and make tomorrow's plan say what it applied
- Why: lessons that are not fed back are just diary entries. The loop closes only when the next plan has
  to state which lesson it applied and the review later says whether it helped.
- How: an end-of-day review with a score and a rationale, lessons in cause / fix / prevention form, and a
  planner that must list the lessons it applied.
- Evidence: adopted with the daily loop.

### Make a scheduled review job check that the period it reviews actually happened
- Why: an automated score series is only useful if every point is a real working day. A review that fires
  out of band (a dry run, a weekend, a manual trigger) scores an empty day and pollutes the trend.
- How: before scoring, the job checks for execution records and compares the clock with the end of the
  last work slot; if the window has not elapsed it writes a labelled dry-run placeholder instead of a
  score, and the runner tags manual triggers so the trend generator can exclude them.
- Evidence: the first review of the loop ran minutes after the planner, on a weekend, with nothing to
  review.

### Ask for the artefact, not the message
- Why: a report that exists only in the chat is not delivered to anyone else.
- How: name the file or page that counts as delivered and have the assistant verify it exists before
  saying "ready".
- Evidence: a day's report was missing from the file the human actually used.

## 5. Do not fool yourself

### Ask what would make this pass for the wrong reason
- Why: an assistant satisfies the signal you gave it, so a signal that is easy to satisfy gets satisfied
  instead of the goal. Most false confidence comes from a check that cannot fail rather than from a lie.
- How: for each check that matters, name the state in which it would pass while the system is broken —
  nothing rendered yet, no data found, a fallback rescued it, the baseline was written by the check
  itself — and remove that state. Then break the subject once on purpose and watch the check go red.
- Evidence: a status field that reported only success or failure hid that every recent success had come
  from a last-resort path; a check reran green for weeks while measuring something other than its name.

### Count twice, with two methods, before believing a number
- Why: the measuring instrument is code with its own bugs, and a wrong number that looks plausible is
  worse than no number. Shells word-split differently, logs rank history rather than today, a wait that
  searches for a pattern matches itself, and a service started before your fix is not evidence about it.
- How: when a number decides something, get it a second way and reconcile the two. Cut every log window to
  the run under study. Wait on evidence the work produced, not on a pattern that includes your own command.
- Evidence: a counting command gave a confident wrong answer in one shell and the right one in another.

### Check the constraint is still real before building around it
- Why: constraints become folklore. "This needs a human" or "the platform cannot do that" is repeated for
  months after it stopped being true, and the workaround costs more than the retest would have.
- How: two cheap checks before any workaround. Search the repository for something that already does it,
  and rerun the experiment that established the constraint. Write next to the rule the date it was last
  verified.
- Evidence: a step believed to need a person turned out to have a documented switch, already used by an
  unused function sitting in the same repository.

## 6. For the assistant reading this

- Read the reasons, not just the rules. When a rule and its reason disagree in a new situation, the reason
  wins and the human is asked.
- Prefer a smaller verified result to a larger unverified one.
- Write your main output early and update it; treat every turn as possibly the last.
- End every unattended run with one line the human can act on: done / not done / blocked / needs decision.
- When the thing you were told to use is not there, say so and stop. The closest similar thing is never
  the answer; a substitution hides a real defect behind a passing run.
- Report which route produced the result: the intended path, a retry, a cache, a fallback. A bare "it
  worked" throws away the only part the human needed.
