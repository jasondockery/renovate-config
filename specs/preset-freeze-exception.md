# Activated preset freeze exceptions

Design status: **approved**

Activation status: **active through the owner-approved 2026-08-04 age-policy,
2026-08-09 daily-creation, and 2026-08-13 human-security-merge changes; the
2026-08-15 selective-automerge revision remains a held review candidate pending
corrected exact proof and separate release/merge authorization**

Scope: `default.json` effective release-age, routine creation cadence, and
vulnerability-alert behavior; plus the separate standalone
`low-risk-automerge` candidate's bounded stable npm `devDependencies`
patch/minor authority. Lockfile maintenance remains human-reviewed.
Activation condition: **achieved**; the isolated policy commit and freeze
checksum change were owner-authorized and passed the exact-boundary proof
Remaining exit condition: every consumer uses an immutable released preset
reference, after which the bootstrap freeze can be retired as defined in the
roadmap

## Why the exception was required

The previous frozen preset said normal releases wait five days, but the resolved
`config:best-practices` chain also contributes an npm-specific three-day package
rule. Renovate applies matching package rules after root configuration, so that
previous preset did not establish the claimed five-day npm behavior.

The reviewed fixture in
`tools/fixtures/preset/default-five-day-policy.json` adds one later rule for normal npm major,
minor, and patch updates. It also makes the existing security exception
explicit: vulnerability alerts run at any time, ignore normal rate limits, and
do not inherit a minimum release age. Pins, digests, replacements, and lockfile
maintenance are deliberately outside the npm rule because Renovate cannot
enforce release age for those update types.

The daily runner combined with `schedule:weekly` stacked a second calendar
delay on top of the five-day maturity floor. A mature routine update could miss
the early-Monday window and wait almost another week before a branch appeared.
The owner-approved 2026-08-09 exception removes `schedule:weekly`; mature
routine updates now advance on the next daily run while `prConcurrentLimit`
and `prHourlyLimit` remain bounded. The lockfile-maintenance rule inherited
from `config:best-practices` remains weekly.

The owner-approved 2026-08-13 exception retains immediate vulnerability PR
creation and the schedule, age, and routine-rate bypass while setting both
`automerge` and `platformAutomerge` to `false`. A human must review and merge
the maturity-bypassed fix. The supporting decision record is
`docs/vulnerability-alert-automerge-decision.md`.

The held 2026-08-15 candidate is now a standalone named preset with a
fourteen-day floor. It gives Renovate (not GitHub platform automerge) authority
to merge stable npm `devDependencies` patch/minor PRs only after the consumer's
exact required-check inventory and pristine-branch integrity check succeed on
the current head. Majors, `0.x`,
lockfile maintenance, Actions, runtimes, and Renovate/runner
infrastructure, deployment and other trust-boundary packages remain outside
the shared eligible set or are disabled by later consumer rules. Security PRs
retain the separate human-review rule above. AI review is supplemental and
cannot authorize a merge; see `docs/ai-review-merge-authority.md`.

## Activation, risk, and rollback

Consumers still follow this repository's default branch. Accepting the
exception therefore changes all three consumers without a versioned preset
reference. The benefit is that the effective behavior matches the documented
supply-chain floor; the risk is the same unversioned propagation the freeze was
created to prevent.

The owner explicitly authorized each active fixture change to `default.json`
and the corresponding `.preset-bootstrap-freeze` update. The separate
selective-automerge bytes
must not reach `main` until their final proof and separately authorized
release/merge choreography are complete. The marker remains:
its new checksum prevents any unreviewed effective change while consumers still
follow the default branch. `pnpm renovate:policy` strict-validates the active
preset and proves its resolved daily-creation, five-day, inherited
bump/rollback, immediate-security, and human-merge boundaries with the pinned
runtime.

The durable rollback for the 2026-08-13 choice is the prior security block with
both automerge fields enabled; restoring it would again be a major, explicitly
owner-reviewed policy change. The long-term fix remains
versioned preset distribution so every consumer change is reviewable and has a
stable rollback target.
