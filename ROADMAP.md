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

- [ ] 1. Merge only the charter, roadmap, guardrail, timeout, and validation
      changes. `default.json` stays untouched.
- [ ] 2. Tag the verified commit **`1.0.0`** — no `v` prefix. Renovate's
      `#suffix` resolves a Git tag by exact name, so a `v1.0.0` tag must not be
      assumed to resolve as `#1.0.0`. One convention in both places. Owner
      action: tags and pushes are the owner's.
- [ ] 3. Confirm the *released reference* resolves end to end, not just that the
      source file is valid: tag exists → `github>jasondockery/renovate-config#1.0.0`
      resolves → Renovate validates the resolved preset → a consumer config
      extending it passes. This catches tag naming, file naming, permissions,
      and repository-resolution problems before three consumers change.
- [ ] 4. Pin this repository itself first, and let a validation/discovery run
      confirm it.
- [ ] 5. Pin Groundwork.
- [ ] 6. Pin Roost.
- [ ] 7. Confirm Renovate proposes a later tagged preset bump in a consumer, and
      record that PR as the receipt that distribution actually works. Renovate
      proposes preset-version updates only once the reference is already pinned.
- [ ] 8. Lift the freeze and note it here.
- [ ] Document the release procedure in `CONTRIBUTING.md`, pointing at the
      charter's patch/minor/major contract rather than restating it.

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

## Parity checks by machine, not memory

- [ ] Assert Renovate-version parity automatically: the `renovate-version` in
      `renovate.yml` and the `renovate@<version>` validator pins in `ci.yml`
      must agree. Both files currently re-read the version with `grep` for
      reporting, which proves the summary is honest but not that the pins match.
- [ ] Assert that catalog/manifest ownership holds for consumers: a
      lockfile-only change is not a completed dependency update when the
      canonical pin belongs in `pnpm-workspace.yaml`.

## Hygiene

- [ ] Add a raw-byte NUL scan over tracked and non-ignored untracked files. A
      literal NUL makes a file read as binary and disappear from diffs. Keep it
      small — a short Node or shell check — with exact file-level binary
      exceptions rather than directory exemptions. Verified 2026-07-20: this
      repo currently has zero affected files, so this is prevention.
