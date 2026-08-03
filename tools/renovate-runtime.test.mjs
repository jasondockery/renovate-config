import assert from 'node:assert/strict'
import test from 'node:test'
import { parseRenovateVersion } from './renovate-runtime.mjs'
import { validatorArguments } from './validate-renovate.mjs'

test('accepts one exact Renovate version with an optional final newline', () => {
  assert.equal(parseRenovateVersion('1.2.3'), '1.2.3')
  assert.equal(parseRenovateVersion('1.2.3\n'), '1.2.3')
})

test('rejects ranges, prefixes, whitespace, and extra lines', () => {
  for (const value of ['^1.2.3\n', 'v1.2.3\n', ' 1.2.3\n', '1.2.3 \n', '1.2.3\nx\n']) {
    assert.throws(() => parseRenovateVersion(value), /one exact version/)
  }
})

test('validates repository configs with no global privileges', () => {
  assert.deepEqual(validatorArguments({ file: 'default.json', global: false }), [
    '--strict',
    '--no-global',
    'default.json',
  ])
})

test('validates the runner as self-hosted global configuration', () => {
  assert.deepEqual(validatorArguments({ file: 'runner.json', global: true }), [
    '--strict',
    'runner.json',
  ])
})
