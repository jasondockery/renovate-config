import assert from 'node:assert/strict'
import test from 'node:test'
import { formatOutdated, runJsonCommand } from './show-outdated.mjs'

test('outdated evidence separates lockfile, compatible, mature, registry, and declared values', () => {
  const report = formatOutdated(
    { turbo: { current: '2.10.7', wanted: '2.10.7', latest: '2.10.7' } },
    { turbo: { current: '2.10.7', wanted: '2.10.7', latest: '2.10.8' } },
    { turbo: { 'dist-tags': { latest: '3.0.0' } } },
    { turbo: '^2.10.0' },
  ).join('\n')
  assert.match(report, /Lockfile Wanted: 2\.10\.7/)
  assert.match(report, /Compatible Latest: 2\.10\.8/)
  assert.match(report, /pnpm-mature Latest: 2\.10\.7/)
  assert.match(report, /Registry Newest: 3\.0\.0/)
  assert.match(report, /Declared Specification: \^2\.10\.0/)
  assert.match(report, /Compatible update available: yes/)
})

test('outdated evidence fails closed for process and JSON failures', () => {
  assert.throws(() => runJsonCommand('pnpm', ['outdated'], { acceptedStatuses: [0, 1], runner: () => ({ status: 2, stdout: '{}', stderr: 'network failure' }) }), /exited 2/)
  assert.throws(() => runJsonCommand('pnpm', ['outdated'], { acceptedStatuses: [0, 1], runner: () => ({ status: 1, stdout: '', stderr: '' }) }), /no JSON evidence/)
  assert.throws(() => runJsonCommand('pnpm', ['outdated'], { acceptedStatuses: [0, 1], runner: () => ({ status: 1, stdout: '{', stderr: '' }) }), /malformed JSON/)
  assert.throws(() => runJsonCommand('pnpm', ['outdated'], { acceptedStatuses: [0, 1], runner: () => ({ status: null, signal: 'SIGTERM', stdout: '{}', stderr: '' }) }), /terminated/)
  assert.match(formatOutdated({}, {}).join('\n'), /pnpm reported no outdated packages/)
})
