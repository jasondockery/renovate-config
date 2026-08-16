import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { assertReviewedPolicy, policyValidatorArguments } from './check-renovate-effective-policy.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function read(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'))
}

const defaultAccepted = read('default.json')
const defaultReviewed = read('tools/fixtures/preset/default-five-day-policy.json')
const automergeAccepted = read('low-risk-automerge.json')
const automergeReviewed = read('tools/fixtures/preset/low-risk-automerge.json')

function ruleFor(value, predicate) {
  const rule = value.packageRules.find(predicate)
  assert.ok(rule, 'fixture rule must exist')
  return rule
}

test('accepts only the exact owner-reviewed default and standalone automerge policies', () => {
  assert.doesNotThrow(() => assertReviewedPolicy(defaultAccepted, defaultReviewed, 'default policy'))
  assert.doesNotThrow(() => assertReviewedPolicy(automergeAccepted, automergeReviewed, 'automerge policy'))

  for (const [accepted, reviewed, label, mutate] of [
    [defaultAccepted, defaultReviewed, 'default policy', (value) => { value.prHourlyLimit = 99 }],
    [defaultAccepted, defaultReviewed, 'default policy', (value) => { value.vulnerabilityAlerts.automerge = true }],
    [automergeAccepted, automergeReviewed, 'automerge policy', (value) => { value.minimumReleaseAge = '5 days' }],
    [automergeAccepted, automergeReviewed, 'automerge policy', (value) => { value.extends.push('github>example/other') }],
  ]) {
    const changed = structuredClone(reviewed)
    mutate(changed)
    assert.throws(() => assertReviewedPolicy(accepted, changed, label), /exact owner-reviewed fixture/)
  }
})

test('review fixture binds the standalone eligibility and fail-closed exclusions', () => {
  const degradations = {
    'age below fourteen days': (value) => { value.minimumReleaseAge = '5 days' },
    'npm rule below fourteen days': (value) => {
      ruleFor(value, (rule) => rule.matchDatasources?.includes('npm') && rule.minimumReleaseAge).minimumReleaseAge = '5 days'
    },
    'routine eligibility widened beyond npm': (value) => {
      delete ruleFor(value, (rule) => rule.automerge === true).matchDatasources
    },
    'routine eligibility widened to majors': (value) => {
      ruleFor(value, (rule) => rule.automerge === true).matchUpdateTypes.unshift('major')
    },
    'routine eligibility widened to production': (value) => {
      ruleFor(value, (rule) => rule.automerge === true).matchDepTypes.push('dependencies')
    },
    'routine eligibility delegated to platform': (value) => {
      ruleFor(value, (rule) => rule.automerge === true).platformAutomerge = true
    },
    'routine eligibility ignores checks': (value) => {
      ruleFor(value, (rule) => rule.automerge === true).ignoreTests = true
    },
    'routine eligibility bypasses pull request': (value) => {
      ruleFor(value, (rule) => rule.automerge === true).automergeType = 'branch'
    },
    'lockfile receives authority': (value) => {
      ruleFor(value, (rule) => rule.matchUpdateTypes?.includes('lockFileMaintenance')).automerge = true
    },
    'runtime exclusion removed': (value) => {
      value.packageRules = value.packageRules.filter((rule) => !rule.matchPackageNames?.includes('renovate'))
    },
    'human fallback removed': (value) => {
      value.packageRules = value.packageRules.filter((rule) => JSON.stringify(rule.matchPackageNames) !== '["*"]')
    },
    'security receives authority': (value) => { value.vulnerabilityAlerts.automerge = true },
  }

  for (const [label, mutate] of Object.entries(degradations)) {
    const weakened = structuredClone(automergeReviewed)
    mutate(weakened)
    assert.notDeepEqual(weakened, automergeReviewed, `${label} must change the fixture`)
    assert.throws(
      () => assertReviewedPolicy(automergeAccepted, weakened, 'automerge policy'),
      /exact owner-reviewed fixture/,
      `review fixture must reject: ${label}`
    )
  }
})

test('strict no-global validation covers both distributed presets', () => {
  assert.deepEqual(policyValidatorArguments('default.json'), ['--strict', '--no-global', 'default.json'])
  assert.deepEqual(
    policyValidatorArguments('low-risk-automerge.json'),
    ['--strict', '--no-global', 'low-risk-automerge.json']
  )
})
