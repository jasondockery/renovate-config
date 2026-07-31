# Roadmap

Follow-ups for this repository. `CHARTER.md` owns scope and distribution;
`AGENTS.md` owns operating behavior. Check a box only after the work is
verified, never aspirationally.

## Versioned distribution

> **Freeze in effect until every consumer is pinned.** Until then all three
> consumers still resolve this repository's default branch, so a merge to
> `default.json` changes their dependency policy immediately and silently. Do
> not change `default.json` during the bootstrap sequence below. Charter,
> roadmap, guardrail, timeout, and validation changes are safe to merge — they
> do not alter the resolved preset.

Bootstrap sequence, in this order:

- [x] 1. Merge only the charter, roadmap, guardrail, timeout, and validation
      changes. `default.json` stays untouched. Verified 2026-07-29:
      `git log b466499..HEAD -- default.json` returns nothing, so no commit
      since the freeze was declared has altered the resolved preset. Steps 2
      onward are owner actions and remain open — the freeze stays in effect.
- [ ] 2. Configure a GitHub tag ruleset that prevents release tags from being
      updated or deleted. Owner action: repository rulesets are the owner's.
- [ ] 2a. Evaluate GitHub immutable releases before the first tag. If adopted,
      update `CHARTER.md` and `CONTRIBUTING.md` so publishing the GitHub Release
      is part of the release contract; keep the tag ruleset as defense in
      depth. Record the owner-setting receipt either way.
- [ ] 3. Tag the verified commit **`1.0.0`** — no `v` prefix. Renovate's
      `#suffix` resolves a Git tag by exact name, so a `v1.0.0` tag must not be
      assumed to resolve as `#1.0.0`. One convention in both places. Owner
      action: tags and pushes are the owner's.
- [ ] 4. Confirm the *released reference* resolves end to end, not just that the
      source file is valid: tag exists → `github>jasondockery/renovate-config#1.0.0`
      resolves → Renovate validates the resolved preset → a consumer config
      extending it passes. This catches tag naming, file naming, permissions,
      and repository-resolution problems before three consumers change.
- [ ] 5. Have the owner open the initial pin PR for this repository, then let a
      validation/discovery run confirm it.
- [ ] 6. Have the owner open Groundwork's initial pin PR.
- [ ] 7. Have the owner open Roost's initial pin PR.
- [ ] 8. Confirm Renovate proposes a later tagged preset bump in a consumer, and
      record that PR as the receipt that distribution actually works. Renovate
      proposes preset-version updates only once the reference is already pinned.
- [ ] 9. Lift the freeze and note it here.
- [ ] Document the release procedure in `CONTRIBUTING.md`, pointing at the
      charter's patch/minor/major contract rather than restating it.
      **Implemented locally; pending merge.**

## Proof levels

- [ ] Add fixture-based preset tests to the deterministic gate: assert which
      updates `default.json` groups, schedules, and automerges, so a policy
      regression fails CI rather than surfacing as a surprising PR. Today CI
      validates schema only — a schema-valid preset can still be wrong.
- [ ] Stand up a canary repository for controlled dry runs covering matching,
      grouping, catalog updates, lockfile behavior, replacement packages, and
      security-PR routing. Bounded; never mutating a production repo.
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

## Security and verification backlog

- [ ] Enable CodeQL default setup for this public JavaScript repository and
      record its first successful scan. Keep Zizmor: it covers workflow risks,
      while CodeQL covers the Node tools that parse untrusted API data.
- [ ] Evaluate a pinned actionlint gate, including the ShellCheck checks needed
      for masked command-substitution failures. Keep it complementary to
      Zizmor, not a replacement.
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
