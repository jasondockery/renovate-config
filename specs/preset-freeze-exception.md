# Proposed preset freeze exception

Design status: **approved in principle**

Activation status: **separate owner-approved policy commit required**

Scope: `default.json` effective release-age and vulnerability-alert policy only
Exit condition: the isolated policy commit passes its exact-boundary proof and
the owner authorizes changing the preset freeze checksum

## Why an exception is proposed

The frozen preset says normal releases wait five days, but the resolved
`config:best-practices` chain also contributes an npm-specific three-day package
rule. Renovate applies matching package rules after root configuration, so the
current file does not establish the claimed five-day npm behavior.

The executable proposal in
`tools/fixtures/preset/default-five-day-policy.json` adds one later rule for normal npm major,
minor, and patch updates. It also makes the existing security exception
explicit: vulnerability alerts run at any time, ignore normal rate limits, and
do not inherit a minimum release age. Pins, digests, replacements, and lockfile
maintenance are deliberately outside the npm rule because Renovate cannot
enforce release age for those update types.

## Risk and rollback

Consumers still follow this repository's default branch. Accepting the
exception therefore changes all three consumers without a versioned preset
reference. The benefit is that the effective behavior matches the documented
supply-chain floor; the risk is the same unversioned propagation the freeze was
created to prevent.

Until the owner authorizes the isolated policy commit, `.preset-bootstrap-freeze` and `default.json` remain
at the last accepted state. `pnpm renovate:policy-proposal` proves the isolated
fixture, while ordinary validation stays green and does not propagate the
proposal. Approval requires copying the reviewed fixture to `default.json` and
updating the checksum in one separate, explicit owner-approved policy commit.

The durable rollback is the previous `default.json`. The long-term fix remains
versioned preset distribution so every consumer change is reviewable and has a
stable rollback target.
