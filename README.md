# Working with an AI coding assistant as a daily engineering partner

## Purpose

The purpose of this repository is to improve the quality of engineers' work with AI assistants, through
lessons distilled and studied from real-world projects. Every rule, lesson and tip here came out of daily
practice on production software, was tested against real mistakes, and is written down with its reason so
that other engineers and their assistants can apply it from day one.

A plain-text knowledge base, written so that both people and AI assistants can read it without tooling.
It describes a working method: one engineer and one AI assistant running a daily plan / execute / review
loop on a real software product, and the rules, lessons and tips that came out of three months of doing it.

Everything here is general. There is no company, product, customer or ticket in these files; the method
is written so that any team, on any project, with any capable assistant, can pick it up.

## Read in this order

| File | What it answers | Audience |
|---|---|---|
| [WORKFLOW.md](WORKFLOW.md) | The daily loop: plan from live evidence, run each task in a fresh session, review the day, feed the lessons into the next plan | people and AIs |
| [PRINCIPLES.md](PRINCIPLES.md) | The working rules that survived three months of corrections, each with the reason it exists | AIs first |
| [LESSONS.md](LESSONS.md) | The recurring failure classes, in what happened / cause / fix / prevention form | both |
| [VERIFICATION.md](VERIFICATION.md) | Why a green result can mean nothing, and the checks that make it mean something: fallbacks that rubber-stamp, predicates satisfied by an empty world, self-written baselines, proxies at their ceiling | both |
| [TIPS.md](TIPS.md) | Reusable tips for working effectively with an AI assistant, each with a why and a how | anyone, any project |
| [templates/](templates/) | The lesson format and the JSON schemas of the day plan and the end-of-day review, for reuse | AIs and tool builders |
| [llms.txt](llms.txt) | A short machine-oriented index of this repository | AIs |

## How this repository is maintained

- The hand-written files (`WORKFLOW.md`, `PRINCIPLES.md`, `LESSONS.md`) are updated by a person, or by the
  assistant in an interactive session with the person watching.
- `TIPS.md` is appended by an unattended end-of-day review in the author's own setup, through a
  path-restricted writer that can touch nothing else here. Existing tips are never deleted, only refined.
- The project-specific twin of this repository (the daily lesson files, the score series, the real
  incidents with their numbers) lives in a private repository and is not published.

## Before publishing or pushing

Part of this repository is written by an unattended job, so a human check happens at push time. Run
`bash tools/publish-check.sh` first: it lists every line that looks like a credential, an address, a path,
a tracker or PR identifier, a repository or account name, a test file name, non-English text, or any term in
the local, untracked `tools/publish-denylist.txt` (your company, products, tools, people, places). A clean
run is the condition for a push; a finding is either rewritten or justified in the commit message.

## Why publish a working method rather than a tool

The tooling behind this method is small shell and Node scripts specific to one machine. What transfers is
the method: plan from live evidence, run work in short fresh sessions with a model chosen for the task,
verify with predicates rather than trust, estimate and measure, review the day honestly, and turn every miss
into a prevention rule that the next plan must state it has applied. The files above are that method
written down with its reasons.

## Licence

This repository is released under the [MIT License](LICENSE). You may use, copy, modify and redistribute
its contents, provided the copyright notice and licence text are kept with any copy.
