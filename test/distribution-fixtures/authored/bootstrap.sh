#!/bin/sh
set -eu
: "${FIXTURE_HOME:?FIXTURE_HOME must name a disposable fixture directory}"
mkdir -p "$FIXTURE_HOME"
printf '%s\n' "${1:-1.0.0}" > "$FIXTURE_HOME/version"
printf 'installed:%s\n' "$(cat "$FIXTURE_HOME/version")"
