# Security Policy

This repo controls dependency-update automation for multiple repositories, so
workflow and token changes are sensitive.

## Reporting

Do not open a public issue with exploit details, secrets, or token material.
Use GitHub private vulnerability reporting for this repository.

If private reporting is unavailable, open a minimal public issue titled
`Security contact needed` with no technical details, then wait for a maintainer
response.

## Sensitive Material

Do not commit or paste:

- `RENOVATE_TOKEN` or any other personal access token
- GitHub App private keys or webhook secrets
- `.env` files or exported local environment state
- Dependency dashboard logs containing private repository details

If a secret is committed, rotate the secret first, then remove it from history
before making the repository public.

