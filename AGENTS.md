# Agent Instructions

Read `AI_THESIS.md` before planning substantial work. It defines the project
outcome. `CHARTER.md` defines ownership, governance, and proof boundaries.
`specs/verification.md` defines how proof is selected, what it binds, and how
it is reported.

Shared engineering doctrine is projected from an immutable Compass artifact.
Read `.compass/COMPASS.md`, `.compass/TERMINOLOGY.md`,
`.compass/ai-workload-policy.json`, `.compass/authority-policy.json`, and
`.compass/authority-registry.json` for the canonical local copy. The projected
`.compass/consumer-reconciliation.schema.json` defines the consumer record;
`.compass/consumer-hosted-adoption-receipt.schema.json` defines the exact
hosted receipt, and `.compass/validate-json-schema.mjs` is the projected schema
validator. The canonical `.compass/check-authority-record.mjs` command derives
the authority bundle from the projection root and authenticates adopted-state
provider evidence; do not duplicate that identity or provider logic locally.
`tools/compass-consumer-reconciliation.json` is this repository's direct
consumer reconciliation record, not a projected Compass file. Keep a new
identity pending through the first exact-commit hosted gate, then make a
separate evidence-only transition to adopted and run `pnpm
compass:adoption:check`. The record becomes adoption evidence only after its
complete hosted proof is retrieved and cross-bound by the canonical Compass
validator. `pnpm check:compass` deliberately performs the canonical local
cross-binding without provider access; it may suppress only the canonical
missing-token disposition. Never use that offline check to claim hosted
adoption. Load
`skills/shift-to-authority/SKILL.md` for substantial engineering reviews,
field-failure reviews, cross-repository coordination, and release, projection,
or adoption handoffs. Load `skills/ai-backend-change/SKILL.md` for AI model,
backend, adapter, selection, fallback, or model-artifact changes. Load
`skills/developer-tool-change/SKILL.md` before adding, upgrading, replacing,
configuring, or removing developer tools. Load
`skills/verification-selection/SKILL.md` before proof selection,
`skills/dependency-change/SKILL.md` before dependency changes,
`skills/field-failure-backpressure/SKILL.md` for failures first observed outside
normal local proof, and `skills/performance-sensitive-change/SKILL.md` before
performance-sensitive work. These generated skills remain byte-bound to
`.compass/receipt.json`; renovate-config-specific extensions stay in this file,
`specs/`, and the local Renovate skills.
Load `skills/reviewable-agent-workspaces/SKILL.md` before selecting or changing
an implementation workspace, worktree writer, review surface, ownership
handoff, or proof-only temporary checkout. Load
`skills/concurrent-agent-runtimes/SKILL.md` before starting or diagnosing
processes, services, endpoints, containers, sockets, temporary state, or other
runtime resources shared with concurrent repositories and agents.
The complete receipt-bound shared-skill inventory is discoverable through both
`.agents/skills` and `.claude/skills`; those adapters resolve to the same
canonical `skills/` tree and are checked mechanically.

**Toolchain versions are write-once, derive-everywhere.** Node changes only in `.node-version`; pnpm changes only in `package.json#packageManager`. Load `skills/toolchain-authority/SKILL.md`, run `pnpm toolchain:sync`, then `pnpm check:toolchain`. A new version consumer requires an explicit classification and regression test.

Load `skills/live-renovate-acceptance/SKILL.md` before assessing a live runner,
explaining missing Renovate PRs, reconciling `pnpm outdated`, or claiming
consumer-level dependency automation proof.

This repository owns dependency-update automation for the owner's repos plus
the public, reusable implementation of one read-only security-hygiene inbox.
Keep it small, observable, and boring: one shared Renovate preset, one
self-hosted runner, one narrow hygiene monitor, and no product code.

## Execution authority

Complete an approved task through implementation, focused proof, commit, push,
workflow dispatch, and direct repair of failures that task caused. A recorded
approval stays valid through context compaction, tool reconnects, and routine
directly caused failures within the same active task. A separate session
continues only when the current prompt, a committed playbook, an issue, or
another durable owner-authored task record carries that authorization. The
agent owns commit wording, coherent commit boundaries, dependency-aware
ordering, focused-test selection, and push sequencing.

Pause only before merging or closing a pull request; creating a tag or release;
changing secrets, GitHub App permissions, or branch protection; destroying
unique work or data; or materially expanding approved policy or product scope.

Commit scope must match staged scope: read `git diff --cached --name-only`
immediately before committing and confirm the message covers every staged path.
This matters here because preset, workflow, and runtime-pin changes are easy to
combine accidentally, and they carry different blast radii.

Parallel writers use isolated branches or worktrees. Lane writers push their
assigned branches, never `main`. Exactly one owner-designated integration writer
may update `main`; that writer reconciles lane commits and owns the final
exact-SHA proof.

## Operating Rules

- Never commit secrets, tokens, or local machine state. Renovate's GitHub App
  Client ID variable and private-key secret live in this repo's `renovate`
  environment. Security-hygiene
  credentials, execution, summaries, artifacts, and durable issue live only
  in its private caller repository.
- `tools/github-external-config.json` is the authority for externally supplied
  Actions configuration. Every direct `secrets.*` or `vars.*` reference and
  every caller-delivered App setting must resolve to one structured delivery
  with its capability, consumer, sensitivity, and scope; required deliveries
  must remain used. Managed Renovate consumers such as Groundwork and Roost
  never duplicate the runner's App credentials; the dedicated private security
  caller is the explicit second delivery boundary. `secrets: inherit` is
  forbidden because every caller delivery must stay explicit.
- YAML anchors and aliases are forbidden in repository workflows. The external
  configuration authority requires source-local references that its
  dependency-free analyzer can inspect without alias resolution.
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
  scripts, and capture the authoritative status explicitly when piping.
- Fail-open (`|| true`) is for **non-authoritative reporting only**: appending
  to `$GITHUB_STEP_SUMMARY` and emitting annotations. Validation, artifact
  creation, receipt writing, and status capture fail closed. A swallowed error
  in an authoritative step is an invisible green.
- A guard that reports `ok` while observing nothing is worse than no guard.
  Every checker needs a negative test proving it fails when its invariant is
  violated, and must fail closed when its input is unreadable or empty.

## Proof honesty

State what a green run exercised: deterministic config validation, a controlled
dry run against fixtures or a canary, or a live scheduled run. A live run with
warm caches is not a cold-network proof; say which it was. Attribute a fact to
the lane that actually established it. See `CHARTER.md`.

## Verification

Finish the implementation and inspect the complete diff before expensive proof.
During implementation use the smallest focused check that answers the question.
Final proof picks exactly one path: an ordinary scoped change runs its affected
checks once; receipt code, workflow routing, runtime policy, release, or
another cross-cutting change runs only `pnpm verify` once. Never both.

Hooks are opt-in and are not installed by cloning: enable them once with
`git config core.hooksPath .githooks`. `.githooks/pre-commit` runs the
toolchain contract; `.githooks/pre-push` adds the test suite. Neither runs
`pnpm verify` — the final gate stays an explicit command, and a hook that ran
it would make every push pay for proof the release path runs again anyway.

Order the work as index, commit, proof, push: run the gate once, on the commit
you intend to push. Running it against the working tree and again against the
commit is duplicated proof, not stronger proof — the commit changes no bytes.
When the task is already "commit and push", go straight to the commit and prove
after it, and do not hand-run what a hook is about to run.

`specs/verification.md` owns what those commands bind, proof reuse, handoff
reporting, hook budgets, and cross-repository receipt mapping.
