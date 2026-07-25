# Agent Instructions

This repository owns dependency-update automation for the owner's repos. Keep it
small, observable, and boring: one shared Renovate preset, one self-hosted
runner workflow, and no product code.

`CHARTER.md` owns scope, consumers, distribution, and what counts as proof. Read
it before changing what this repo owns or how consumers reference it.

## Operating Rules

- Never commit secrets, tokens, or local machine state. The GitHub App secrets
  `RENOVATE_APP_CLIENT_ID` and `RENOVATE_APP_PRIVATE_KEY` live in the GitHub
  `renovate` environment, not in files.
- Keep `default.json` limited to policy that must stay identical across owner
  repos. Repo-specific `packageRules` stay in the consuming repo.
- Keep the workflow SHA-pinned with human-readable version comments.
- Keep runner permissions minimal and `actions/checkout` with
  `persist-credentials: false`.
- Treat `allowedCommands` as global code-execution authority across every
  repository targeted by the runner. Changes to the runner permission, an
  allowlisted repository script, or its `postUpgradeTasks` require owner
  review. Do not forward unrelated secrets or environment variables; split
  consumers onto separate runner configs if their maintainer trust differs.
- `.node-version` is the canonical exact Node pin. Keep `.nvmrc`, `mise.toml`,
  `package.json`, and CI synchronized; `node tools/check-toolchain.mjs` rejects
  drift without requiring any particular version manager.
- Git history is a declared input, not ambient state. This repo's jobs validate
  only checkout-local files, so the shallow default checkout is correct. Any
  future history-sensitive job (changesets, affected/changelog, merge-base)
  must declare and fetch the history it needs before relying on it.
- Validate Renovate config changes with the CI workflow before relying on them.
- Preset changes ship as releases. Consumers pin `#<version>`; an unpinned
  `github>jasondockery/renovate-config` follows the default branch and mutates
  every consumer's policy with no reviewable consumer diff.

## Bounded and observable runs

- Every job declares `timeout-minutes`. A scheduled run must terminate before
  the next cron invocation can overlap it, and `concurrency` with
  `cancel-in-progress: false` keeps runs from stacking.
- A workflow timeout is last-resort protection, not the operation's deadline.
  Distinguish a hard deadline (abort and fail) from a quiet period (report and
  diagnose, do not kill) from a missed performance target (report, still green).
- A failing run's summary names what to do next: the failing repository or
  package, the exact runner and Renovate versions, and the rerun command.
- A piped command's exit status is not proof the primary command succeeded —
  `cmd | tee` reports `tee`'s status. Use `set -euo pipefail` in workflow
  scripts, and capture the authoritative status explicitly when piping through
  `tee`, `tail`, or a filter.
- Fail-open (`|| true`) is for **non-authoritative reporting only**: appending
  to `$GITHUB_STEP_SUMMARY` and emitting annotations. Validation, artifact
  creation, receipt writing, and status capture fail closed. A swallowed error
  in an authoritative step is an invisible green.

## Proof honesty

State what a green run exercised: deterministic config validation, a controlled
dry run against fixtures or a canary, or a live scheduled run. A live run with
warm caches is not a cold-network proof; say which it was. See `CHARTER.md`.

## Git

The owner owns commits and pushes. When a commit is due, propose conventional
commit messages and let the owner choose.

Commit scope must match staged scope: read `git diff --cached --name-only`
immediately before committing and confirm the message covers every staged path.
This matters here because preset, workflow, and runtime-pin changes are easy to
combine accidentally, and they carry different blast radii.
