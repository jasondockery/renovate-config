# Renovate 43.288.0 structured-log fixture provenance

This is a deliberate, sanitized fixture update for Renovate `43.288.0`. It
retains the lifecycle order previously captured from a successful three-repo
workflow, while its runtime-specific record shapes were source-verified against
Renovate tag `43.288.0`, immutable commit
`f60995a404a1766c302e6c5fbd615676ff7e27ba`.

That source logs `Repository timing splits (milliseconds)` from the repository
worker and emits the `splits` plus `total` object returned by `getSplits()`.
The numeric values here are deliberately synthetic. This provenance does not
claim a successful live three-repository run on `43.288.0`; the next dispatched
workflow remains the authoritative field proof.

The warning, error, and fatal records are sanitized hostile scenarios. Every
record carries the exact accepted runtime so a fixture cannot be adopted for a
new pin by renaming files alone.
