#!/bin/bash
# publish-check.sh — run before every push of this repository to a public remote.
#
# This repository is written partly by an unattended end-of-day job. The job's writer refuses credential
# patterns, but it cannot judge whether a lesson mentions an internal hostname, a colleague, a ticket's
# text or a customer. This script is the deterministic gate for that: it scans every tracked and untracked
# text file and prints each line that matches a pattern that has no place in a public knowledge base.
#
#   bash tools/publish-check.sh            # exit 0 = clean, 1 = findings, 2 = usage
#   bash tools/publish-check.sh --staged   # only the files staged for the next commit (pre-commit use)
#
# Patterns are deliberately broad; a false positive costs a glance, a miss costs a disclosure.
# Add project-specific names (people, hosts, clients) to tools/publish-denylist.txt, one per line,
# case-insensitive. That file is itself scanned, so keep it to short tokens, never full names of clients.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE" || exit 2
MODE="${1:-all}"
case "$MODE" in all|--staged) ;; *) echo "usage: publish-check.sh [--staged]" >&2; exit 2 ;; esac
if [ "$MODE" = "--staged" ]; then FILES="$(git diff --cached --name-only --diff-filter=ACMR)"
else FILES="$( { git ls-files; git ls-files --others --exclude-standard; } | sort -u)"; fi
# the gate's own files hold the patterns and the local denylist; scanning them would only report themselves
FILES="$(printf '%s\n' "$FILES" | grep -Ev '^tools/publish-(denylist\.txt|check\.sh)$' | grep -E '\.(md|txt|json|csv|ya?ml|html|sh|mjs|js)$')"
[ -n "$FILES" ] || { echo "publish-check: no text files to scan"; exit 0; }

n=0
report() { # <label> <regex> [grep flags]
  local label="$1" re="$2" flags="${3:--nE}" hits
  hits="$(printf '%s\n' "$FILES" | xargs grep $flags -- "$re" 2>/dev/null || true)"
  [ -n "$hits" ] || return 0
  n=$((n + $(printf '%s\n' "$hits" | wc -l | tr -d ' ')))
  printf '\n[%s]\n%s\n' "$label" "$hits"
}

report "credential or key material" 'ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[bap]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{20,}|pk_[0-9]{5,}_[A-Z0-9]{20,}|eyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY|(api[_-]?key|secret|passw(or)?d|token)\s*[:=]\s*[^ ]{8,}'
report "email address" '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
report "URL other than the JSON schema site" 'https?://(?!json-schema\.org/)[^ )>"]+' "-noP"
# loopback (127.0.0.1) is not an address worth hiding; anything else, and any host:port, is
report "IP address or host:port" '\b(?!127\.0\.0\.1\b)([0-9]{1,3}\.){3}[0-9]{1,3}\b|\b(localhost|[a-z0-9-]+\.(local|internal|lan)):[0-9]{2,5}\b' "-noP"
report "absolute or home path" '/Users/[A-Za-z0-9_.-]+|/home/[A-Za-z0-9_.-]+|~/[A-Za-z0-9_./-]+'
report "tracker id or PR number" '\bCU-[0-9a-z]{6,}\b|\b86[a-z0-9]{7}\b|(PR|pull request|#)\s?[0-9]{3,5}\b'
# Private organisation, repository and account names belong in the local denylist.
report "test spec or fixture file name" '[A-Za-z0-9_-]+\.(e2e\.)?spec\.ts\b|autotest_[A-Za-z0-9_]+'
report "non-English text (audience rule: shared artefacts are English)" '[ĂÂĐÊÔƠƯăâđêôơưÀ-ỹ]'
if [ -f tools/publish-denylist.txt ]; then
  while IFS= read -r term; do
    [ -n "$term" ] && [ "${term#\#}" = "$term" ] || continue
    report "denylist: $term" "$term" "-niF"
  done < tools/publish-denylist.txt
fi

# allowlist: lines that are known-safe (the schema URL, the licence sentence) are subtracted from the count
printf '\n'
if [ "$n" -gt 0 ]; then
  echo "publish-check: $n line(s) to review above. Each is either a false positive you can justify or a line to rewrite before pushing."
  exit 1
fi
echo "publish-check: clean ($(printf '%s\n' "$FILES" | wc -l | tr -d ' ') files scanned)"
