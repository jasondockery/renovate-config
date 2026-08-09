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
Git tags without a `v` prefix. Classify the consumer impact with the
patch/minor/major contract in `CHARTER.md`, then:

1. Keep `default.json` unchanged while `.preset-bootstrap-freeze` exists.
2. Run one final `pnpm verify`, open a focused PR, and wait for `ci-gate`.
3. Before the first release, have the owner configure a GitHub tag ruleset that
   prevents release-tag updates and deletions.
4. After the release commit reaches `main`, have the owner create and push the
   bare tag (for example, `1.0.0`). Never move, delete, or recreate a released
   tag; corrections use a new patch release.
5. Resolve and validate
   `github>jasondockery/renovate-config#<version>` before changing a consumer.
6. During the initial bootstrap, the owner authors the PR that changes each
   consumer's unversioned reference to
   `github>jasondockery/renovate-config#1.0.0`, following the order in
   `ROADMAP.md`.
7. For later releases, let Renovate propose the existing pin's version bump as
   an ordinary, reviewable PR.

Tag rulesets, tag creation, tag pushes, and initial consumer-pin flips are owner
actions. A local source-file validation is not proof that a released GitHub
reference resolves.
