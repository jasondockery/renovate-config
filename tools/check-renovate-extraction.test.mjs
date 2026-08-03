import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import {
  extractionArguments,
  extractionEnvironment,
  parseExtractedDependencies,
} from './check-renovate-extraction.mjs'

test('the provisioned pinned runtime uses local extract-only mode', () => {
  assert.deepEqual(extractionArguments(), [
    '--platform=local',
    '--dry-run=extract',
    '--require-config=required',
  ])
})

test('extraction environment drops ambient Renovate and log policy', () => {
  const environment = extractionEnvironment(
    { PATH: '/bin', RENOVATE_TOKEN: 'secret', LOG_LEVEL: 'trace' },
    '/tmp/private-fixture'
  )
  assert.equal(environment.PATH, '/bin')
  assert.equal(environment.RENOVATE_TOKEN, undefined)
  assert.equal(environment.LOG_FORMAT, 'json')
  assert.equal(environment.LOG_LEVEL, 'debug')
  assert.equal(environment.RENOVATE_BASE_DIR, path.join('/tmp/private-fixture', 'base'))
})

test('structured extraction records inherit their package-file manager', () => {
  const output = [
    'npx diagnostic',
    JSON.stringify({
      msg: 'Extracted dependencies',
      packageFiles: {
        npm: [{ packageFile: 'package.json', deps: [{ depName: 'is-number', currentValue: '7.0.0' }] }],
        regex: [{ packageFile: '.renovate-version', deps: [{ depName: 'renovate', currentValue: '1.2.3' }] }],
      },
    }),
  ].join('\n')
  const found = parseExtractedDependencies(output)
  assert.deepEqual(found, [
    { manager: 'custom.regex', packageFile: '.renovate-version', depName: 'renovate', currentValue: '1.2.3', currentDigest: '' },
    { manager: 'npm', packageFile: 'package.json', depName: 'is-number', currentValue: '7.0.0', currentDigest: '' },
  ])
})
