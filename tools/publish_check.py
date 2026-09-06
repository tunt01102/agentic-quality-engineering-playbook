#!/usr/bin/env python3
"""Review publishable paths and text without echoing sensitive matches.

Exit codes: 0 clean, 1 findings, 2 incomplete scan or invalid usage.
Private names belong only in the ignored local denylist, never in this source.
"""

import argparse
from pathlib import Path
import re
import subprocess
import sys


DENYLIST = "tools/publish-denylist.txt"
PATTERNS = [
    ("credential or key material", re.compile(
        r"ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|"
        r"glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|"
        r"(?:AKIA|ASIA)[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{20,}|"
        r"pk_[0-9]{5,}_[A-Z\d]{20,}|"
        r"eyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{20,}|"
        r"-----BEGIN [A-Z ]*PRIVATE KEY|"
        r"\b(?:api[_-]?key|secret|passw(?:or)?d|token)"
        r"[\"']?\s*[:=]\s*[\"']?[^\s\"',;]{8,}", re.I
    )),
    ("email address", re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")),
    ("external URL", re.compile(r"https?://(?!json-schema\.org/)[^\s)>\"']+")),
    ("IP address or internal host", re.compile(
        r"\b(?!127\.0\.0\.1\b)(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b|"
        r"\b[a-z0-9-]+\.(?:local|internal|lan)\b|\blocalhost:[0-9]{2,5}\b", re.I
    )),
    ("absolute or home path", re.compile(
        r"/(?:Users|home|private|Volumes|mnt|opt|srv|var)/[A-Za-z0-9_.-]+|"
        r"~/[A-Za-z0-9_./-]+|[A-Za-z]:\\[A-Za-z0-9_ .\\-]+"
    )),
    ("tracker or pull request identifier", re.compile(
        r"\b[A-Z][A-Z\d]{1,9}-[0-9]+\b|\bCU-[0-9a-z]{6,}\b|"
        r"\b86[a-z0-9]{7}\b|(?:PR|pull request|#)\s?[0-9]{3,5}\b"
    )),
    ("account or SSH remote", re.compile(
        r"(?<![A-Za-z0-9_])@[A-Za-z0-9][A-Za-z0-9_-]{2,}|"
        r"git@[A-Za-z0-9.-]+:[^\s]+"
    )),
    ("project test or fixture name", re.compile(
        r"[A-Za-z0-9_-]+\.(?:e2e\.)?spec\.ts\b|autotest_[A-Za-z0-9_]+"
    )),
    ("non-English text (shared-language review)", re.compile(
        r"[\u0102\u0103\u0110\u0111\u01a0\u01a1\u01af\u01b0\u1ea0-\u1ef9]"
    )),
]


def git(root, *args):
    return subprocess.run(
        ["git", "-C", str(root), *args], check=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    ).stdout


def findings(text, terms):
    labels = [label for label, pattern in PATTERNS if pattern.search(text)]
    if any(term in text.casefold() for term in terms):
        labels.append("private denylist term")
    return labels


def scan(root, staged):
    tracked = set(git(root, "ls-files", "-z").decode().split("\0")) - {""}
    if DENYLIST in tracked:
        print("publish-check: local denylist must never be tracked", file=sys.stderr)
        return 1
    local = root / DENYLIST
    if local.is_symlink():
        raise ValueError("local denylist must be a regular file")
    terms = []
    if local.exists():
        terms = [line.strip().casefold() for line in local.read_text(encoding="utf-8").splitlines()
                 if line.strip() and not line.lstrip().startswith("#")]
    if not terms:
        print("publish-check: no local denylist; private names require manual review")

    # Staged mode reads the complete index, including unchanged files, not worktree copies.
    if staged:
        files = tracked
    else:
        files = tracked | (set(git(root, "ls-files", "--others", "--exclude-standard", "-z")
                               .decode().split("\0")) - {""})
    files.discard(DENYLIST)
    if not files:
        raise ValueError("no publishable files to scan")
    count = 0
    for name in sorted(files):
        path_labels = findings(name, terms)
        # Never echo a sensitive filename or any matched source text into logs.
        display = "[redacted path]" if path_labels else ascii(name)
        if path_labels:
            print(f"{display}: path: {', '.join(path_labels)}")
            count += 1
        if staged:
            entry = git(root, "ls-files", "--stage", "-z", "--", name).split(b"\0")[0]
            mode = entry.split(b" ", 1)[0]
            if mode not in (b"100644", b"100755"):
                print(f"{display}: unsupported Git entry; review required")
                count += 1
                continue
            raw = git(root, "show", f":{name}")
        else:
            path = root / name
            if path.is_symlink() or not path.is_file():
                print(f"{display}: missing file or non-regular entry; review required")
                count += 1
                continue
            raw = path.read_bytes()
        try:
            content = raw.decode("utf-8")
            if "\0" in content:
                raise ValueError("binary content")
        except (UnicodeDecodeError, ValueError):
            print(f"{display}: non-text content; review required")
            count += 1
            continue
        for number, line in enumerate(content.splitlines(), 1):
            labels = findings(line, terms)
            if labels:
                print(f"{display}:{number}: {', '.join(labels)}")
                count += 1
    print(f"publish-check: {count} finding(s), {len(files)} files scanned"
          + (" from index" if staged else " from working tree"))
    return 1 if count else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--staged", action="store_true", help="scan the full staged snapshot")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    try:
        return scan(root, args.staged)
    except (OSError, UnicodeError, ValueError, subprocess.CalledProcessError):
        # Exception text can contain credentials, private paths or local Git configuration.
        print("publish-check: scan incomplete; check Git state and file readability", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
