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
