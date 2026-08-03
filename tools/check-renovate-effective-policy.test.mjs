import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  assertReviewedProposalDelta,
  proposalValidatorArguments,
} from './check-renovate-effective-policy.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const accepted = JSON.parse(fs.readFileSync(path.join(root, 'default.json'), 'utf8'))
const proposal = JSON.parse(fs.readFileSync(
  path.join(root, 'tools/fixtures/preset/default-five-day-policy.json'),
  'utf8'
))

test('accepts only the reviewed structural policy delta', () => {
  assert.doesNotThrow(() => assertReviewedProposalDelta(accepted, proposal))

  for (const mutate of [
    (value) => { value.extends.push('group:allNonMajor') },
    (value) => { value.prHourlyLimit = 99 },
    (value) => { value.packageRules.push({ matchManagers: ['npm'], enabled: false }) },
    (value) => { value.vulnerabilityAlerts.automerge = false },
  ]) {
    const changed = structuredClone(proposal)
    mutate(changed)
    assert.throws(() => assertReviewedProposalDelta(accepted, changed), /only in reviewed/)
  }
})

test('pins strict no-global validation to the proposal fixture', () => {
  assert.deepEqual(proposalValidatorArguments, [
    '--strict',
    '--no-global',
    'tools/fixtures/preset/default-five-day-policy.json',
  ])
})
