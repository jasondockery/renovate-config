---
name: live-renovate-acceptance
description: Verify a real renovate-config runner dispatch and its consumer outcomes. Use when assessing whether Renovate works, investigating a green run with missing PRs, reconciling pnpm outdated with Dependency Dashboards, accepting a runner or consumer PR, or reporting live dependency-automation proof.
---

# Live Renovate acceptance

Treat runner execution, update eligibility, PR mutation, and consumer compatibility as separate proof levels. Never call Renovate end-to-end working from configuration validation, a dry run, a dashboard, or a green runner receipt alone.

## Procedure

1. Read `AI_THESIS.md`, `CHARTER.md`, and `specs/renovate-system-acceptance.md`.
2. Resolve the exact `Renovate` workflow run. Dispatch the write-capable workflow only with explicit operational authorization; it may create or update branches, issues, and PRs.
3. Run `pnpm renovate:audit --run <run-id>`. Exit `0` is passed, `2` is pending evidence or owner action, and `1` is failed. Inspect the selected run receipt, every repository row, dashboard disposition, branch identity, PR checks, and cleanup facts.
4. Use the audit's captured App identity, `self-hosted-renovate/` branch, exact head SHA, base branch, state, and selected-run timestamps. Never guess a bot login or use an author-only search.
5. In each exact consumer checkout, run the consumer's normal install if its lockfile is not already installed, then invoke `<renovate-config>/tools/show-outdated.mjs` with the consumer as the current directory. The tool invokes recursive pnpm evidence, so workspace packages are not omitted. Record the checkout SHA and keep registry evidence supplemental.
6. Reconcile every outdated package with the audit and the consumer policy. Assign exactly one disposition:
   - `eligible-pr`: represented by a current-run branch or PR;
   - `minimum-age`: release timestamp has not crossed the five-day boundary;
   - `approval-required`: Dependency Dashboard approval is required;
   - `disabled`: repository policy deliberately disables the update;
   - `already-represented`: an existing branch or PR owns it;
   - `rate-limited`: a bounded PR limit deferred it;
   - `scheduled-maintenance`: only the explicitly weekly lockfile-maintenance lane;
   - `blocked`: extraction, configuration, branch, artifact, PR, or CI failure;
   - `absent`: no newer version exists.
7. Inspect non-pnpm managers separately through the Dependency Dashboard and coverage inventories: GitHub Actions, Docker images, regex/custom managers, runtime pins, digests, and deliberate manual surfaces. `pnpm outdated` cannot clear those surfaces.
8. For each attributable PR, inspect required consumer CI and required generated artifacts. Pending checks remain pending; red checks fail acceptance.
9. Report the highest proof level actually reached: static validity, pinned integration, runner execution, Renovate behavior, or consumer compatibility. Include exact run, repository, SHA, PR, and check identities.

## Required report shape

For each consumer, report:

```text
package current -> target
  detected: yes|no|unknown
  eligible: yes|no|unknown
  disposition: <one value from the procedure>
  evidence: <dashboard, branch, PR, policy, or timestamp identity>
  next action: <action or none>
```

State package-manager evidence and other manager families separately. If the dashboard predates the run or structured no-update evidence is absent, say `pending`; do not infer that nothing was eligible.
