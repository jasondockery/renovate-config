# Contributing

This repo is intentionally narrow: it runs self-hosted Renovate for the owner's
repositories and publishes the shared preset they consume.

## Ground Rules

- Keep changes scoped to dependency-update policy or the runner workflow.
- Do not add repo-specific package rules to `default.json`; put those in the
  consuming repo.
- Do not commit credentials. Configure `RENOVATE_APP_CLIENT_ID` as a variable
  and `RENOVATE_APP_PRIVATE_KEY` as a secret in the GitHub environment named
  `renovate`.
- Keep every `secrets.*` and `vars.*` workflow reference reconciled with
  `tools/github-external-config.json`; consumer repositories do not store the
  runner App credentials.
- Run or wait for CI before using a changed preset or workflow.

## Pull Requests

Explain what policy changed, why it belongs in the shared preset or runner, and
what validation ran.

For a cross-cutting final proof, `pnpm verify` prints the authoritative local
receipt. Add `-- --report /absolute/path/outside/this/repository.json` when a
machine-readable handoff is useful; the report is atomic, contains no reusable
CI identity, and is valid only for the exact local tree it observed.

For an authorized push, reconcile the index and create the intended local
commit before final proof. Run `pnpm verify` on that exact clean commit and do
not edit, restage, amend, or otherwise change source, index, or history before
pushing it.

## Running the security-hygiene report locally

The report is read-only against GitHub. Use a token that can read the three
alert sources, do not enable shell tracing, and do not save the token in a
tracked file:

```bash
token="$(gh auth token)"
HYGIENE_DEPENDABOT_TOKEN="$token" \
HYGIENE_CODE_SCANNING_TOKEN="$token" \
HYGIENE_SECRET_SCANNING_TOKEN="$token" \
node tools/security-hygiene-report.mjs
unset token
```

Local output may contain private-repository security metadata. Inspect it only
in a trusted terminal; do not redirect it into this public checkout, paste it
into a public issue, or upload it as a public artifact.

The repository set defaults to the keys in `tools/security-policy.mjs`.
`HYGIENE_REPOS` is an optional fail-closed compatibility assertion for local or
legacy callers; if supplied, its set must exactly equal policy. Add
`HYGIENE_ENFORCE=1` only when the caller needs exit 2/3 enforcement rather than
an inspection report. See
[`docs/runbooks/security-hygiene.md`](docs/runbooks/security-hygiene.md) for the
canonical exit table and live owner gates.

## Releasing the preset

`package.json` remains private at `0.0.0`; preset releases are immutable SemVer
GitHub Releases with tags that carry no `v` prefix. Classify the consumer
impact with the patch/minor/major contract in `CHARTER.md`, then:

1. Keep `default.json` unchanged while `.preset-bootstrap-freeze` exists.
2. Run `pnpm release:controls:check`. It is read-only and must report both
   immutable releases and the checked-in tag ruleset as active. If it reports
   drift, the owner reviews `tools/release-controls.json` and explicitly runs
   `pnpm run release:controls:apply -- --confirm-owner-admin`, then reruns the
   check. Applying repository settings is an owner action.
3. Create a draft GitHub Release for the bare version (for example, `1.0.0`),
   but do not publish it yet. Add all release notes and assets while it is a
   draft; immutable releases cannot be edited after publication.
4. After the intended release commit reaches `main` and exact-SHA `ci-gate` is
   green, run
   `pnpm release:preflight -- --version <version> --expected-sha <40-char-sha>`.
   This read-only command proves the clean intended commit, absent local and
   remote tag, active release controls, correct freeze state, authoritative
   exact-SHA CI receipt, and one canonical `pnpm verify`. Do not run a separate
   final `pnpm verify`; the preflight owns that one gate.
5. The owner publishes the draft. Publication creates the bare tag and makes
   the GitHub Release, tag, and assets immutable. Never move, delete, or
   recreate a released tag; corrections use a new patch release.
6. Run
   `pnpm release:verify -- --version <version> --expected-sha <40-char-sha>`.
   It must prove tag-to-SHA identity, the published immutable release, tagged
   `default.json` equality with the expected commit, and end-to-end Renovate
   resolution of `github>jasondockery/renovate-config#<version>`.
7. During the initial bootstrap, the owner authors the PR that changes each
   consumer's unversioned reference to
   `github>jasondockery/renovate-config#1.0.0`, following the order in
   `ROADMAP.md`.
8. For later releases, let Renovate propose the existing pin's version bump as
   an ordinary, reviewable PR.

Release-control changes, publication, and initial consumer-pin flips are owner
actions. The check, preflight, and post-publication verifier are read-only. A
local source-file validation is not proof that a released GitHub reference
resolves.
