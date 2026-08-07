---
name: toolchain-authority
description: Maintain renovate-config's toolchain authorities and atomic cross-repository Renovate updates. Use before changing Node or pnpm declarations, mise, packageManager, engines, CI setup, allowedCommands, post-upgrade tasks, dependency inventories, compatibility checks, docs, or version fixtures.
---

# Toolchain authority

## Preserve the two authorities

- Change Node only in `.node-version`.
- Change pnpm only in `package.json#packageManager`.
- Treat `.nvmrc`, `mise.toml#tools.node`, `engines`, CI, and consumer templates as derived adapters.
- Never declare pnpm in mise. Mise owns Node; Corepack selects pnpm.
- Never add another authoritative version file.

Run `pnpm toolchain:sync` after changing an authority and `pnpm check:toolchain` before handoff. Do not repair mirrors directly.

## Keep Renovate atomic

Let Renovate update a tool's authority, then run only the exact allowlisted `node tools/sync-toolchain.mjs` command. Require the resulting branch to pass the toolchain checker. Node and pnpm may update separately, but each update must include all of its mirrors. Never broaden `allowedCommands` to a shell or wildcard.

The consumer compatibility matrix must import and exercise the consumer sync, checker, and reporter APIs. It rejects pnpm in mise, stale mirrors/templates/engines, former-version documentation literals, incomplete report behavior, and partial correlated updates in Groundwork, Roost, or renovate-config. Source strings are not behavioral proof.

Auditing a consumer means importing and running its code, so each repository is audited in its own child process with a deadline (`tools/toolchain-consumer-audit.mjs`). Keep it that way: in-process, one audited repository can patch globals and silently corrupt every verdict after it, and one hang stalls the whole sweep.

## Classify every consumer

Classify each new version-bearing file as an authority, generated mirror, compatibility adapter, named fixture, or historical record. Use `git ls-files -z` so hidden files are inventoried. A checkout without Git metadata falls back to a bounded filesystem walk, so the classification never reports a pass while observing nothing. Current-contract tests read authorities; fixed parser cases use named values unrelated to former production pins. Use `pnpm check:outdated` for separate lockfile, compatible, maturity-filtered, registry, declared-specification, and toolchain evidence; any missing observation fails closed.
