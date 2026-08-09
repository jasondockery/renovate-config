# Security hygiene runbook

This runbook owns launch and incident handling for the cross-repository
security-hygiene monitor. `tools/security-policy.mjs` remains the
machine-readable source for repositories, expected sources, SLAs, App token
scopes, labels, and report-command exit codes.

This public repository owns implementation, not security output. The reusable
workflow has no dispatch or schedule trigger and refuses to run unless GitHub
reports that its caller repository is private. The private caller owns the App
credentials, run history, job summaries, artifacts, labels, and durable issue.
It is intentionally manual-only until the launch checklist is complete. Do not
add the daily cron merely because local tests are green.

## Private caller

Create a private security-operations repository. Store
`RENOVATE_APP_CLIENT_ID` as a repository or organization variable and
`RENOVATE_APP_PRIVATE_KEY` as a repository or organization secret. Reusable
workflows cannot receive environment secrets from the called workflow, so do
not depend on this public repo's `renovate` environment.

This is a second delivery context for one credential contract, not a second App
identity. The public repository registry records both contexts; the caller owns
the repository/organization values and passes them explicitly.

The public repository can prove only the called workflow's declared interface
and its use of each named setting. The private caller must independently check
that each value comes from an allowed repository or organization scope, that
both deliveries are named explicitly, and that its workflows contain no
`secrets: inherit`.

When migrating an existing caller, first prove the central Renovate and
compatibility workflows with the new environment variable. Then create the
caller-owned Client ID variable, repin the caller to that exact proven
renovate-config SHA, and prove this reusable workflow before deleting the old
caller Client-ID secret. A caller pinned to an older SHA keeps using that
version's secret contract until it is deliberately repinned.

Its launch workflow should have this shape, replacing both placeholders with
the same reviewed 40-character commit SHA:

```yaml
name: Security hygiene

on:
  workflow_dispatch:

permissions:
  contents: read
  issues: write

jobs:
  report:
    uses: jasondockery/renovate-config/.github/workflows/security-hygiene.yml@<40-character-commit-sha>
    with:
      implementation_ref: <same-40-character-commit-sha>
      RENOVATE_APP_CLIENT_ID: ${{ vars.RENOVATE_APP_CLIENT_ID }}
    secrets:
      RENOVATE_APP_PRIVATE_KEY: ${{ secrets.RENOVATE_APP_PRIVATE_KEY }}
```

The duplicate pin is deliberate: `uses:` chooses the reviewed reusable
workflow, while `implementation_ref` pins the checkout and is validated before
any security data is collected. Never substitute a branch or movable tag.

## First-run owner gates

Complete these in order:

1. Create the private caller above and confirm its repository visibility is
   private. Dispatching from this public repository is prohibited.
2. Grant the GitHub App the exact permission union documented in the README.
   A token mint failure is a deployment failure; do not reduce the workflow's
   Administration or Checks scopes to match a stale installation.
3. Decide the secret-validity posture for each supported repository. Enable
   secret-scanning validity checks where available, or accept that the report
   will say `validity: not evaluated/available`.
4. Triage every currently open alert, critical first. Assign an owner and link
   a remediation PR, or record why no automatically expressible update exists.
   A real overdue result is a successful monitor receipt, not a reason to
   weaken the SLA.
5. Manually dispatch Renovate with `log_level=debug` using the final App
   installation. Confirm every target repository is reached and a security PR
   appears wherever Renovate can express a fix. Transitive lockfile findings
   may require a direct dependency update or an explicit package-manager
   override.
6. From the private caller, at the exact merged security-hygiene commit,
   dispatch the hygiene workflow twice. The first run must create one private
   issue; the second must update that same issue. Record the private run URLs
   and commit SHA.
7. Prove a required disabled source breaks the monitor, Roost's
   expected-disabled sources are accepted only through verified source-specific
   responses, both state labels can coexist, and a token-mint failure still
   updates the issue as DEGRADED.
8. Prove the issue and artifact are independent deliveries. Confirm the
   complete artifact contains all fetched alerts and the bounded issue/summary
   state exact omission counts.
9. Only after the receipts above, add the daily `17 5 * * *` schedule to the
   private caller and update `ROADMAP.md`. Never add it to the public reusable
   implementation.

## Report-command exit contract

This table is a human rendering of `REPORT_EXIT_CODES` in
`tools/security-policy.mjs`.

| Code | Name | Meaning | Workflow handling |
| --- | --- | --- | --- |
| 0 | success | Monitor readable; no overdue finding | Deliver and remain green |
| 1 | runtimeFailure | Unexpected crash or invalid authoritative state | Fail immediately |
| 2 | overdue | At least one alert is past its exact SLA | Deliver, then fail enforcement |
| 3 | monitorBroken | A required source is unreadable or coverage regressed | Deliver, then fail enforcement; overdue state remains independent |
| 64 | usage | Caller supplied an invalid repository-scope assertion or CLI arguments | Fail immediately |

## When the report says DEGRADED

DEGRADED means findings may be invisible. It never means zero alerts.

1. Read the Monitor health line for the repository, source, HTTP status, and
   accepted-permission hint.
2. If the reason is `token mint failed`, compare the installation grant with
   the README table and the token inputs in both workflows. Approve the grant
   before retrying.
3. If the repository cannot be read, verify the App remains installed on the
   exact three repositories.
4. For code scanning, only a 403 beginning with GitHub's known
   `Code scanning is not enabled for this repository.` response plus a readable
   repository proves disabled. Other 403s remain unavailable.
5. For secret scanning, a 404 plus a readable repository proves the documented
   disabled/public response. A 404 alone remains unavailable.
6. Change `SOURCE_POLICY` only when the intended product coverage changes.
   Never mark a required source expected-disabled to clear a transient error.

## Overdue-alert triage

For every overdue alert:

1. Confirm severity, affected dependency or rule, patched version, and exact
   deadline.
2. Assign one human owner.
3. Link the remediation PR or issue.
4. If Renovate produced no PR, inspect the debug run for repository reach,
   permission, constraint, and fix-availability evidence.
5. Resolve or explicitly record the blocker. Keep the monitor red while the
   alert remains overdue.

### Unable to meet an SLA

Do not extend the SLA or dismiss an alert just to restore green. Add a dated
comment to the durable issue with:

```text
Alert:
Owner:
Why the SLA cannot currently be met:
Remediation attempted:
Blocking dependency or external owner:
Risk containment:
Evidence:
Next action:
Next review date:
```

Escalate critical alerts immediately. A review date is not a waiver; it is the
next forced decision point.

## Dismissal record

Dismiss only after repository-specific review. Record:

```text
Alert:
Resolution:
Reason:
Owner:
Evidence:
Compensating control:
Approved by:
Decision date:
Review or expiry date:
```

Never paste a literal secret into the issue, workflow log, or artifact.

## Delivery failures

- Issue failed, artifact succeeded: use the complete artifact for triage, fix
  issue permissions or ambiguity, then rerun.
- Artifact failed, issue succeeded: the issue is still authoritative for the
  bounded current view; every finding remains in its repository Security tab.
  Fix artifact delivery and rerun. The issue wording says upload was attempted,
  not guaranteed.
- Both failed: inspect the Build report outcome first. Missing or malformed
  `hygiene-state.json` must fail closed before enforcement outputs exist.
- Duplicate durable issues: close the accidental duplicate only after
  confirming which issue has the correct history, then rerun. Never relax the
  exact-title ambiguity guard.
- Closed durable issue: after owner review, reopen the exact existing issue and
  rerun. The workflow refuses to create a replacement because that would lose
  the durable history.
