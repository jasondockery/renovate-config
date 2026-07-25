# Contributing

This repo is intentionally narrow: it runs self-hosted Renovate for the owner's
repositories and publishes the shared preset they consume.

## Ground Rules

- Keep changes scoped to dependency-update policy or the runner workflow.
- Do not add repo-specific package rules to `default.json`; put those in the
  consuming repo.
- Do not commit secrets. Configure `RENOVATE_APP_CLIENT_ID` and
  `RENOVATE_APP_PRIVATE_KEY` as secrets in the GitHub environment named
  `renovate`.
- Run or wait for CI before using a changed preset or workflow.

## Pull Requests

Explain what policy changed, why it belongs in the shared preset or runner, and
what validation ran.

## Releasing the preset

`package.json` remains private at `0.0.0`; preset releases are immutable SemVer
Git tags without a `v` prefix. Classify the consumer impact with the
patch/minor/major contract in `CHARTER.md`, then:

1. Keep `default.json` unchanged while `.preset-bootstrap-freeze` exists.
2. Run `pnpm test` and `pnpm validate`, open a focused PR, and wait for CI.
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
