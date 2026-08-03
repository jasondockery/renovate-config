# Agent Instructions

Read `AI_THESIS.md` before planning substantial work. It defines the project
outcome. `CHARTER.md` defines ownership, governance, and proof boundaries.

This repository owns dependency-update automation for the owner's repos plus
the public, reusable implementation of one read-only security-hygiene inbox.
Keep it small, observable, and boring: one shared Renovate preset, one
self-hosted runner, one narrow hygiene monitor, and no product code.

## Operating Rules

- Never commit secrets, tokens, or local machine state. Renovate's GitHub App
  secrets live in this repo's `renovate` environment. Security-hygiene
  credentials, execution, summaries, artifacts, and durable issue live only
  in its private caller repository.
- Never add `workflow_dispatch` or `schedule` to the public hygiene workflow.
  It is reusable implementation only, and its first step must fail closed
  unless the caller repository is private.
- Keep `default.json` limited to policy that must stay identical across owner
  repos. Repo-specific `packageRules` stay in the consuming repo.
- Keep the workflow SHA-pinned with human-readable version comments.
- Keep runner permissions minimal and `actions/checkout` with
  `persist-credentials: false`.
- Keep GitHub App scopes canonical in `tools/security-policy.mjs`; tests bind
  each workflow token and the README grant table to that policy.
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

## Verification economics

- An explicit owner instruction to pause before verification overrides the
  normal ladder. While the hold is active, inspect source and diffs but do not
  run tests, linters, formatters, hooks, validators, builds, or proof commands.
  Before asking to resume, present the exact proposed commands, estimated
  durations, overlap or duplication, whether each is diagnostic or final proof,
  and the tree identity it will prove.
- Finish the accepted implementation and inspect the complete diff before
  starting expensive proof. During implementation, use the smallest focused
  check needed to answer the immediate question. Final proof chooses one path:
  an ordinary scoped change runs its affected checks once, while receipt code,
  workflow routing, runtime policy, release, or another cross-cutting change
  runs only `pnpm verify` once. That repository-owned command fingerprints the
  exact Git HEAD, index, and Git-visible working tree plus the bounded,
  explicitly named ignored verification outputs that can affect this proof,
  runs complementary
  `pnpm test` and `pnpm validate` lanes concurrently with separate output and
  statuses, rejects dependency artifacts, checks the final fingerprint, and
  prints one wall-time/critical-path receipt. The implementation tree need not
  be clean; it must be unchanged by proof. Arbitrary ignored caches, worktrees,
  and `.env*` files are outside this identity contract and are never read.
  An event-loop-independent parent watchdog puts the complete transaction,
  including both synchronous fingerprints, under a 300-second hard deadline.
  It cancels both persistent process-group supervisors with bounded TERM/KILL
  cleanup; each supervisor stays alive until command status and descendant
  closure are resolved. For a machine-readable local handoff, add
  `--report /absolute/path/outside/the/repository.json`; that JSON remains
  non-reusable evidence for the exact observed local tree.
  Do not run either constituent command immediately before it as duplicate
  final proof.
  When full proof finds one defect, fix it, use the focused check to diagnose,
  then rerun full proof once on the unchanged final tree.
  For an owner-authorized publish, reconcile the complete index and create the
  intended local commit before final proof. Run `pnpm verify` on that exact
  clean commit, then make no source, index, or history change before push. A
  modified-tree receipt can support diagnosis or handoff, but it cannot prove a
  commit created afterward.
- The current `pnpm verify` receipt binds the observed local tree before and
  after the run but is deliberately marked not reusable: there is no persisted
  hook adapter binding every configuration, toolchain, suite-version, and
  platform input yet. Exact-SHA CI proof is reusable only for that exact SHA;
  any missing identity makes a prior receipt context only.
- At handoff name the affected surfaces and commands, why the selected proof
  covers them, and any repository-wide contract that scoped proof did not
  exercise. Report best-effort implementation time, measured verification and
  hook time, every command and duration, the slowest check, reruns, duplicate
  proof time, invalidated verification time, and whether the final tree is what
  passed. When implementation was continuous enough to make the comparison
  meaningful, include the verification-to-implementation ratio.
  Flag a command over 5 minutes, hook over 1 minute, or final sequence over 10
  minutes as advisory waste to fix, never as a reason to weaken a gate.
  The `pnpm verify` target is 4 minutes. Treat the first five representative
  final-tree runs as advisory baseline evidence; a later regression creates a
  productivity warning and backlog item, not permission to remove proof.
- Hooks, if added, stay staged-only under 10 seconds for pre-commit and
  affected-only under 2 minutes for pre-push. Full validation, Docker, and live
  provider/network proof remain explicit commands or CI work.
- Cross-repository compatibility is a mapping, not shared code in this repo:
  outcome; exact SHA or content-addressed tree; command and proof type; duration
  and slowest phases; cache state; and invalidation state. This repo's narrow
  `renovate-config.run-receipt` maps those fields locally. Groundwork owns the
  experimental typed contract, and Roost keeps its richer `CiReport` until a
  neutral utility has been field-proven and deliberately extracted.

## Git

The owner owns commits and pushes. When a commit is due, propose conventional
commit messages and let the owner choose.

Commit scope must match staged scope: read `git diff --cached --name-only`
immediately before committing and confirm the message covers every staged path.
This matters here because preset, workflow, and runtime-pin changes are easy to
combine accidentally, and they carry different blast radii.
