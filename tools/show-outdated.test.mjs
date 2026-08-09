import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { collectOutdatedEvidence, formatOutdated, runJsonCommand } from './show-outdated.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('outdated evidence separates lockfile, compatible, mature, registry, and declared values', () => {
  const report = formatOutdated(
    { turbo: { current: '2.10.7', wanted: '2.10.7', latest: '2.10.7' } },
    { turbo: { current: '2.10.7', wanted: '2.10.7', latest: '2.10.8' } },
    { turbo: { 'dist-tags': { latest: '3.0.0' }, time: { '3.0.0': '2026-08-01T00:00:00.000Z' } } },
    { turbo: '^2.10.0' },
    Date.parse('2026-08-07T00:00:00.000Z'),
  ).join('\n')
  assert.match(report, /Lockfile Wanted: 2\.10\.7/)
  assert.match(report, /Compatible Latest: 2\.10\.8/)
  assert.match(report, /pnpm-mature Latest: 2\.10\.7/)
  assert.match(report, /Registry Newest: 3\.0\.0/)
  assert.match(report, /Declared Specification: \^2\.10\.0/)
  assert.match(report, /Compatible update available: yes/)
  assert.match(report, /Five-day Eligible After: 2026-08-06T00:00:00\.000Z/)
  assert.match(report, /Five-day Maturity: mature/)
})

test('outdated evidence covers every workspace package recursively', () => {
  const calls = []
  const runner = (command, args) => {
    calls.push([command, ...args])
    if (command === 'node') return { status: 0, stdout: '24.19.0', stderr: '' }
    if (args[0] === 'outdated') return { status: 0, stdout: '{}', stderr: '' }
    return { status: 0, stdout: '{"latest":"11.20.0"}', stderr: '' }
  }
  collectOutdatedEvidence(repoRoot, runner, { slice: () => 1_000 })
  const outdated = calls.filter(([, subcommand]) => subcommand === 'outdated')
  assert.equal(outdated.length, 2)
  assert.equal(outdated.every((args) => args.includes('--recursive')), true)
})

test('outdated evidence fails closed for process and JSON failures', () => {
  assert.throws(() => runJsonCommand('pnpm', ['outdated'], { acceptedStatuses: [0, 1], runner: () => ({ status: 2, stdout: '{}', stderr: 'network failure' }) }), /exited 2/)
  assert.throws(() => runJsonCommand('pnpm', ['outdated'], { acceptedStatuses: [0, 1], runner: () => ({ status: 1, stdout: '', stderr: '' }) }), /no JSON evidence/)
  assert.throws(() => runJsonCommand('pnpm', ['outdated'], { acceptedStatuses: [0, 1], runner: () => ({ status: 1, stdout: '{', stderr: '' }) }), /malformed JSON/)
  assert.throws(() => runJsonCommand('pnpm', ['outdated'], { acceptedStatuses: [0, 1], runner: () => ({ status: null, signal: 'SIGTERM', stdout: '{}', stderr: '' }) }), /terminated/)
  assert.match(formatOutdated({}, {}).join('\n'), /pnpm reported no outdated packages/)
})
