# Renovate Config

Shared dependency-update automation for the owner's repositories.

This repo has four moving pieces:

- `default.json` is the shared Renovate preset consumed by owner repos such as
  `jasondockery/roost` and `jasondockery/groundwork`.
- `runner.json` is the self-hosted Renovate runner config. It contains only
  runner behavior, not dependency policy.
- `.github/workflows/renovate.yml` runs self-hosted Renovate on a fixed cadence
  plus manual dispatch, with logs in GitHub Actions.
- `.github/workflows/security-hygiene.yml` is the public reusable
  implementation of the read-only security inbox for the same three
  repositories. A private caller owns all execution and output.

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
2. Repository permissions — this is the exact installation grant used by this
   deployment. `tools/security-policy.mjs` is the machine-readable source and
   tests bind it to both token workflows and this table:

   | Permission | Access | Used by |
   | --- | --- | --- |
   | Administration | Read-only | Renovate: read repository settings and branch protection |
   | Checks | Read and write | Renovate: read and publish check runs |
   | Commit statuses | Read and write | Renovate: read and publish stability statuses |
   | Contents | Read and write | Renovate: create branches and commits |
   | Dependabot alerts | Read-only | Renovate and hygiene Dependabot source |
   | Issues | Read and write | Renovate Dependency Dashboard |
   | Metadata | Read-only | All App tokens; mandatory repository metadata |
   | Pull requests | Read and write | Renovate: create and update PRs |
   | Workflows | Read and write | Renovate: update action SHA pins |
   | Code scanning alerts | Read-only | Hygiene code-scanning source |
   | Secret scanning alerts | Read-only | Hygiene secret-scanning source |

   Renovate documents **Members: Read-only** for team assignment and member
   lookup. This deployment intentionally does not assign teams or rely on that
   lookup, so the App does not receive Members permission. If that behavior is
   added, widen the policy, workflow, installation grant, and this table in one
   reviewed change.
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
fallback. The retired PAT secret and obsolete `RENOVATE_APP_ID` secret
should stay deleted. Note the identity switch
changes Renovate's git author to `<app-slug>[bot]` — existing open
Renovate branches authored by the PAT identity will read as "edited by
someone else" and block; tick their rebase checkbox once (or close them
and let Renovate recreate).

## Bootstrap (completed 2026-07-08 — kept as the recipe)

1. Create a GitHub environment named `renovate`.
2. Configure the runner identity per "Runner identity & permissions"
   above (originally a fine-grained PAT; superseded by the GitHub App
   for the Checks gap documented there).
3. Push this repo, then run the `Renovate` workflow manually with
   `log_level=debug` for the first proof run.

The migration is done: the proof PRs went green through roost's gate with
complete lockfile artifacts (roost #23 merged 2026-07-09), and hosted Mend
was uninstalled with its leftovers closed. The `self-hosted-renovate/`
branch prefix stays permanently — `runner.json` pins `branchPrefixOld`
equal to `branchPrefix` so the runner never adopts foreign branches (a
field-hit failure mode; see its description).

## Toolchain

This repo follows Roost's portable project-local toolchain contract:

- Node `24.18.0` from canonical `.node-version` (Renovate 43.x requires Node
  ^24.11.0). `.nvmrc`, `mise.toml`, `package.json`, and CI are synchronized
  adapters for nvm, fnm, mise, Volta/manual installs, and GitHub Actions.
- pnpm `11.9.0` from `packageManager`, mirrored in `engines` and `mise.toml`.
- `pnpm-workspace.yaml` disables pnpm 11's implicit install-before-run behavior
  and module-directory writes; this dependency-free repository's `pnpm test`
  and `pnpm validate` commands must not create a lockfile, `node_modules`, or
  local store. `pnpm verify` accepts an implementation tree with staged,
  unstaged, and untracked work, fingerprints exact Git-visible state plus a
  bounded list of named ignored verification outputs before and after, and
  requires that baseline to remain unchanged. It does not enumerate or read
  arbitrary ignored caches, worktrees, or `.env*` files. It refuses
  pre-existing dependency artifacts before launch, runs the complementary
  contracts concurrently through persistent process-group supervisors. An
  event-loop-independent parent watchdog bounds the complete transaction,
  including both synchronous fingerprints, at five minutes and prints
  wall-clock time separately from aggregate compute time. CI runs tests and
  validation as parallel visible jobs, applies the stricter clean-checkout
  proof to each, and aggregates them with CI-only workflow security behind
  stable `ci-gate`.
  Add `-- --report /absolute/path/outside/the/repository.json` to persist the
  same local receipt atomically for a machine-readable handoff; it remains
  non-reusable evidence for only the observed local tree.
- `node tools/check-toolchain.mjs` fails early on declaration, runtime, package
  manager, or CI drift and offers manager-neutral recovery commands.
- `.renovate-version` is the one canonical Renovate runtime pin. Both the
  self-hosted action and `tools/validate-renovate.mjs` resolve that file; the
  repo's custom manager updates the file rather than synchronizing copies.
- No installed dependencies: `pnpm validate` invokes the exact pinned Renovate
  distribution through `npx` with `--strict`, validating `default.json` and
  `renovate.json` as repository configuration and `runner.json` as self-hosted
  global configuration. The validator subprocess removes ambient
  `RENOVATE_*` variables, and the runtime guard rejects accidental
  `config.js`/`config.cjs`/`config.mjs` global configuration.

Validation failures annotate the run with the exact command to reproduce
locally, and every CI and Renovate run writes phase timings plus a pass/fail job
summary so scheduled runs are triageable at a glance.

Renovate's temporary debug JSONL is streamed under explicit file, line-count,
line-size, and parse-time limits, then deleted before the sanitized receipt is
published. Global ERROR/FATAL records and unexpected-repository timing,
warning, or error evidence fail closed; a well-formed unexpected informational
record is counted as advisory. The parser shape is pinned by the sanitized
fixture whose filename is derived from `.renovate-version`, plus its
immutable-source provenance note under `tools/fixtures/`. A runtime pin bump
fails validation until the matching fixture is deliberately accepted.

## Versioning

`package.json` stays private at `0.0.0`; it is tooling metadata, not the shared
preset's release version. The preset itself ships as immutable SemVer tags
without a `v` prefix, and consumers pin an exact tag such as
`github>jasondockery/renovate-config#1.0.0`.

The initial pinning bootstrap is in progress. Until the owner tags `1.0.0`,
proves that released reference resolves, and moves all three consumers to it,
`.preset-bootstrap-freeze` keeps `default.json` unchanged. See `ROADMAP.md` for
the ordered owner gates and `CONTRIBUTING.md` for the release procedure.

## Policy Boundary

`default.json` contains only policy that should remain identical across owner
repos: schedule, cooldown, PR limits, rebase behavior, labels, and the security
PR base. Repo-specific package rules stay local in each consumer.

The runner explicitly targets:

- `jasondockery/renovate-config`
- `jasondockery/roost`
- `jasondockery/groundwork`

No autodiscovery is used.

The self-hosted global config permits one post-upgrade command:
`node tools/renovate-format-artifacts.mjs`. The anchored `allowedCommands`
regular expression accepts that exact entry point with no arguments, and the
shell executor remains disabled. Those controls reduce command-injection
exposure; they do not make a repository-owned script intrinsically safe.

The permission is global for this runner. Any targeted repository could
authorize code by adding the same path and command, and that code executes in
Renovate's trust context. All three targeted repositories and their maintainers
therefore share one execution trust boundary. Changes to `runner.json`, the
Roost formatter, or Roost's `postUpgradeTasks` require owner review; unrelated
secrets or environment variables must not be forwarded into the Renovate
process. If maintainer trust ever differs between consumers, Roost moves to a
separate runner configuration. Roost owns the formatter and its file filters;
this repository owns the global runner-side permission.

## Security hygiene

The `security-hygiene` workflow is the public reusable implementation of the
cross-repository security inbox. It reads Dependabot, code-scanning, and
secret-scanning alerts for the three targeted repositories. Because this repo
is public and a consumer is private, it cannot dispatch or schedule that work:
a private security-operations caller owns the App secrets, runs, summaries,
artifacts, and one durable issue ("Security hygiene report", label
`security-hygiene`). The implementation's first step queries the caller's
visibility and fails closed before checkout or token mint unless it is private.
Ownership split:
GitHub detects and tracks findings; Renovate proposes dependency-update PRs
(security PRs immediately, bypassing the cooldown); workflow and token
findings are repository code, fixed in the repository that owns them. The
report only keeps everything visible — it never dismisses or remediates.

SLA and source-coverage policy are canonical in `tools/security-policy.mjs`;
this table is a tested human-readable rendering:

| Source | Severity | Resolve within |
| --- | --- | --- |
| Dependabot | critical | 1 day |
| Dependabot | high | 7 days |
| Dependabot | medium | 30 days |
| Dependabot | low | 90 days |
| Code scanning | security severity | same as Dependabot |
| Code scanning | error / warning / note (tool level) | 7 / 14 / 30 days |
| Secret scanning | any open alert | immediately — rotate the credential; removing it from code is not remediation |

Unknown severity is triaged like high. The report command returns 2 for overdue
findings and 3 for monitor blindness. The workflow records both states, attempts
the durable issue and complete artifact deliveries independently, and then
fails its enforcement step. The issue receives either or both
`security-overdue` and `security-monitor-broken` state labels as applicable. A
dismissal needs a reason, owner, evidence, and review date — never dismiss to
reach zero.

The private caller remains manual-only until the owner completes the
permission, alert triage, Renovate dispatch, and two-run delivery proof in
[`docs/runbooks/security-hygiene.md`](docs/runbooks/security-hygiene.md). That
runbook is also the canonical exit-code table, DEGRADED triage guide, dismissal
record, unable-to-meet-SLA procedure, and pinned caller template. Any later
daily schedule belongs in that private caller, never in this public workflow.

## Can others use this?

Copy, yes; external dependency, no. This repo is owner infrastructure: tagged
releases make policy changes reviewable for the enumerated owner repositories,
but extending `github>jasondockery/renovate-config` from repositories outside
that set is not supported — fork or copy the files instead (MIT licensed).
Repos scaffolded by Roost get their own full Renovate config copy by
design, so they own their policy and their bot.
