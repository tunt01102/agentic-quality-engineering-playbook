#!/bin/bash
# Portable entry point; Python's standard library avoids platform-specific grep options.
set -eu
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec python3 "$HERE/tools/publish_check.py" "$@"
