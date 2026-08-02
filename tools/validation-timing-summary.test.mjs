import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compactValidationTiming,
  parseValidationTiming,
  renderValidationTimingSummary,
} from './validation-timing-summary.mjs'

const fixture = {
  schema: 'renovate-config.validation-timing',
  schemaVersion: 1,
  result: 'passed',
  totalMilliseconds: 3500,
  phases: [
    { name: 'Fast phase', result: 'passed', durationMilliseconds: 500 },
    { name: 'Slow phase', result: 'passed', durationMilliseconds: 3000 },
  ],
}

test('validation timing summary sorts bounded phase facts by duration', () => {
  const parsed = parseValidationTiming(fixture)
  assert.match(renderValidationTimingSummary(parsed), /\| Slow phase \| 3\.0s \| passed \|/)
  assert.equal(
    compactValidationTiming(parsed),
    'Slow phase 3.0s passed; Fast phase 0.5s passed'
  )
})

test('validation timing summary rejects malformed or duplicate phase facts', () => {
  assert.throws(() => parseValidationTiming({}), /schema/)
  assert.throws(
    () => parseValidationTiming({ ...fixture, totalMilliseconds: -1 }),
    /non-negative/
  )
  assert.throws(
    () => parseValidationTiming({
      ...fixture,
      phases: [fixture.phases[0], { ...fixture.phases[0] }],
    }),
    /duplicate/
  )
  assert.throws(
    () => parseValidationTiming({
      ...fixture,
      phases: [{ ...fixture.phases[0], result: 'failed' }],
    }),
    /passed validation timing receipt/
  )
  assert.throws(
    () => parseValidationTiming({
      ...fixture,
      result: 'failed',
    }),
    /must contain a failed phase/
  )
  assert.throws(
    () => parseValidationTiming({
      ...fixture,
      phases: [{ ...fixture.phases[0], name: 'phase\nforged_output=value' }],
    }),
    /invalid name/
  )
  assert.throws(
    () => parseValidationTiming({ ...fixture, totalMilliseconds: 2999 }),
    /at least the longest phase/
  )
  assert.throws(
    () => parseValidationTiming({ ...fixture, totalMilliseconds: 5000 }),
    /disagrees with sequential phase durations/
  )
})
