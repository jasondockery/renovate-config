# Renovate Config

Shared dependency-update automation for the owner's repositories.

This repo has two jobs:

- `default.json` is the shared Renovate preset consumed by owner repos such as
  `jasondockery/roost` and `jasondockery/groundwork`.
- `.github/workflows/renovate.yml` runs self-hosted Renovate on a fixed cadence
  plus manual dispatch, with logs in GitHub Actions.

## Bootstrap

1. Create a GitHub environment named `renovate`.
2. Add `RENOVATE_TOKEN` as an environment secret. Use a fine-grained PAT scoped
   only to `jasondockery/renovate-config`, `jasondockery/roost`, and
   `jasondockery/groundwork`, with Renovate's documented permissions.
3. Push this repo, then run the `Renovate` workflow manually with
   `log_level=debug` for the first proof run.

The first proof should rebuild Roost PR #2 with complete lockfile artifacts.
Only deactivate hosted Mend after that proof is green.

## Toolchain

This repo follows Roost's project-local toolchain pin:

- Node `24.18.0` via `.nvmrc` (Renovate 43.x requires Node ^24.11.0).
- No package manager: this repo has no dependencies; CI runs the validator
  via `npx` with an exact version.

CI validates with Renovate `43.253.2`, matching the runner's
`renovate-version`; both pins are tracked by this repo's own Renovate
custom manager so they cannot drift silently.

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
