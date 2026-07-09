# Agent Instructions

This repository owns dependency-update automation for the owner's repos. Keep it
small, observable, and boring: one shared Renovate preset, one self-hosted
runner workflow, and no product code.

## Operating Rules

- Never commit secrets, tokens, or local machine state. The GitHub App secrets
  `RENOVATE_APP_CLIENT_ID` and `RENOVATE_APP_PRIVATE_KEY` live in the GitHub
  `renovate` environment, not in files.
- Keep `default.json` limited to policy that must stay identical across owner
  repos. Repo-specific `packageRules` stay in the consuming repo.
- Keep the workflow SHA-pinned with human-readable version comments.
- Keep runner permissions minimal and `actions/checkout` with
  `persist-credentials: false`.
- Validate Renovate config changes with the CI workflow before relying on them.

## Git

The owner owns commits and pushes. When a commit is due, propose conventional
commit messages and let the owner choose.
