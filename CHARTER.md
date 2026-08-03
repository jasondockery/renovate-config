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

## System outcome

Renovate-config provides dependable dependency automation for its configured
repositories. Success is not merely a valid preset, a green runner workflow, or
a receipt showing that three repositories were scanned. An eligible dependency
update must move from release detection and policy evaluation through a correct,
reviewable pull request whose canonical manifests and generated artifacts are
current and whose consumer repository CI passes.

When no pull request is created, retained evidence must explain whether the
update is absent, younger than the five-day release-age floor on a supported
timestamped update surface, outside the weekly routine update/branch window,
awaiting owner approval, blocked by another branch or PR, or failed during
branch, artifact, or pull-request creation. The canonical
observable contract and evidence matrix are in
[`specs/renovate-system-acceptance.md`](specs/renovate-system-acceptance.md).

## Policy status

- **Current:** the accepted preset is byte-frozen. Its weekly schedule is
  active, but an inherited npm rule means its top-level five-day declaration
  does not establish the target effective strict five-day npm behavior. Its
  security block guarantees immediate creation and automerge only.
- **Approved in principle:** the isolated proposal fixture adds the reviewed
  normal npm override, strict internal checks, and explicit security schedule,
  age, and rate-limit bypass. It remains outside required CI and production.
- **Target:** after an owner-approved preset commit, release, consumer pin, and
  field proof, the five-day and security outcomes in this charter and the
  acceptance spec become active operating guarantees.

## Owns

- Shared scheduling, cooldown, and dependency-age policy (`default.json`)
- PR and concurrency limits, common labels, and rebase behavior
- Baseline security-update behavior
- The canonical Renovate runtime pin and the runner config (`runner.json`)
- The self-hosted runner workflow and its validation gate
- The cross-repository acceptance contract, read-only post-run audit, and
  controlled canary design
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

**Current proposed coverage:** offline CI checks repository-owned policy,
inventory, workflow, toolchain, and runtime structure. Required network-backed
CI uses one canonical Renovate runtime to exercise the synthetic extraction
fixture and strict-validate configs without depending on moving consumer
branches. The owner-gated policy proposal has a separate proof. A manual-only
compatibility watch
extracts the latest actual checkouts and records each exact SHA and before/after
identity. A live runner receipt proves authentication, execution, and bounded
cleanup only. Controlled canary and green consumer-PR evidence remain separate
field proof until their explicit acceptance rows are recorded.

The proposed target contract below is what each lane is *for*. Owner approval
accepts the contract; field evidence separately establishes system acceptance.
Green does not mean the
same thing in all three, so each says what it actually exercised.

1. **Static validity** (offline CI lanes) — check repository-owned policy,
   workflow, inventory, and runtime-pin structure. No registry or GitHub
   dependency.
2. **Pinned Renovate integration** (required network-backed CI lane) — acquire
   the exact `.renovate-version` once, exercise synthetic extraction, and
   strict-validate configs. It proves only the exact
   renovate-config SHA. **Latest-head compatibility** is a separate
   activation-gated watch that maps actual extraction from all three checkouts
   to their inventories and records exact consumer SHAs plus before/after status
   and bounded fingerprints. Its result is exact for the recorded checkout
   identities, not reusable proof for later default-branch heads.
3. **Runner execution** — authenticate, process every configured repository,
   sanitize the structured receipt, and remove the raw log and private
   directory. This does not prove that a branch or pull request was usable.
4. **Renovate behavior** — a controlled npm canary proves that an eligible,
   older-than-five-days npm update becomes a branch and pull request in the
   intended window and can be recreated after closure. Other managers retain
   separate extraction and real-consumer acceptance rows.
5. **Consumer compatibility** — generated changes update every canonical
   manifest, catalog, lockfile, generated artifact, and pin, and each consumer's
   required CI passes.

The first deployment of this system requires the real pull-request path through
level 5. Later readiness claims require one live scan receipt plus either one
eligible green consumer PR or a complete post-run audit proving that no update
was eligible. A runner receipt alone never establishes system readiness.

## Dependency coverage

Every externally maintained dependency used by a consumer is classified in that
repository's machine-checked `dependency-coverage.json` as detected by a built-in
manager, detected by a repository-owned custom manager, derived from another
canonical pin, or intentionally manual. An unclassified version surface is a
coverage defect. The pinned-Renovate fixture covers npm, Dockerfile, Compose,
GitHub Actions, nodenv, mise, renovate-config, and both custom-regex families.
The latest-head compatibility watch extracts every actual checkout and requires
each tuple plus each bounded discovery hit to have exactly one inventory owner
or one explicit reasoned suppression. The discovery guard uses file-aware
source, JSON, TOML, YAML, workflow, container, and plugin conventions, excludes
docs and fixtures unless explicitly selected, and requires every non-optional
matcher to produce evidence. JSON and JSONC are structurally parsed; TOML and
YAML receive bounded line-aware discovery and remain subject to each
repository's syntax validation. It is a heuristic tripwire, not a proof that no
future syntax can evade discovery. Every surface states whether Renovate
enforces age there or names its compensating control.

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
