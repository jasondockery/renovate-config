import assert from 'node:assert/strict'
import test from 'node:test'
import {
  collectResolvedPresetProblems,
  parseResolveReleasePresetArguments,
} from './resolve-release-preset.mjs'

function evidence(overrides = {}) {
  return {
    version: '1.0.0',
    expectedRuntime: '1.2.3',
    runtime: '1.2.3',
    reference: 'github>jasondockery/renovate-config#1.0.0',
    visitedPresets: {
      merged: ['github>jasondockery/renovate-config#1.0.0'],
      unmerged: [],
    },
    validation: { errors: [], warnings: [] },
    ...overrides,
  }
}

test('exact runtime, visited version reference, and strict resolved config pass', () => {
  assert.deepEqual(collectResolvedPresetProblems(evidence()), [])
})

test('an unvisited or substituted preset reference fails closed', () => {
  assert.ok(
    collectResolvedPresetProblems(evidence({
      visitedPresets: { merged: ['github>jasondockery/renovate-config'], unmerged: [] },
    })).includes('Renovate did not report visiting the exact version-pinned preset')
  )
})

test('runtime drift and resolved-config warnings fail closed', () => {
  const problems = collectResolvedPresetProblems(evidence({
    runtime: '1.2.2',
    validation: { errors: [], warnings: [{ message: 'warning' }] },
  }))
  assert.ok(problems.includes('active Renovate runtime does not match .renovate-version'))
  assert.ok(problems.includes('resolved version-pinned preset failed strict repository-config validation'))
})

test('resolver CLI accepts only one bare SemVer argument slot', () => {
  assert.deepEqual(parseResolveReleasePresetArguments(['--version', '1.0.0']), { version: '1.0.0' })
  assert.throws(() => parseResolveReleasePresetArguments(['1.0.0']), /usage:/)
})
