# Verification contract

Status: active

This document owns the mechanics of proof in this repository. `AGENTS.md`
carries only the selection rule an agent needs before running anything; the
detail below explains what the selected command actually binds, so the root
instructions do not have to.

## Selecting proof

Finish the accepted implementation and inspect the complete diff before
starting expensive proof. During implementation, use the smallest focused check
that answers the immediate question.

Final proof chooses exactly one path:

- an ordinary scoped change runs its affected checks once;
- receipt code, workflow routing, runtime policy, release, or another
  cross-cutting change runs only `pnpm verify` once.

Do not run either constituent command immediately before `pnpm verify` as
duplicate final proof. When full proof finds one defect, fix it, use the
focused check to diagnose, then rerun full proof once on the unchanged final
tree.

An explicit owner instruction to pause before verification overrides this
ladder. While the hold is active, inspect source and diffs but do not run
tests, linters, formatters, hooks, validators, builds, or proof commands.
Before asking to resume, present the exact proposed commands, estimated
durations, overlap or duplication, whether each is diagnostic or final proof,
and the tree identity it will prove.

Release publication has two additional read-only gates. `release:preflight`
binds the clean intended SHA, absent tag, active GitHub release controls,
bootstrap-freeze state, authoritative exact-SHA CI receipt, and exactly one
canonical `pnpm verify`; it must not be paired with a separate final verify.
After the owner publishes the immutable GitHub Release, `release:verify` binds
the remote tag to that SHA, checks immutable release state, compares tagged
`default.json` with the expected commit rather than the moving default branch,
and resolves the version-pinned preset through the pinned Renovate runtime.

## What `pnpm verify` binds

`pnpm verify` fingerprints the exact Git HEAD, index, and Git-visible working
tree, plus the bounded, explicitly named ignored verification outputs that can
affect the proof. It then runs complementary `pnpm test` and `pnpm validate`
lanes concurrently with separate output and statuses, rejects dependency
artifacts, checks the final fingerprint, and prints one wall-time and
critical-path receipt.

Canonical validation includes the external-configuration registry and every
workflow delivery it governs. Registry parity is required proof: missing,
unclassified, ambiguous, shadowable, or unused required deliveries fail the
validation lane.

For caller-delivered settings, this validation proves the called-workflow
interface and use of each named input or secret. Registry `sourceScopes` declare
the permitted caller-side scope; they are not an observation of the private
caller. That repository must independently prove its source scope, explicit
named delivery, and prohibition on `secrets: inherit`.

The implementation tree need not be clean; it must be unchanged by proof.
Arbitrary ignored caches, worktrees, and `.env*` files are outside this
identity contract and are never read.

An event-loop-independent parent watchdog puts the complete transaction,
including both synchronous fingerprints, under a 300-second hard deadline. It
cancels both persistent process-group supervisors with bounded TERM/KILL
cleanup; each supervisor stays alive until command status and descendant
closure are resolved.

For a machine-readable local handoff, add
`--report /absolute/path/outside/the/repository.json`. That JSON remains
non-reusable evidence for the exact observed local tree.

## Proof reuse

The current `pnpm verify` receipt binds the observed local tree before and
after the run but is deliberately marked not reusable: there is no persisted
hook adapter binding every configuration, toolchain, suite-version, and
platform input yet. Exact-SHA CI proof is reusable only for that exact SHA; any
missing identity makes a prior receipt context only.

For an owner-authorized publish, reconcile the complete index and create the
intended local commit before final proof. Run `pnpm verify` on that exact clean
commit, then make no source, index, or history change before push. A
modified-tree receipt can support diagnosis or handoff, but it cannot prove a
commit created afterward.

## Reporting

At handoff name the affected surfaces and commands, why the selected proof
covers them, and any repository-wide contract that scoped proof did not
exercise. Report best-effort implementation time, measured verification and
hook time, every command and duration, the slowest check, reruns, duplicate
proof time, invalidated verification time, and whether the final tree is what
passed. When implementation was continuous enough to make the comparison
meaningful, include the verification-to-implementation ratio.

Flag a command over 5 minutes, hook over 1 minute, or final sequence over 10
minutes as advisory waste to fix, never as a reason to weaken a gate. The
`pnpm verify` target is 4 minutes. Treat the first five representative
final-tree runs as advisory baseline evidence; a later regression creates a
productivity warning and backlog item, not permission to remove proof.

## Hooks

Hooks, if added, stay staged-only under 10 seconds for pre-commit and
affected-only under 2 minutes for pre-push. Full validation, Docker, and live
provider or network proof remain explicit commands or CI work.

## Cross-repository compatibility

Cross-repository compatibility is a mapping, not shared code in this
repository: outcome; exact SHA or content-addressed tree; command and proof
type; duration and slowest phases; cache state; and invalidation state. This
repository's narrow `renovate-config.run-receipt` maps those fields locally.
Groundwork owns the experimental typed contract, and Roost keeps its richer
`CiReport` until a neutral utility has been field-proven and deliberately
extracted.
