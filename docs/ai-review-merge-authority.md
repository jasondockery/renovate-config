# AI review and dependency-merge authority

Status: **owner-approved local policy candidate; not yet released**

AI review is useful evidence, but it is never the authority that permits a
dependency pull request to merge. This rule is vendor-neutral: a review
comment, suggestion, approval-like signal, or agent-authored fix from Copilot,
Codex, Claude, Cursor, OpenCode, or another tool is an observation.

For Renovate-owned pull requests, automatic merge is authorized only by the
resolved package classification and the exact independent repository checks
recorded for that consumer. The standalone opt-in preset limits eligibility to
14-day-old stable npm `devDependencies` patch/minor updates, including stable
compiler, linter, test-runner, formatter, and build-tool packages unless a
consumer excludes them. Renovate performs
the PR merge only after the complete required-check inventory and pristine
Renovate-branch integrity check are green on the current head. Majors, `0.x`,
lockfile maintenance, vulnerability alerts,
Actions, runtimes, Renovate/runner infrastructure, consumer risk exceptions,
and source-code remediation remain human-owned.

Copilot review is supplemental because its review exclusions include core
dependency manifests and lockfiles. A missing comment is therefore not proof
that a dependency change is safe. A future required AI-review gate must be an
independent repository check with explicit completion and actionable-finding
semantics; it cannot infer success from silence.

## Branch ownership after an agent fix

Renovate owns and may regenerate its branch. Do not let an agent edit that
branch and then pretend Renovate still owns the result.

- Deterministic or generated defect: fix the repository-owned generator, close
  or recreate the Renovate PR, and re-run all checks from a fresh branch.
- Semantic migration: create a separate agent-owned successor PR.
- Deliberate in-place takeover is not an automerge path. The stop-updating label
  prevents Renovate updates but does not set `automerge: false`. Any foreign
  commit must fail the required pristine-branch check and move to a separate
  manual successor. Do not configure ignored commit authors so Renovate can
  overwrite the agent's changes.

No AI reviewer may approve its own fix into the automatic-merge boundary.
