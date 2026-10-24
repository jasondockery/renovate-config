# Activated preset freeze exceptions

Design status: **approved**

Activation status: **active through the owner-approved 2026-08-04 age-policy,
2026-08-09 daily-creation, 2026-08-13 human-security-merge, and 2026-10-24
Python line-bump approval changes**

Scope: `default.json` effective release-age, routine creation cadence,
vulnerability-alert timing, vulnerability-alert merge authority, and Python
runtime line-bump approval only
Activation condition: **achieved**; the isolated policy commit and freeze
checksum change were owner-authorized and passed the exact-boundary proof.
The 2026-10-24 Python line-bump exception follows the same pattern for issue #30.
Remaining exit condition: every consumer uses an immutable released preset
reference, after which the bootstrap freeze can be retired as defined in the
roadmap

## Why the exception was required

The previous frozen preset said normal releases wait five days, but the resolved
`config:best-practices` chain also contributes an npm-specific three-day package
rule. Renovate applies matching package rules after root configuration, so that
previous preset did not establish the claimed five-day npm behavior.

The reviewed fixture in
`tools/fixtures/preset/default-five-day-policy.json` keeps the later rule for normal npm major,
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

The owner-approved 2026-10-24 exception ([issue #30](https://github.com/jasondockery/renovate-config/issues/30))
adds one package rule for Python runtime line bumps. At the pinned Renovate
runtime, the mise manager resolves `python` to `github-tags` package
`python/cpython`; asdf maps the same package, so the rule matches that identity
rather than the mise tool key alone. Minor and major updates such as 3.13 to
3.15 set `dependencyDashboardApproval: true` and `automerge: false`. Patch
bumps within a line keep the existing policy. The five-day `minimumReleaseAge`
is unchanged and is not restated on this rule. This ships as preset `1.1.0`;
the freeze digest is updated to the reviewed `default.json` and the freeze
remains in effect.

## Activation, risk, and rollback

Consumers still follow this repository's default branch. Accepting the
exception therefore changes all three consumers without a versioned preset
reference. The benefit is that the effective behavior matches the documented
supply-chain floor; the risk is the same unversioned propagation the freeze was
created to prevent.

The owner explicitly authorized each reviewed fixture change to `default.json`
and the corresponding `.preset-bootstrap-freeze` update. The marker remains:
its new checksum prevents any unreviewed effective change while consumers still
follow the default branch. `pnpm renovate:policy` strict-validates the active
preset and proves its resolved daily-creation, five-day, inherited
bump/rollback, immediate-security, human-merge, and Python line-bump approval
boundaries with the pinned runtime.

The durable rollback for the 2026-08-13 choice is the prior security block with
both automerge fields enabled; restoring it would again be a major, explicitly
owner-reviewed policy change. The long-term fix remains
versioned preset distribution so every consumer change is reviewable and has a
stable rollback target.
