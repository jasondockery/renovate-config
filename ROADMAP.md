# Roadmap

Follow-ups for this repository. `CHARTER.md` owns scope and distribution;
`AGENTS.md` owns operating behavior. Check a box only after the work is
verified, never aspirationally.

## Versioned distribution

> **Freeze remains in effect until every consumer is pinned.** Until then all three
> consumers still resolve this repository's default branch, so a merge that
> changes `default.json` behavior changes their dependency policy immediately
> and silently. The owner authorized exact exceptions for the reviewed strict
> five-day npm override and vulnerability-alert bypass (2026-08-04), daily
> mature-update creation (2026-08-09), and immediate security PRs with required
> human merge review (2026-08-13). The updated checksum binds that policy. No
> further effective preset change is authorized during the bootstrap sequence
> below.
>
> The executable reviewed fixture demonstrates why the exception was necessary:
> `config:best-practices` contributes a later three-day npm rule, so the frozen
> preset did not establish its claimed effective five-day npm behavior. The
> activated exception and rollback are recorded in
> `specs/preset-freeze-exception.md`; `pnpm renovate:policy` proves the exact
> accepted policy against the pinned runtime.

Bootstrap sequence, in this order:

- [x] 1. Merge only the charter, roadmap, guardrail, timeout, and validation
      changes. `default.json` stays untouched. Verified 2026-07-29:
      `git log b466499..HEAD -- default.json` returns nothing, so no commit
      since the freeze was declared has altered the resolved preset. Steps 2
      onward are owner actions and remain open — the freeze stays in effect.
- [x] 2. Adopt immutable GitHub Releases plus an active tag ruleset that blocks
      updates and deletions as defense in depth.
- [x] 2a. Implement and verify the checked-in desired state, read-only check,
      explicit owner apply command, preflight, hostile tests, and
      post-publication verifier. No release tag is created by this work.
- [ ] 2b. Owner action: review and apply `tools/release-controls.json`. Current
      live state observed 2026-08-09 has immutable releases disabled and no
      matching tag ruleset, so this gate remains open.
- [ ] 2c. Record a passing `pnpm release:controls:check` live read-back receipt.
- [ ] 3. Publish the verified commit as the first immutable GitHub Release,
      **`1.0.0`** — no `v` prefix. Renovate's
      `#suffix` resolves a Git tag by exact name, so a `v1.0.0` tag must not be
      assumed to resolve as `#1.0.0`. One convention in both places. Owner
      action: prepare a draft, pass `pnpm release:preflight`, then publish it.
- [ ] 4. Confirm the *released reference* resolves end to end, not just that the
      source file is valid: tag exists → `github>jasondockery/renovate-config#1.0.0`
      resolves → Renovate validates the resolved preset → a consumer config
      extending it passes. This catches tag naming, file naming, permissions,
      and repository-resolution problems before three consumers change. Run
      `pnpm release:verify --version 1.0.0 --expected-sha <40-char-sha>`.
- [ ] 5. Have the owner open the initial pin PR for this repository, then let a
      validation/discovery run confirm it.
- [ ] 6. Have the owner open Groundwork's initial pin PR.
- [ ] 7. Have the owner open Roost's initial pin PR.
- [ ] 8. Confirm Renovate proposes a later tagged preset bump in a consumer, and
      record that PR as the receipt that distribution actually works. Renovate
      proposes preset-version updates only once the reference is already pinned.
- [ ] 9. Lift the freeze and note it here.
- [ ] 10. Only after all consumers are pinned to the accepted human-merge
      `default#1.0.0` baseline, merge the separately reviewed standalone
      `low-risk-automerge` preset and publish the additive repository release
      `1.1.0`. Keep every consumer `human-merge` until its exact protection,
      required-check, pristine-branch, live-canary, and rollback evidence is
      independently accepted.
- [x] Document the release procedure in `CONTRIBUTING.md`, pointing at the
      charter's patch/minor/major contract rather than restating it.

## Proof levels

- [ ] Complete the active cross-repository acceptance playbook in
      `playbooks/x-renovate-system-acceptance.md`: accept the daily runner,
      daily routine PR creation after the effective five-day floor on supported
      surfaces, offline structural checks, network-backed pinned-
      Renovate extraction,
      owner-gated private canary, and one green eligible PR in each consumer.
      The canonical matrix is `specs/renovate-system-acceptance.md`; a green
      runner receipt alone is level 3, not end-to-end readiness.
- [ ] Owner gate: provision the private canary and extend the GitHub App and
      explicit acceptance-dispatch target set only after reviewing the bounded
      canary contract. Normal daily production runs continue to target exactly
      the three current repositories.

- [x] Emit one schema-versioned, sanitized timing receipt from CI, scheduled
      Renovate, and security hygiene, render the same receipt into the job
      summary, and retain the JSON for 30 days. Renovate's raw debug JSON stays
      on the shared temporary volume only long enough to derive allowlisted
      per-repository duration and warning/error counts. Implemented locally;
      live acceptance remains below.
- [ ] Accept the first exact-SHA live receipts after this telemetry lands:
      confirm CI phase timings, all three Renovate repository timing rows, raw
      log deletion, the private security-hygiene receipt, and honest advisory
      budget states. Record this as runner-execution proof only; do not call the
      dependency system field-proven until behavior and consumer-compatibility
      rows in the acceptance spec are also green.
- [ ] Field-prove the repository-owned concurrent final command and parallel CI
      layout. `pnpm verify` fingerprints its declared Git-visible identity and
      named ignored verification outputs, runs `pnpm test` and
      `pnpm validate` concurrently, preserves lane output/status/timing, runs a
      baseline-aware read-only proof under a 300-second hard deadline, and emits
      one receipt; CI keeps its stricter clean-checkout proof and runs tests,
      validation, and workflow security as parallel visible jobs behind stable
      `ci-gate`.
      Accept five representative final-tree runs at a 4-minute advisory target
      before treating later regressions as productivity warnings.
- [ ] After `ci-gate` reports green on `main`, update branch protection to
      require that single stable aggregate context instead of the retired
      monolithic `validate` job name. Keep tests, validation, and workflow
      security visible for diagnosis. This is an owner-side GitHub setting.
- [ ] Repair and accept the live Renovate token boundary with two field proofs.
      Run `30716572152` is the baseline observation of the stale GitHub App
      installation permission state as HTTP 422; it predates this receipt code
      and is not an acceptance receipt. After the implementation lands, first
      dispatch its exact SHA against the still-stale installation and retain the
      new failed receipt. Then, only after owner approval, update the App and
      installation to grant the exact canonical `RENOVATE_APP_PERMISSIONS`
      union and accept one green rerun of that same SHA. Record both new run IDs
      and the shared implementation SHA. Do not remove required token scopes
      merely to bypass HTTP 422.
- [ ] After Groundwork's exact-tree receipt contract is field-proven, migrate
      this repository-specific `renovate-config.run-receipt` compatibility
      serializer to the neutral public shared
      utility. This repository must remain dependency-automation policy, not
      become the cross-repository tooling package; keep the local implementation
      until compatibility and migration are specified.
- [ ] Participate in the neutral multi-repository orchestrator after one
      final-tree Groundwork receipt and one concurrency stress proof establish
      the real-time fixture isolation. The
      utility lives outside renovate-config and merely invokes `pnpm verify`
      alongside each sibling's canonical command, keeps logs/statuses separate,
      cancels child process groups, and reports critical-path wall time apart
      from aggregate compute. Its first five representative runs are advisory
      baseline evidence. This repository never owns the shared utility.
- [ ] Adopt exact-identity proof reuse only after the shared contract includes
      repository, content-addressed tree, command arguments, relevant config,
      toolchain/lock state, suite version, and platform. Any future pre-commit
      path stays staged-only under 10 seconds and pre-push affected-only under 2
      minutes; live Renovate and network proof never move into hooks.
- [ ] Accept the pinned-runtime integration proof for resolved preset behavior:
      supported normal releases at four days, 23 hours, 59 minutes remain
      pending, releases at five days and one minute advance, vulnerability
      alerts bypass the normal gates, and
      lockfile maintenance remains a separately governed update type. This is
      network/cache-backed integration evidence, never deterministic static
      proof. **Implemented locally; pending review and the preset exception.**
- [ ] Land the manual-only latest-head compatibility tooling after the consumer
      inventories, then activate its daily schedule in a separate commit only
      after the Roost and Groundwork schema-v2 inventories are on their default
      branches. Keep it outside required renovate-config CI, record all three
      exact tested SHAs and before/after identities, and treat the result as
      current-head drift evidence rather than reusable proof for future heads.
- [ ] Stand up the owner-gated private npm canary described in the acceptance
      spec. It proves matching, weekly scheduling, manifest/lockfile mutation,
      green CI, and stale-PR recreation for npm only. Dockerfile, Actions,
      runtime-pin, custom-manager, digest, and manual surfaces retain separate
      extraction and real-consumer evidence.
- [ ] Record in each live run's summary whether the store/cache was warm, so a
      live receipt is not mistaken for a cold-network proof.

## Security-hygiene launch

The public workflow stays reusable-only. A private security-operations caller
stays manual-only until these owner gates are complete. Follow
`docs/runbooks/security-hygiene.md`; do not weaken an SLA or expected-source
policy to obtain green.

- [ ] Create a private security-operations repository to own hygiene secrets,
      runs, summaries, artifacts, and the durable issue.
- [ ] Add its manual caller workflow, pin `uses:` to an exact 40-character
      renovate-config commit SHA, pass the same SHA as `implementation_ref`,
      and configure the App credentials as private repository or organization
      secrets.
- [ ] Approve the GitHub App permission union in the README, including
      Administration read, Checks read/write, Code scanning alerts read, and
      Secret scanning alerts read. Members read remains intentionally absent
      unless team assignment/member lookup becomes a supported behavior.
- [ ] Enable secret-scanning validity checks where supported, or record the
      deliberate unavailable posture for each repository.
- [ ] Triage every current alert, assign an owner, resolve the critical path,
      and record evidence where Renovate cannot express an automatic fix.
- [ ] Manually dispatch Renovate with the final scoped App token and confirm all
      three repositories are reached plus security PRs appear where fixes are
      expressible.
- [ ] Dispatch security hygiene twice from the private caller at the exact
      merged implementation commit and record issue reuse, label convergence,
      live disabled-state classification, token-mint degradation, and
      independent issue/artifact delivery.
- [ ] Add the daily `17 5 * * *` schedule to the private caller only after the
      two dispatch receipts are accepted.

## Verification harness reliability

- [ ] Close out the `tools/verify.test.mjs` process-group flake. Repairs so far,
      in order: 5-second fixture bounds, a ready marker that must be complete
      and numeric before its pid is read (an `existsSync` race could otherwise
      derive process group `0`), and a `ps` probe that retries a transient
      snapshot failure instead of asserting on it. That last one was the
      wrong-reason failure: the probe asserted `snapshot.error === undefined`,
      so a slow `ps` under load reported "the supervisor leaked a process"
      when the truth was "the machine was busy". The failure message now
      distinguishes an observed surviving group from unproven cleanup.
      Status: not reproduced since — 4 runs at load average 45, 6 concurrent
      runs, and a clean 10-run batch — but it is not proven eliminated, and
      absence of a reproduction is not a fix. Two open items remain: a
      confirmed root cause, and the one production observation worth checking
      first, that `runCommandLane`'s termination path polls a blocking
      `spawnSync('ps')` on a 25 ms interval, which can back up and block the
      event loop on a loaded machine. Retries are not the fix — a random green
      rerun is evidence about the commit, never evidence that the verification
      harness is deterministic.
- [ ] Field-observed 2026-08-04: one `pnpm verify` run failed with the tests
      lane timing out at 306s while the same tree passed at 3.7s minutes later,
      identical fingerprint `sha256:e6dd083c…`, on a machine at load average 45
      with concurrent agents. Bound the cause before treating the 300-second
      hard deadline as correctly calibrated for a 4-second suite.

## Security and verification backlog

- [ ] Enable CodeQL default setup for this public JavaScript repository and
      record its first successful scan. Keep Zizmor: it covers workflow risks,
      while CodeQL covers the Node tools that parse untrusted API data.
- [ ] Evaluate a pinned actionlint gate, including the ShellCheck checks needed
      for masked command-substitution failures. Keep it complementary to
      Zizmor, not a replacement.
- [ ] Migrate the pinned Renovate runtime to v44 in a separate pull request.
      Accept real v44 structured-log fixtures and preserve fail-closed receipt
      parsing; do not combine the runtime migration with shared preset policy.
- [ ] Select and pin a dependency-free JavaScript linter/formatter invocation.
      Track its version through one canonical file and Renovate custom manager,
      then add it to `pnpm validate` without creating install artifacts.
- [ ] Measure Node test coverage before choosing thresholds. Add reviewed
      per-file and overall floors only after the baseline and meaningful gaps
      are understood.
- [ ] Evaluate the OpenSSF Scorecard workflow and badge, including its token
      permissions and SARIF publishing behavior, before enabling it.
- [ ] After the preset bootstrap freeze lifts, evaluate Renovate's experimental
      `osvVulnerabilityAlerts` against fixtures. It covers direct dependencies
      only and must not replace the active Dependabot remediation path.
- [ ] Split the one-time GitHub App bootstrap into `docs/setup/github-app.md`
      and keep the README as the map after the permission-policy binding is
      stable. Add one small diagram of the CI, Renovate, and hygiene lanes plus
      the App-installation, `allowedCommands`, and preset-tag trust boundaries.
- [ ] Add `docs/why-this-repo-looks-like-this.md`, pairing the repository's
      fail-closed rules with field incidents. Include the live GitHub response
      that disproved a paraphrased unit fixture.

## Parity checks by machine, not memory

- [ ] Make `.renovate-version` the canonical runtime pin: the runner action,
      config validator, run summaries, and Renovate custom manager must all
      resolve it, with no duplicated numeric pins to synchronize.
      **Implemented locally; pending merge.**
- [ ] Allow only Roost's repo-owned formatter command with the exact global
      pattern `^node tools/renovate-format-artifacts\.mjs$`; keep shell
      execution and arbitrary arguments disabled. **Implemented locally;
      pending merge.**
- [ ] Assert that catalog/manifest ownership holds for consumers: a
      lockfile-only change is not a completed dependency update when the
      canonical pin belongs in `pnpm-workspace.yaml`.

## Hygiene

- [ ] Add a raw-byte NUL scan over tracked and non-ignored untracked files. A
      literal NUL makes a file read as binary and disappear from diffs. Keep it
      small — a short Node or shell check — with exact file-level binary
      exceptions rather than directory exemptions. Verified 2026-07-20: this
      repo currently has zero affected files, so this is prevention.
