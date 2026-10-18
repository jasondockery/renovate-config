#!/usr/bin/env bash
# Linux CI bootstrap; workstation tooling remains owned by Groundwork/mise.
set -euo pipefail
case $# in
  0) ;;
  1)
    case $1 in
      --help | -h) echo "Usage: tools/enable-corepack.sh"; exit 0 ;;
      *) echo "Unexpected argument: $1" >&2; exit 64 ;;
    esac
    ;;
  *) echo "This command accepts no arguments." >&2; exit 64 ;;
esac
[[ $(uname -s) == Linux ]] || { echo "This bootstrap is for Linux CI." >&2; exit 1; }
command -v timeout >/dev/null || { echo "GNU timeout is required." >&2; exit 1; }
root=$(cd "$(dirname "$0")/.." && pwd -P)
cd "$root"
required=$(tr -d '[:space:]' <.node-version)
[[ $(node --version) == "v$required" ]] || { echo "Select the Node version in .node-version." >&2; exit 1; }
COREPACK_VERSION=0.36.0
timeout --kill-after=5s 180 npm install --global "corepack@$COREPACK_VERSION" --no-audit --no-fund
timeout --kill-after=5s 15 corepack enable pnpm
timeout --kill-after=5s 120 corepack install
# Corepack caches the wrapper; pnpm 12 downloads its verified native runtime
# on first invocation. Prepare it before the offline authority checker runs.
timeout --kill-after=5s 120 pnpm --version
node tools/check-toolchain.mjs
