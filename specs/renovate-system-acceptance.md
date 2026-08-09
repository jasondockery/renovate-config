# Renovate system acceptance

Contract status: active

System acceptance: not achieved

Policy activation: active. The owner-approved preset exception supplies the
daily routine-creation policy, later strict five-day npm rule, and explicit
vulnerability-alert schedule, age, and routine rate-limit bypass. Field
acceptance remains separate.

Owner: `jasondockery/renovate-config`

Consumers: `jasondockery/renovate-config`, `jasondockery/roost`, and
`jasondockery/groundwork`

## Outcome

A scheduled or manually dispatched Renovate run authenticates with the GitHub
App, processes every configured repository, applies the five-day dependency-age
policy where the datasource and update type support it, evaluates routine
branch and PR creation on every daily run, and creates or updates eligible pull
requests.
Those pull requests contain every required canonical and generated artifact and
pass the consumer repository's CI. When no pull request should exist, the
Dependency Dashboard, sanitized receipt, and post-run audit explain why.

## Timing policy

These clocks solve different problems and must remain independent:

| Clock | Contract |
| --- | --- |
| Renovate process | Once daily at `01:17 UTC`, plus manual dispatch |
| Normal routine updates and branches | Every daily run after applicable maturity and approval gates |
| Normal release age | Five days with `internalChecksFilter: strict` where timestamps and update types support it; inventories name exceptions |
| Vulnerability-alert PRs | Bypass normal age and PR schedules; observed on the next daily run |
| Lockfile maintenance | Weekly; Renovate release-age checks do not apply directly, while consumer package-manager policy still governs generated resolution where configured |

The workflow cadence determines discovery latency. It never replaces or extends
the age floor: a supported timestamped release completes its own five-day clock
independently of when the runner executes.

## Acceptance matrix

| Claim | Authoritative evidence |
| --- | --- |
| App authentication works | Successful token mint with the exact reviewed permissions |
| All target repositories are processed | One passed structured-receipt row for each configured repository |
| Five-day age works | Pinned-runtime behavior keeps supported npm and timestamped GitHub-release updates pending at 4 days 23 hours 59 minutes and allows them at 5 days 1 minute. Required exact-SHA CI evidence: the `renovate-integration` lane resolves the preset against the pinned runtime on every push (`pnpm renovate:policy` is the identical local command). Static preset/fixture parity is necessary but never sufficient — it cannot observe an inherited later rule lowering the effective floor |
| Daily routine creation works | A mature normal update advances on the next daily run; routine updates do not remain `Awaiting Schedule` |
| npm PR creation works | Actual npm canary branch and pull request; this does not prove other manager families |
| Formatter commands work | Expected canonical lock and generated artifacts appear in the pull request |
| Each consumer is compatible | Required CI is green on an eligible Renovate PR in each consumer |
| Existing PRs update correctly | A later eligible version refreshes the same Renovate branch and PR |
| Stale PRs recover | A deliberately closed stale canary PR is recreated from current `main` while still eligible |
| Security updates are timely | Fixture policy plus a controlled field case prove that normal age and schedule do not block the security lane |
| No-update runs are explainable | Dashboard, recursive pnpm evidence, and `pnpm renovate:audit --run <run-id>` identify no update, minimum age, approval, disabled policy, weekly lockfile maintenance, branch, PR, limit, or failure state |
| Cleanup is safe | Sanitized receipt says the raw log and original private directory were removed before publication; neither is uploaded |

## Proof levels

1. **Static validity:** offline policy, workflow, inventory, and runtime
   contracts pass locally and in CI.
2. **Pinned Renovate integration:** required network-backed CI acquires the
   exact runtime once, exercises synthetic extraction, and strict-validates
   config without reading mutable consumer branches. The active policy has a
   separate exact-boundary proof. A manual-only latest-head
   compatibility watch maps
   actual extraction for all three repositories, records each exact tested SHA,
   status, tracked fingerprint, and relevant ignored-output fingerprint, and
   rejects any before/after identity change.
3. **Runner execution:** the live receipt proves authentication, all repository
   visits, structured evidence, and cleanup.
4. **Renovate behavior:** the private npm canary proves eligible branch and PR
   creation, update, closure, and recreation.
5. **Consumer compatibility:** eligible real PRs in all three consumers contain
   correct artifacts and pass required CI.

No lower level implies a higher one. In particular, a green runner at level 3
must be described as a green runner, never as a working end-to-end dependency
system.

## Explainable no-PR outcomes

A no-PR result is acceptable only when evidence selects at least one of these
states:

- no update exists;
- every supported timestamped target is still inside the five-day age floor;
- an update awaits explicit dashboard approval;
- a current Renovate branch or pull request already represents it;
- a configured PR limit is reached;
- repository policy intentionally disables or ignores it;
- the separately scheduled weekly lockfile-maintenance lane is not due yet.

Missing configuration, extraction failure, branch creation failure, artifact
failure, a branch without its expected PR, or red consumer CI is an integration
failure, not an acceptable no-op.

The current sanitized run receipt does not yet carry an authoritative
no-eligible-update record. Until it does, a dashboard-only negative conclusion
remains `pending`; the no-update readiness route is specified here but is not
yet achieved.

## Dependency coverage

Every consumer owns `dependency-coverage.json`. Each external version surface is
one of:

- `built-in`: a tested Renovate manager extracts it;
- `custom-manager`: the consumer owns and tests the extraction rule;
- `derived`: another canonical pin owns the version and a local guard proves
  parity;
- `intentional-manual`: automation would be unsafe or incomplete, and the
  inventory names the owner command or review path.

`missing` is a failing audit state, never a lasting classification. Each row
also names its age policy, compensating control, actual extraction matchers where
applicable, and scanner ownership for derived/manual conventions. The shared
fixture covers `npm`, `dockerfile`, `docker-compose`, `github-actions`, `nodenv`,
`mise`, `renovate-config`, the Renovate runtime regex, and Roost's OpenNext
regex. Required integration proves the extraction fixture and accepted config.
The separate `pnpm renovate:policy` command proves the active policy contract
against the pinned runtime. The latest-head compatibility watch tests the three actual checkouts. Its
file-aware convention scan is a bounded heuristic guard, not a mathematical
completeness proof. It structurally parses JSON/JSONC; TOML/YAML discovery is
line-aware and their syntax remains owned by consumer repository validation.

## Controlled canary

The owner provisions one private `renovate-canary` repository. It consumes the
released shared preset and the same GitHub App runner, contains one deliberately
outdated npm dependency whose target release is older than five days, and
commits a lockfile so the PR proves both manifest and artifact mutation. Its CI
performs a frozen install and a minimal behavior assertion.

That canary proves only the npm path: effective age, daily branch creation, branch
and PR mutation, lockfile generation, closure, and recreation. Dockerfile,
GitHub Actions, runtime pins, custom managers, digests, and checksum-coupled
manual surfaces require their extraction rows and real consumer PR evidence.

The canary is not part of the three production consumers and is included only in
explicit acceptance dispatches until its App permission, runner scope, and
receipt representation are reviewed. Creating the repository, widening the App
installation, and changing the runner target set are owner actions. The active
execution checklist is
[`playbooks/x-renovate-system-acceptance.md`](../playbooks/x-renovate-system-acceptance.md).

## Post-run audit

`pnpm renovate:audit --run <run-id>` is read-only against GitHub. It binds the
sanitized artifact to the exact workflow run, then reports per consumer:

- receipt processing result;
- Dependency Dashboard observation and whether its update falls within the
  selected run interval plus the explicit two-minute GitHub timestamp allowance;
  an older unchanged dashboard is pending rather than failed and cannot prove a
  current no-update result;
- named dashboard dispositions for pending internal checks, the retained weekly
  lockfile-maintenance lane, rate limiting, approval, and abandoned-dependency
  inventory; dashboard command checkboxes are not updates; a publication-
  age comparison is required before calling a pending check "too young";
- open Renovate branches plus open, merged, and closed pull requests bound to
  bot author, base, head SHA, state, and selected-run timing; only an open PR
  requires its remote branch to remain present;
- aggregate PR check state;
- the selected no-PR explanation or unexpected integration state. Unknown
  actionable sections fail; other unknown sections and a Detected Dependencies
  heading without structured no-update evidence remain pending.

The audit reads `default.json` from the selected run SHA before interpreting
`Awaiting Schedule`, so a historical weekly-policy run remains auditable after
the daily policy lands. Under daily routine creation, any refreshed non-lockfile
update left in `Awaiting Schedule` is a finding. The exact
`self-hosted-renovate/lock-file-maintenance` identity remains the explicit
weekly maintenance exception.

`pnpm outdated` remains supplemental registry evidence, not Renovate
eligibility. Run `tools/show-outdated.mjs` from each exact consumer checkout;
it uses recursive workspace discovery and reports current, compatible, mature,
registry-newest, publication, and five-day-boundary facts. Reconcile every
package with a named dashboard, policy, branch, or PR disposition, then account
for GitHub Actions, Docker, regex/custom managers, runtime pins, digests, and
manual inventory rows separately.

The command may create and remove a private local temporary directory only to
download the sanitized receipt. It never downloads the raw Renovate log and
never mutates a repository, issue, branch, pull request, or workflow run.

## Readiness rule

After the first level-5 acceptance, a change may be called ready only with one
live scan receipt plus either:

1. one eligible update reaching a green consumer PR; or
2. a complete audit proving no update was eligible.

The second route cannot establish the system's first acceptance. Exact run IDs,
PR URLs, consumer SHAs, check conclusions, and cleanup facts are recorded in the
playbook before it is retired.
