import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  formatGitHubOutputs,
  parseHygieneState,
} from './security-hygiene-state.mjs'

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'security-hygiene-state.mjs'
)

function runFixture(contents, { missing = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hygiene-state-'))
  const statePath = path.join(directory, 'state.json')
  if (!missing) fs.writeFileSync(statePath, contents)
  const result = spawnSync(process.execPath, [SCRIPT, statePath], {
    encoding: 'utf8',
  })
  fs.rmSync(directory, { recursive: true, force: true })
  return result
}

test('valid false monitor state emits exact GitHub outputs', () => {
  const state = parseHygieneState('{"monitorBroken":false,"overdueCount":0}')
  assert.deepEqual(state, { monitorBroken: false, overdueCount: 0 })
  assert.equal(formatGitHubOutputs(state), 'monitor_broken=false\noverdue_count=0')
  const result = runFixture('{"monitorBroken":false,"overdueCount":0}')
  assert.equal(result.status, 0)
  assert.equal(result.stdout, 'monitor_broken=false\noverdue_count=0\n')
})

for (const [name, contents, message] of [
  ['invalid JSON', '{', /valid JSON/],
  ['missing property', '{"monitorBroken":false}', /overdueCount/],
  ['string Boolean', '{"monitorBroken":"false","overdueCount":0}', /Boolean/],
  ['negative count', '{"monitorBroken":false,"overdueCount":-1}', /non-negative/],
  ['fractional count', '{"monitorBroken":false,"overdueCount":1.5}', /integer/],
]) {
  test(`${name} fails closed`, () => {
    const result = runFixture(contents)
    assert.equal(result.status, 1)
    assert.match(result.stderr, message)
    assert.equal(result.stdout, '')
  })
}

test('missing state file fails closed', () => {
  const result = runFixture('', { missing: true })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /ENOENT/)
  assert.equal(result.stdout, '')
})

test('the CLI entrypoint is realpath-aware and importing it stays silent', (t) => {
  if (process.platform === 'win32') return t.skip('symlink fixture')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hygiene state links with spaces-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const statePath = path.join(directory, 'state.json')
  fs.writeFileSync(statePath, '{"monitorBroken":false,"overdueCount":0}')
  const link = path.join(directory, 'state helper.mjs')
  fs.symlinkSync(SCRIPT, link)

  const invoked = spawnSync(process.execPath, [link, statePath], { encoding: 'utf8' })
  assert.equal(invoked.status, 0)
  assert.equal(invoked.stdout, 'monitor_broken=false\noverdue_count=0\n')

  const imported = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', `await import(${JSON.stringify(pathToFileURL(SCRIPT).href)})`],
    { encoding: 'utf8' }
  )
  assert.equal(imported.status, 0)
  assert.equal(imported.stdout, '')
  assert.equal(imported.stderr, '')

  const broken = path.join(directory, 'broken helper.mjs')
  fs.symlinkSync(path.join(directory, 'missing-target.mjs'), broken)
  const brokenResult = spawnSync(process.execPath, [broken, statePath], { encoding: 'utf8' })
  assert.notEqual(brokenResult.status, 0)
})
