import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const hook = (name) => path.join(root, '.githooks', name)

test('both hooks exist, are executable, and fail closed', () => {
  for (const name of ['pre-commit', 'pre-push']) {
    const file = hook(name)
    assert.ok(fs.existsSync(file), `${name} hook is missing`)
    // Without the executable bit git silently skips the hook, which reads
    // exactly like a passing gate.
    assert.equal(fs.statSync(file).mode & 0o111 ? true : false, true, `${name} is not executable`)
    const source = fs.readFileSync(file, 'utf8')
    assert.match(source, /^set -euo pipefail$/m, `${name} does not fail closed`)
    assert.match(source, /git rev-parse --show-toplevel/, `${name} does not bind to the repository root`)
  }
})

// Only what the hook actually runs. These files explain in comments which
// commands deliberately live elsewhere, so asserting against the raw text
// fails on the explanation rather than on the behavior.
function commands(name) {
  return fs
    .readFileSync(hook(name), 'utf8')
    .split('\n')
    .filter((line) => line.trim() && !line.trim().startsWith('#'))
    .join('\n')
}

test('hooks stay inside their declared budget', () => {
  const preCommit = commands('pre-commit')
  const prePush = commands('pre-push')

  // specs/verification.md → Hooks: pre-commit is staged-only and cheap. The
  // test suite and full validation are not cheap, so they belong later.
  assert.doesNotMatch(preCommit, /node --test/, 'pre-commit must not run the test suite')
  assert.doesNotMatch(preCommit, /pnpm verify|tools\/verify\.mjs/, 'pre-commit must not run the final gate')

  // The final gate stays an explicit command. A hook that runs it makes every
  // push pay for proof the release path runs again anyway.
  assert.doesNotMatch(prePush, /pnpm verify|tools\/verify\.mjs/, 'pre-push must not run the final gate')

  // Network-backed proof never belongs in a hook: it turns an offline commit
  // into a failure that has nothing to do with the change.
  for (const [name, source] of [['pre-commit', preCommit], ['pre-push', prePush]]) {
    assert.doesNotMatch(source, /check:outdated|show-outdated/, `${name} must not run network-backed proof`)
  }
})
