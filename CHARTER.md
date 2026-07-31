# Repository Charter

This repository is small on purpose. Its job is to hold the shared
dependency-update **baseline** intended to remain identical across
participating repositories, the self-hosted runner that applies it, and the
public reusable implementation for one read-only security-hygiene inbox.
Repository-specific policy and remediation stay local; see "Does not own".

## Purpose

Provide the versioned Renovate policy and observable runner behavior shared by
participating repositories, so a policy change is made once, released once, and
arrives in each consumer as a reviewable update. Keep Dependabot,
code-scanning, and secret-scanning coverage visible without dismissing or
remediating findings from this repository.

## Owns

- Shared scheduling, cooldown, and dependency-age policy (`default.json`)
- PR and concurrency limits, common labels, and rebase behavior
- Baseline security-update behavior
- The canonical Renovate runtime pin and the runner config (`runner.json`)
- The self-hosted runner workflow and its validation gate
- The read-only security-hygiene source policy, report implementation, and
  reusable workflow for the same enumerated repositories

## Does not own

- Repository-specific package groupings and dependency exceptions
- Framework-major migration decisions
- Security-alert remediation, risk acceptance, and repository-specific
  exceptions
- General engineering skills, shared scripts, or CI utilities unrelated to
  dependency updates or the bounded hygiene inbox
- Security-hygiene secrets, execution history, summaries, artifacts, and the
  durable report issue; those belong to a private caller repository

Those belong in the consuming repository. This repo is not the home for
arbitrary shared tooling merely because several repos already point at it.

## Consumers

`jasondockery/renovate-config`, `jasondockery/roost`, and
`jasondockery/groundwork`, enumerated in `RENOVATE_REPOSITORIES` in the runner
workflow and `SOURCE_POLICY` in `tools/security-policy.mjs`. Each consumer
carries its own `renovate.json`; the runner never opens onboarding PRs.

Global `allowedCommands` applies to every consumer, and an allowlisted
repository-owned script executes inside Renovate's trust context. The
enumerated repositories and their maintainers therefore form one code-execution
trust boundary. If their maintainer trust diverges, they must use separate
runner configurations.

## Distribution and versioning

Releases are SemVer tags on this repository. **Tags carry no `v` prefix.**
Renovate's `#suffix` resolves a Git tag by exact name, and its documented
examples use the bare form, so a tag named `v1.0.0` must not be assumed to
resolve as `#1.0.0`. One convention, used in both places:

```text
tag:       1.0.0
reference: github>jasondockery/renovate-config#1.0.0
```

Consumers pin a released version:

```json
{ "extends": ["github>jasondockery/renovate-config#1.0.0"] }
```

**A released tag is immutable.** It is never moved, deleted, or recreated —
otherwise a pinned consumer reference can still change invisibly. Corrections
ship as a new patch release.

Pinning is the point. An unpinned `github>jasondockery/renovate-config` follows
the default branch, so a merge here silently changes dependency policy in every
consumer with no reviewable consumer-side diff and no rollback target. Because
the reference is pinned, Renovate itself proposes the preset bump as an ordinary
PR in each consumer, where it can be reviewed and verified in that repo's own
environment.

### What warrants which bump

"Anything that changes the proposed update set" would make nearly every policy
edit a major, so the line is drawn at **consumer impact**, not diff size.

- **Patch** — documentation and test corrections; implementation fixes that
  restore already-documented policy; no intended change to the resulting
  update set.
- **Minor** — additive package families or grouping rules; compatible
  scheduling and presentation improvements; new safeguards that do not weaken
  an existing guarantee.
- **Major** — removing or renaming a preset; any change requiring consumer
  migration; weaker security or release-age guarantees; changed default
  automerge authority; materially broader update scope; changed source-of-truth
  ownership.

## Target proof levels

**Current coverage:** normal CI strict-validates configuration structure and
migrations with the canonical runtime, and checks the toolchain/runtime
contracts. Fixture-based behavioral proof and controlled canary proof are
roadmap work, not present today — a schema-valid preset can still encode the
wrong policy.

The target contract below is what each lane is *for*. Green does not mean the
same thing in all three, so each says what it actually exercised.

1. **Deterministic preset validation** (normal CI gate) — schema-validate each
   config, check policy against fixtures, verify the shared/local boundary and
   runtime-pin parity. No registry or GitHub dependency.
2. **Controlled dry run** — matching, grouping, catalog and lockfile behavior,
   replacement packages, and security-PR routing against fixture or canary
   repositories. Bounded, and never mutating a production repository.
3. **Live scheduled run** — real authentication, registry access, repository
   discovery, and PR behavior. Labeled a live run, recording whether caches were
   warm; it is not a cold-network proof unless the store was actually clean.

The hygiene lane has a separate live gate: a private caller pins this public
reusable workflow to an exact commit and supplies the same commit as its
implementation-ref assertion. Two manual private-caller runs must prove App
permissions, live source classification, durable issue reuse, label
convergence, and independent issue/artifact delivery before the caller enables
its schedule. A real overdue result is a successful monitor receipt, not a
green Renovate-remediation receipt.

## Dependency ownership

The canonical version lives in the source manifest, not the lockfile: catalog
entry or manifest → regenerated lockfile → frozen install. A lockfile-only
change is not a completed dependency update when the canonical pin belongs in
`pnpm-workspace.yaml`.

The full-SHA GitHub Action pin and the Renovate runtime are separate
dependencies. `.renovate-version` is the canonical runtime source: the runner
action, config validator, summaries, and Renovate custom manager resolve it
instead of maintaining numeric copies. The action wrapper remains independently
SHA-pinned with a human-readable release comment.
