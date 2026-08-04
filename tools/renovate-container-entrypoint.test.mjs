import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENTRYPOINT = path.join(repositoryRoot, 'tools/renovate-container-entrypoint.sh')

// The container entrypoint is the only thing that proves the private log mount
// is real and writable before Renovate starts, and its preflight record is a
// hard requirement of the run receipt. Its refusal paths run before any write,
// so they are testable off a container.
function run(env = {}) {
  return spawnSync('bash', [ENTRYPOINT], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
  })
}

test('the entrypoint is a committed, executable, strict-mode script', () => {
  const source = fs.readFileSync(ENTRYPOINT, 'utf8')
  assert.match(source, /^#!(?:\/usr\/bin\/env |\/bin\/)bash\n/u)
  assert.match(source, /^set -euo pipefail$/mu)
  assert.match(source, /^exec renovate "\$@"$/mu)
  // noclobber is what makes the preflight write refuse an existing log.
  assert.match(source, /set -o noclobber/u)
  assert.equal(fs.lstatSync(ENTRYPOINT).isSymbolicLink(), false)
})

test('refuses a LOG_FILE that does not name the fixed private mount', () => {
  for (const LOG_FILE of ['', '/tmp/renovate.jsonl', '/renovate-log/other.jsonl']) {
    const result = run(LOG_FILE === '' ? {} : { LOG_FILE })
    assert.equal(result.status, 64, `LOG_FILE=${JSON.stringify(LOG_FILE)}`)
    assert.match(result.stderr, /does not name the fixed private mount/)
  }
})

test('refuses to start when the fixed private mount is not a real directory', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-entrypoint-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  // /renovate-log does not exist outside the container, which is exactly the
  // "mount missing" case the preflight must fail closed on.
  const result = run({ LOG_FILE: '/renovate-log/renovate.jsonl' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /fixed private mount is not a real directory/)
  assert.equal(fs.readdirSync(root).length, 0)
})
