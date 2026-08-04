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

// The degradations the required integration lane exists to catch. Each is a
// realistic way the effective five-day floor or the security bypass could be
// weakened, and each must stop the lane at its first gate rather than reach a
// green receipt. `checkEffectivePolicy` calls this before it resolves anything
// against the runtime, so these are provable offline.
test('rejects a weakened effective age, filter, or security bypass', () => {
  const degradations = {
    'later npm rule below five days': (value) => {
      value.packageRules.at(-1).minimumReleaseAge = '3 days'
    },
    'top-level age below five days': (value) => { value.minimumReleaseAge = '3 days' },
    'npm rule no longer failing closed': (value) => {
      value.packageRules.at(-1).internalChecksFilter = 'none'
    },
    'top-level internal checks relaxed': (value) => { value.internalChecksFilter = 'none' },
    'security updates inheriting an age floor': (value) => {
      value.vulnerabilityAlerts.minimumReleaseAge = '5 days'
    },
    'security updates losing their schedule bypass': (value) => {
      value.vulnerabilityAlerts.schedule = ['before 4am on monday']
    },
    'security updates losing their rate-limit bypass': (value) => {
      value.vulnerabilityAlerts.prConcurrentLimit = 5
    },
    'an added later rule disabling npm updates': (value) => {
      value.packageRules.push({ matchDatasources: ['npm'], minimumReleaseAge: '0 days' })
    },
  }

  for (const [label, mutate] of Object.entries(degradations)) {
    const weakened = structuredClone(accepted)
    mutate(weakened)
    assert.notDeepEqual(weakened, reviewed, `${label} must actually change the policy`)
    assert.throws(
      () => assertReviewedPolicy(weakened, reviewed),
      /exact owner-reviewed/,
      `the integration lane must reject: ${label}`
    )
  }
})

test('pins strict no-global validation to the active preset', () => {
  assert.deepEqual(policyValidatorArguments, [
    '--strict',
    '--no-global',
    'default.json',
  ])
})
