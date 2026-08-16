# Dependency merge policy

Status: **selective-automerge candidate held; no consumer is activated**

`default.json` is the shared human-merge baseline. The separately released
`low-risk-automerge` named preset is a complete standalone opt-in; a consumer
must pin its immutable release and independently prove every activation gate
recorded in `automerge-consumers.json`.

| Update class | Maturity | Merge authority | Required developer action |
| --- | --- | --- | --- |
| Stable npm `devDependencies` patch/minor | 14 days with strict internal checks | Renovate only after the exact required-check inventory, current-head enforcement, and pristine-branch integrity check pass | None unless behavior changes or a gate fails |
| Vulnerability alert | Immediate PR; normal age/rate limits bypassed | Human | Review vulnerability, fix version, urgency, and all required checks |
| Major or any `0.x` update | Normal applicable floor | Human | Review migration and compatibility |
| Production, peer, or optional dependency | Normal applicable floor | Human | Review API, runtime, and deployment effects |
| Action, runtime, package manager, dependency automation, image, cloud, database, authentication, or deployment tooling | Normal applicable floor | Human | Review provenance, permissions, platform, and affected environment proof |
| Replacement or migration | No universal age claim | Human | Review source and generated changes as a migration |
| Lockfile maintenance | Package-manager resolution policy; no universal Renovate release-age claim | Human | Confirm manifests did not change and inspect the transitive resolution |
| Agent-remediated Renovate branch | New SHA invalidates automatic eligibility | Human successor or a fresh pristine Renovate PR | Re-run all required proof from the new SHA |

The eligible `devDependencies` class can include compilers, linters, test
runners, formatters, and build tools when they are stable npm dependencies and
no later consumer rule excludes them. Runtime and package-manager identities,
Renovate and its runner infrastructure, Actions, majors, and `0.x` releases do
not become eligible merely because a repository declares them as development
dependencies.

## Enforcement boundary

Labels and PR notes explain the classification; they never grant or revoke
merge authority. The resolved Renovate `automerge` option is necessary but not
sufficient. Each opted-in repository must also enforce all of the following on
the exact pull-request head:

- the enumerated required check names under an identified ruleset or branch
  protection rule;
- proof that those checks run for Renovate-owned dependency paths and cannot be
  skipped by path filtering;
- the repository's canonical aggregate gate;
- a pristine-branch integrity check proving only the permitted Renovate update
  and generated artifacts are present and no human or AI-authored commit was
  added;
- a consistently reported artifact-error status when artifact generation is
  part of the repository's update contract.

An AI review comment is advisory. Applying an AI suggestion or any other
foreign commit fails pristine-branch eligibility. The repository either asks
Renovate to recreate a pristine PR or opens a separately owned manual successor.
`stop-updating` can prevent further Renovate branch updates; it does not disable
an already-resolved `automerge: true` setting and is not an enforcement gate.

## Activation and rollback

Consumers activate one at a time only after the immutable preset tag, commit,
tree, policy digest, resolved-config digest, protection identity, exact check
inventory, pristine-branch check, live PR receipt, and rollback are recorded.
Until then their registry state remains `human-merge`. Rollback removes the
named preset reference and returns to the pinned human-merge `default` preset.
