# Renovate system acceptance

Status: active

Owner: repository owner

Created: 2026-08-03

Last reviewed: 2026-08-03

Dependencies: released shared preset; GitHub App installed on the three
consumers; private canary owner approval

Next action: review and land the local contract, audit, inventory, extraction,
and daily-schedule slice without claiming live acceptance

Exit condition: every acceptance-matrix row in
`specs/renovate-system-acceptance.md` has durable evidence, the first canary and
all three eligible consumer PR paths are green, and remaining knowledge has been
promoted to the charter, spec, or runbook

## Outcome

Prove the dependency system from release detection through correct green
consumer pull requests. A green runner alone is an intermediate result.

## Local implementation

- [ ] Guard the once-daily runner schedule, weekly routine update/branch window,
      and strict five-day age for supported normal update surfaces.
- [x] Record the in-principle design approval for
      `specs/preset-freeze-exception.md`; keep activation and the checksum
      change behind the separate owner-approved policy commit.
- [ ] Keep offline static validation and required pinned-Renovate fixture and
      config validation separate from the owner-gated policy proposal and
      manual-only latest-head actual-repository compatibility watch.
- [ ] Add the read-only `pnpm renovate:audit --run <run-id>` command and hostile
      fixture coverage for malformed receipts, stale dashboards, schedule
      misses, orphan branches, and failed PR checks.
- [ ] Add machine-checked dependency inventories to all three repositories.
- [ ] Run pinned Renovate extraction against representative npm, Dockerfile,
      Compose, GitHub Actions, nodenv, mise, renovate-config, runner-label,
      Renovate-runtime regex, and Roost OpenNext-regex fixtures, then map the
      actual three checkouts to their inventories, record exact starting and
      ending identities, and reject any checkout mutation.
- [ ] Land the green sequence below. Keep compatibility `manual-only` while the
      consumer inventories and renovate-config tooling are reviewed; activate
      its schedule only after both inventories exist on their default branches.
- [ ] Record the current Roost PR #35/#36 evidence: both closed unmerged after
      the shared base lint defect, both branches still present without open
      PRs, and the next weekly run must recreate current PRs after the lint fix.

## Green landing plan

Each row is an independent commit. Stage only the named concern, create the
commit, and run the listed proof on that exact clean commit before pushing it.
Do not reuse a working-tree proof for a later commit. Required exact-SHA CI must
pass before the next repository depends on that commit.

| Order | Commit boundary | Exact-commit proof before push | Promotion gate |
| ---: | --- | --- | --- |
| 1 | Roost `packages/folio-search/src/ranking.test.ts` lint repair | `pnpm --filter @roost/folio-search lint` | Roost exact-SHA CI green |
| 2 | Roost thesis, dependency inventory, inventory tests, and inventory documentation | `pnpm roo verify` | Roost exact-SHA CI green; inventory present on `main` |
| 3 | Groundwork thesis, dependency inventory, inventory validation, and dependency documentation | `bash -n scripts/validate-groundwork`, then `scripts/validate-groundwork --suite full --report /tmp/groundwork-renovate-inventory.json` | Groundwork exact-SHA `full-gate` green; inventory present on `main` |
| 4 | renovate-config thesis, dependency schema, acceptance contracts, extraction/scanner/audit/receipt tooling, and **manual-only** compatibility workflow; exclude every preset-proposal file and package script | `pnpm verify --report /tmp/renovate-config-tooling.json` | renovate-config exact-SHA CI green |
| 5 | Groundwork Gitleaks visible tag-and-digest correction and its validator guard | `bash -n scripts/validate-groundwork`, then `scripts/validate-groundwork --suite full --report /tmp/groundwork-gitleaks.json` | Groundwork exact-SHA `full-gate` and secret scan green |
| 6 | Groundwork validation-deadline Bash compatibility correction and regression | `bash -n scripts/test-validation-deadline scripts/validate-groundwork`, then `scripts/validate-groundwork --suite full --report /tmp/groundwork-validation-deadline.json` | Groundwork exact-SHA `full-gate` green |
| 7 | Compatibility activation only: switch `compatibility-targets.json` to `scheduled` and add the guarded schedule | `pnpm verify --report /tmp/renovate-config-compatibility-activation.json` | renovate-config exact-SHA CI green, then one green latest-head compatibility receipt against the live consumer inventories |
| 8 | Owner-approved preset exception only: exception spec, isolated fixture, effective-policy checker/command, reviewed `default.json`, and freeze checksum | `pnpm verify --report /tmp/renovate-config-preset.json`; separately run `pnpm renovate:policy-proposal` as the non-duplicated effective-policy field proof | renovate-config exact-SHA CI green and owner acceptance recorded |
| 9 | Roost root and generated-project policy parity, policy regression test, and changeset | `pnpm roo verify` | Roost exact-SHA CI green |
| 10 | Canary and live acceptance evidence; no product-source commit merely to record a green runner | `pnpm renovate:audit --run <run-id>` plus the canary/consumer CI named in the acceptance matrix | canary, all three eligible consumer PR paths, cleanup receipt, and audit classification accepted |

Rows 3, 5, and 6 touch separate hunks in `scripts/validate-groundwork`; reconcile
and stage those hunks independently. Row 8 is the only row allowed to change
the frozen preset checksum. The accepted `default.json` remains byte-identical
to its current freeze through rows 1–7.

## Owner-gated canary

- [ ] Create private `jasondockery/renovate-canary` from the canary contract in
      `specs/renovate-system-acceptance.md`.
- [ ] Install the GitHub App on that repository with no broader repository
      access.
- [ ] Review the exact runner and receipt change that includes the canary only
      for explicit acceptance dispatches.
- [ ] Seed one exact outdated npm dependency with an older-than-five-days target,
      committed lockfile, frozen-install CI, and one behavior assertion.
- [ ] Dispatch inside an allowed test window and record branch, PR, manifest,
      lockfile, and green-CI evidence.
- [ ] Record that the canary proves only npm; other manager families retain
      extraction and real-consumer acceptance rows.
- [ ] Change the canary's available target, prove the same PR refreshes, close
      it, and prove recreation from current `main`.

## Production field proof

- [ ] Run the daily workflow and retain its sanitized receipt.
- [ ] Run `pnpm renovate:audit --run <run-id>` and record one unambiguous state
      for every consumer.
- [ ] For renovate-config, accept one eligible PR with required CI green.
- [ ] For Roost, accept one eligible PR with the catalog, lockfile, generated
      artifact formatter, and required CI green.
- [ ] For Groundwork, accept one eligible PR with every changed pin/comment or
      image digest and required CI green.
- [ ] Prove one controlled security update bypasses the normal age and weekly
      schedule without bypassing consumer CI.
- [ ] Record raw-log deletion, private-directory removal, and sanitized-only
      artifact publication.

## Retirement

Do not keep this playbook as permanent parallel policy. Once its exit condition
is met, move only durable operational details into the canonical spec or README,
record the final evidence links in `ROADMAP.md`, and delete this execution file.
