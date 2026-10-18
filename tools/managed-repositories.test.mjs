import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadManagedRepositories } from './managed-repositories.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('the maintained family excludes the original Groundwork repository', () => {
  const repositories = loadManagedRepositories(root)
  assert.ok(repositories.includes('jasondockery/groundwork-mac'))
  assert.ok(repositories.includes('jasondockery/groundwork-omarchy-mac-arm64'))
  assert.ok(!repositories.includes('jasondockery/groundwork'))
})

test('invalid scopes and reactivated retired repositories fail closed', (context) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-scope-'))
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  for (const value of [
    { repositories: [], retiredRepositories: [] },
    { repositories: ['a/b', 'a/b'], retiredRepositories: [] },
    { repositories: ['a/b', 'c/d'], retiredRepositories: [] },
    { repositories: ['a/b'], retiredRepositories: ['a/b'] },
    { repositories: ['INVALID'], retiredRepositories: [] },
  ]) {
    fs.writeFileSync(path.join(dir, 'managed-repositories.json'), JSON.stringify({ schemaVersion: 1, ...value }))
    assert.throws(() => loadManagedRepositories(dir))
  }
})
