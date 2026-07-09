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
