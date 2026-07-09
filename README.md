# Renovate Config

Shared dependency-update automation for the owner's repositories.

This repo has three moving pieces:

- `default.json` is the shared Renovate preset consumed by owner repos such as
  `jasondockery/roost` and `jasondockery/groundwork`.
- `runner.json` is the self-hosted Renovate runner config. It contains only
  runner behavior, not dependency policy.
- `.github/workflows/renovate.yml` runs self-hosted Renovate on a fixed cadence
  plus manual dispatch, with logs in GitHub Actions.

## Runner identity & permissions

The runner authenticates as a **GitHub App** (decided 2026-07-09). The
first identity was a fine-grained PAT, and it hit a hard wall: personal
accounts cannot grant a fine-grained PAT the **Checks** permission at
all (the permission picker simply doesn't offer it), so Renovate got 403
from the check-runs API, scored every branch "yellow" forever, and
automerge silently never fired while PRs looked green in the UI
(field-hit on roost PR #24). GitHub Apps have the Checks permission and
mint short-lived installation tokens — strictly better posture than any
long-lived PAT.

App setup (owner, one-time):

1. GitHub → Settings → Developer settings → GitHub Apps → New GitHub App.
   Use these form values:
   - **GitHub App name:** `jasondockery_renovate`.
   - **Description:** `Self-hosted Renovate runner for jasondockery repos.`
   - **Homepage URL:** `https://github.com/jasondockery/renovate-config`
   - **Callback URL:** leave blank; this runner does not use user OAuth.
   - **Expire user authorization tokens:** leave the default checked. It is
     irrelevant while user OAuth is disabled.
   - **Request user authorization (OAuth) during installation:** unchecked.
   - **Enable Device Flow:** unchecked.
   - **Webhook:** inactive/unchecked — the runner is cron/dispatch, not
     event-driven.
   - **Where can this GitHub App be installed?:** Only on this account.
2. Repository permissions — this is the full set Renovate needs:
   - **Checks: Read-only** (read CI check runs — the reason the App
     exists; automerge is blind without it)
   - **Commit statuses: Read and write** (read/post commit statuses,
     e.g. its own `renovate/` stability statuses)
   - **Contents: Read and write** (create branches/commits)
   - **Dependabot alerts: Read-only** (the vulnerability lane's data
     source)
   - **Issues: Read and write** (Dependency Dashboard)
   - **Metadata: Read-only** (mandatory, GitHub adds it)
   - **Pull requests: Read and write** (open/update/automerge PRs)
   - **Workflows: Read and write** (update `.github/workflows/` files —
     action SHA bumps live there)
3. Generate a private key (downloads a `.pem`).
4. Install the App on exactly `renovate-config`, `roost`, and
   `groundwork` — never "all repositories"; the install list is the
   blast-radius boundary.
   - First-time path after creating the app: open the app's settings page,
     choose **Install App** in the left sidebar, then choose
     **Install** next to `jasondockery`.
   - If you are already on GitHub settings later:
     Settings → Applications → Installed GitHub Apps → find this app →
     **Configure**. Ignore unrelated installed apps such as Netlify,
     Railway, or Vercel.
   - On the install/configure screen, choose **Only select repositories**.
   - Select exactly:
     - `jasondockery/renovate-config`
     - `jasondockery/roost`
     - `jasondockery/groundwork`
   - Save with **Install** or **Save**. If a new owner repo should be
     managed later, add it here and update `RENOVATE_REPOSITORIES` in the
     workflow in the same change.
5. In this repo's `renovate` environment, add secrets:
   - `RENOVATE_APP_CLIENT_ID`: the Client ID from the app's settings/About
     page. This is not the numeric installation ID in a URL such as
     `/settings/installations/<installation-id>`; that URL identifies one
     installation, not the app identity used by the token action.
   - `RENOVATE_APP_PRIVATE_KEY`: the full `.pem` contents.

   `actions/create-github-app-token` still accepts its legacy `app-id`
   input, but its current docs recommend `client-id`, so this repo uses
   the client ID secret directly.

Those two App secrets are required: the workflow no longer has a PAT
fallback. The retired `RENOVATE_TOKEN` PAT secret and obsolete
`RENOVATE_APP_ID` secret should stay deleted. Note the identity switch
changes Renovate's git author to `<app-slug>[bot]` — existing open
Renovate branches authored by the PAT identity will read as "edited by
someone else" and block; tick their rebase checkbox once (or close them
and let Renovate recreate).

## Bootstrap (completed 2026-07-08 — kept as the recipe)

1. Create a GitHub environment named `renovate`.
2. Configure the runner identity per "Runner identity & permissions"
   above (originally a fine-grained PAT as `RENOVATE_TOKEN`; superseded
   by the GitHub App for the Checks gap documented there).
3. Push this repo, then run the `Renovate` workflow manually with
   `log_level=debug` for the first proof run.

The migration is done: the proof PRs went green through roost's gate with
complete lockfile artifacts (roost #23 merged 2026-07-09), and hosted Mend
was uninstalled with its leftovers closed. The `self-hosted-renovate/`
branch prefix stays permanently — `runner.json` pins `branchPrefixOld`
equal to `branchPrefix` so the runner never adopts foreign branches (a
field-hit failure mode; see its description).

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
