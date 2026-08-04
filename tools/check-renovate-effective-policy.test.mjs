import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  assertReviewedPolicy,
  policyValidatorArguments,
} from './check-renovate-effective-policy.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const accepted = JSON.parse(fs.readFileSync(path.join(root, 'default.json'), 'utf8'))
const reviewed = JSON.parse(fs.readFileSync(
  path.join(root, 'tools/fixtures/preset/default-five-day-policy.json'),
  'utf8'
))

test('accepts only the exact owner-reviewed active policy', () => {
  assert.doesNotThrow(() => assertReviewedPolicy(accepted, reviewed))

  for (const mutate of [
    (value) => { value.extends.push('group:allNonMajor') },
    (value) => { value.prHourlyLimit = 99 },
    (value) => { value.packageRules.push({ matchManagers: ['npm'], enabled: false }) },
    (value) => { value.vulnerabilityAlerts.automerge = false },
  ]) {
    const changed = structuredClone(reviewed)
    mutate(changed)
    assert.throws(() => assertReviewedPolicy(accepted, changed), /exact owner-reviewed/)
  }
})

test('pins strict no-global validation to the active preset', () => {
  assert.deepEqual(policyValidatorArguments, [
    '--strict',
    '--no-global',
    'default.json',
  ])
})
