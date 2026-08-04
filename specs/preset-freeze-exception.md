# Activated preset freeze exception

Design status: **approved**

Activation status: **active in the owner-approved 2026-08-04 policy commit**

Scope: `default.json` effective release-age and vulnerability-alert policy only
Exit condition: the isolated policy commit passes its exact-boundary proof and
the owner authorizes changing the preset freeze checksum

## Why the exception was required

The frozen preset says normal releases wait five days, but the resolved
`config:best-practices` chain also contributes an npm-specific three-day package
rule. Renovate applies matching package rules after root configuration, so the
current file does not establish the claimed five-day npm behavior.

The reviewed fixture in
`tools/fixtures/preset/default-five-day-policy.json` adds one later rule for normal npm major,
minor, and patch updates. It also makes the existing security exception
explicit: vulnerability alerts run at any time, ignore normal rate limits, and
do not inherit a minimum release age. Pins, digests, replacements, and lockfile
maintenance are deliberately outside the npm rule because Renovate cannot
enforce release age for those update types.

## Activation, risk, and rollback

Consumers still follow this repository's default branch. Accepting the
exception therefore changes all three consumers without a versioned preset
reference. The benefit is that the effective behavior matches the documented
supply-chain floor; the risk is the same unversioned propagation the freeze was
created to prevent.

The owner explicitly authorized copying the reviewed fixture to `default.json`
and updating `.preset-bootstrap-freeze` in one bounded policy commit. The
marker remains: its new checksum prevents any additional effective change while
consumers still follow the default branch. `pnpm renovate:policy` strict-validates
the active preset and proves its resolved five-day and security boundaries with
the pinned runtime.

The durable rollback is the previous `default.json`. The long-term fix remains
versioned preset distribution so every consumer change is reviewable and has a
stable rollback target.
