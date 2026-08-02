#!/bin/bash
set -euo pipefail

readonly expected_directory=/renovate-log
readonly expected_log="$expected_directory/renovate.jsonl"
readonly preflight_record='{"level":30,"msg":"Renovate log mount preflight passed"}'

if [[ "${LOG_FILE:-}" != "$expected_log" ]]; then
  echo 'Renovate log preflight: LOG_FILE does not name the fixed private mount' >&2
  exit 64
fi
if [[ ! -d "$expected_directory" || -L "$expected_directory" ]]; then
  echo 'Renovate log preflight: fixed private mount is not a real directory' >&2
  exit 1
fi
if [[ -e "$expected_log" || -L "$expected_log" ]]; then
  echo 'Renovate log preflight: structured log path already exists' >&2
  exit 1
fi

umask 022
probe="$(mktemp "$expected_directory/.preflight.XXXXXX")"
rm -f -- "$probe"
(set -o noclobber; printf '%s\n' "$preflight_record" > "$expected_log")

exec renovate "$@"
