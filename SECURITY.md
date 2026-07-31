# Security Policy

This repo controls dependency-update automation for multiple repositories, so
workflow and token changes are sensitive.

## Reporting

Do not open a public issue with exploit details, secrets, or token material.
Use GitHub private vulnerability reporting for this repository.

The security-hygiene reusable workflow must be invoked only by a private
repository. Alert reports, job summaries, artifacts, and its durable issue can
contain private-repository security metadata and must never be produced in
this public repository.

If private reporting is unavailable, open a minimal public issue titled
`Security contact needed` with no technical details, then wait for a maintainer
response.

## Sensitive Material

Do not commit or paste:

- Personal access tokens
- GitHub App private keys or webhook secrets
- `.env` files or exported local environment state
- Dependency dashboard logs containing private repository details

If a secret is committed, rotate or revoke it first, then remove it from
history. This repository is public, so assume any committed value was copied
even if it was removed quickly.
