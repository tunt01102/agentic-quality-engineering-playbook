# Core overlay for {{name}} (project-owned: the core created this once and never overwrites it)

These project rules win over the core. Keep this file short and point to the real rules instead of
copying them, so the two never drift.

## Where the project rules live

- `AGENTS.md` (and `CLAUDE.md` if present): read them first; they override every core default.

## Gates for `core-verify` (machine-readable copy in `.claude/team/project.json`)

{{gates}}

## Project-specific stage rules

- Spec or design documents: (state the project's convention, or "none").
- Deployment: (point to the runbook and its definition of done, or "not deployed by agents").
- Language of shared documents: (state it).
