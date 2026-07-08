# Renovate Config

Shared dependency-update automation for the owner's repositories.

This repo has three moving pieces:

- `default.json` is the shared Renovate preset consumed by owner repos such as
  `jasondockery/roost` and `jasondockery/groundwork`.
- `runner.json` is the self-hosted Renovate runner config. It contains only
  runner behavior, not dependency policy.
- `.github/workflows/renovate.yml` runs self-hosted Renovate on a fixed cadence
  plus manual dispatch, with logs in GitHub Actions.

## Bootstrap

1. Create a GitHub environment named `renovate`.
2. Add `RENOVATE_TOKEN` as an environment secret. Use a fine-grained PAT scoped
   only to `jasondockery/renovate-config`, `jasondockery/roost`, and
   `jasondockery/groundwork`, with Renovate's documented permissions.
3. Push this repo, then run the `Renovate` workflow manually with
   `log_level=debug` for the first proof run.

During the migration, the first proof should produce a Roost PR with complete
lockfile artifacts. The self-hosted runner uses the `self-hosted-renovate/`
branch prefix so it cannot fight hosted Mend Renovate branches. Only deactivate
hosted Mend after the self-hosted proof PR is green.

## Toolchain

This repo follows Roost's project-local toolchain pin:

- Node `24.18.0` via `.nvmrc` (Renovate 43.x requires Node ^24.11.0).
- No installed dependencies: CI runs the validator
  via `npx` with an exact version.

CI validates with Renovate `43.251.3`, matching the runner's
`renovate-version`; every copy of the pin (including `package.json`'s
`validate` script) is tracked by this repo's own Renovate custom manager
so they cannot drift silently.

Validation failures annotate the run with the exact command to reproduce
locally, and every CI and Renovate run writes a pass/fail job summary so
scheduled runs are triageable at a glance.

## Policy Boundary

`default.json` contains only policy that should remain identical across owner
repos: schedule, cooldown, PR limits, rebase behavior, labels, and the security
PR base. Repo-specific package rules stay local in each consumer.

The runner explicitly targets:

- `jasondockery/renovate-config`
- `jasondockery/roost`
- `jasondockery/groundwork`

No autodiscovery is used.

## Can others use this?

Copy, yes; depend on, no. This repo is owner infrastructure: the preset
encodes one owner's policy and may change without notice, so extending
`github>jasondockery/renovate-config` from repos outside this owner's set
is not supported — fork or copy the files instead (MIT licensed).
Repos scaffolded by Roost get their own full Renovate config copy by
design, so they own their policy and their bot. If a maintained,
versioned shared preset ever ships, it will be a deliberate Roost module
with tagged releases, not this repo.
