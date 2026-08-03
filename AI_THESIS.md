# Renovate Config: Enduring Goal

Renovate Config exists to keep every external dependency surface in its
configured repositories deliberately current without sacrificing supply-chain
safety or consumer correctness.

Success is not a valid preset, a green runner, or a completed repository scan.
An eligible dependency update must become a correct, reviewable pull request
whose canonical manifests and generated artifacts are current and whose
consumer repository CI passes. When no pull request is created, retained
evidence must explain whether the update is absent, too new, outside its
schedule, awaiting approval, blocked, or already represented.

Every dependency surface must be automatically detected, derived from a
guarded canonical pin, or explicitly assigned to a deliberate manual process.
No green local check or runner receipt may stand in for the real consumer
outcome it did not exercise.

Detailed ownership, governance, and proof boundaries live in
[`CHARTER.md`](CHARTER.md). The precise observable system contract lives in
[`specs/renovate-system-acceptance.md`](specs/renovate-system-acceptance.md).
