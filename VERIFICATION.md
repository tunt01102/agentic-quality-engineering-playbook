# When green is not green

A companion to [LESSONS.md](LESSONS.md), about one failure family only: results that say success and
mean nothing. It is the family an AI assistant produces most, because an assistant optimises whatever
signal you gave it, and a signal that is easy to satisfy will be satisfied.

Everything below is a class observed repeatedly on real work, written so it transfers. The numbers are
measured, the systems they were measured on are not named.

## 1. A pass must name the mechanism that produced it

An automated check that has fallback layers will eventually pass through a fallback, and the result field
says only `passed`. Measured on one suite: every run that used the last-resort layer was, on inspection,
either failing or half-finished; every genuinely good run had never touched it. The status column had been
green for weeks and carried no information.

The fix is one extra recorded field, not a better fallback: **which path produced this result**. Then a
pass by the intended path and a pass by a rescue layer stop looking alike, and you can gate on the
difference. Same rule for retries, for caches, for "degraded mode": if a run can succeed by more than one
route, the route is part of the result.

## 2. The success state must be distinguishable from the not-yet-started state

A wait condition of the form "continue when the error banner is absent" is satisfied instantly by a page
that has not rendered anything at all. A script that exits zero on success and zero on "no data" is the
same bug with a different face, and so is a report that is empty because nothing was found and empty
because nothing ran.

Write predicates positively. Assert on the presence of what should exist, and where you must assert an
absence, first assert that the surrounding thing exists. When a check can pass on an empty world, it will,
on the day the world is empty for a bad reason.

## 3. Repetition proves stability, not correctness

"I ran it five times and it was green every time" answers a different question from "is it testing
anything". One check passed on every rerun for weeks; removing an unrelated wait step from it changed its
own output by a margin that should have been impossible, which is how it emerged that the check had been
passing for a reason unrelated to the thing it named.

The cheap counter-check is deliberate sabotage: break the subject on purpose once and confirm the check
goes red. A check that stays green when you break what it watches is not a check. Do this once per
non-trivial check, at the moment it is written, and record that you did.

## 4. A reference the check writes itself can never fail

Any comparison against a stored baseline — golden files, snapshots, recorded fixtures — must not create
that baseline as a side effect of a failing comparison. If a missing baseline is silently written on
first run, the first run is definitionally green and so is every run after a change that quietly rewrote
it. Creating a baseline is a separate, reviewed act with a human's name on it.

## 5. The gate you built is not the outcome you want

A quality gate was raised from ninety to one hundred percent over several rounds of work. End-to-end
success across the same period stayed at zero. The gate was not lying; the constraint had moved somewhere
the gate did not look, and every further point of gate score bought nothing.

Report the end outcome next to the proxy, always, in the same line. When the proxy is at its ceiling and
the outcome has not moved, that is not a reason to polish the proxy. It is a finding: **locate the new
constraint before doing another round of the old work.**

## 6. Measure the marginal return of the last round before buying another

Two consecutive rounds of enriching an input corpus added several hundred entries each. The first cut the
downstream failures by nine; the second, by four. The work felt productive both times and the second round
was, in hindsight, an expensive way to learn nothing.

Before repeating any enrichment, cleanup or coverage push, state what the previous round cost, what it
returned, and what you expect this one to return. If you cannot state the last one's return, you are not
ready to spend the next one.

## 7. Do not fool yourself with the measuring instrument itself

The instrument is code too, and it fails quietly.

- **Shells differ.** An unquoted variable holding several patterns splits into words in one shell and not
  in another; the same counting command gives a plausible, wrong number in the other person's terminal.
  Quote, and check a count you like against a second method before believing it.
- **Rank inside the right window.** Sorting the most frequent errors over an entire log ranks history, not
  today's run. Cut the window to the run under study first; the top error over all time is usually a
  problem that was fixed months ago.
- **A pattern-based wait can match itself.** Waiting for a process by searching the process table for a
  string will match the waiting command, which contains that string, and return immediately and forever.
  Wait on evidence the work itself produced: a line in its output, a file it wrote, an exit status.
- **A long-running process holds the old code.** Before concluding that a change did not work, compare the
  running process's start time with the time the change landed. A service started before the fix is not
  evidence about the fix.
- **A tidy-up step can eat the error.** Cleanup that deletes empty result directories will delete the
  directory of a run that failed before it produced anything, and the failure disappears with it. Cleanup
  runs after the outcome is recorded, never before, and never on a path that has not been classified.

## 8. A finding must be allowed to survive

The most valuable output an assistant produces is "the thing you named does not exist here". It is also
the one most easily destroyed, because a near-match is always available and always makes the run green.

The rule is absolute and worth stating in the assistant's own instructions: **when the named thing is
missing, stop, mark the step skipped with the reason, and report it.** Substituting the closest similar
thing converts a real defect in the product, or a real error in the specification, into a passing run
nobody will look at again. After every fallback layer has been tried, "not found" is a correct and useful
answer, not a failure to be engineered away. Do not widen a gate to get past it.

## 9. Look at the system before writing code against its description

An assistant asked to write code from a written specification alone will write confident, fluent code
against names that do not exist. Measured once: the snapshot the generator was given had been captured too
early in the page's life and contained three elements where the finished screen had sixty-seven. Every
name in the generated code was invented, and it was all plausible.

Two things follow. Capture the state of the real system first, at the moment it is actually complete, and
give the generator that as ground truth. And when the specification and the system disagree, the
disagreement is the deliverable: it is either a stale specification or a changed product, and both are
worth more than the code that would have papered over it.

## 10. Improving a source does nothing while consumers read a frozen copy

If ground truth is embedded into the artefacts consumers read, then improving the source only helps after
a refresh step runs. That step is exactly the sort of thing a person marks optional. Observed: every
consumer ran for days against a copy from the day before, so a corrected source reached nobody, and the
correction looked like it had failed.

Either the consumers read the source live, or the refresh is part of the same command that changes the
source. A refresh step that a human must remember is a fix that will not arrive.
