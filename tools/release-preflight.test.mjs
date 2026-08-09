import assert from 'node:assert/strict'
import test from 'node:test'
import {
  collectCiReceiptProblems,
  collectReleasePreflightProblems,
  parseReleasePreflightArguments,
  runReleasePreflight,
} from './release-preflight.mjs'

const SHA = '0123456789abcdef0123456789abcdef01234567'

function snapshot(overrides = {}) {
  return {
    headSha: SHA,
    status: '',
    trackedFingerprint: 'sha256:tracked',
    trackedPaths: 10,
    relevantIgnored: {},
    ...overrides,
  }
}

function ciReceipt(overrides = {}) {
  return {
    schema: 'renovate-config.run-receipt',
    schemaVersion: 1,
    receiptKind: 'ci-gate',
    repository: 'jasondockery/renovate-config',
    workflow: 'CI',
    job: 'ci-gate',
    event: 'push',
    ref: 'refs/heads/main',
    result: 'passed',
    testedSha: SHA,
    headSha: SHA,
    runId: 123,
    runAttempt: 1,
    facts: {
      'Failed configs': 'none',
      'Renovate version': '1.2.3',
      'Configs validated by renovate-integration': 'default.json, renovate.json, runner.json',
      'Evidence errors': 'none',
      'Read-only proof': 'tests success; validation success; integration success',
    },
    ...overrides,
  }
}

function evidence(overrides = {}) {
  return {
    version: '1.0.0',
    expectedSha: SHA,
    before: snapshot(),
    localTagShas: [],
    remoteTagShas: [],
    controlsReceipt: { result: 'passed', drift: [] },
    freeze: { lifted: false, problems: [] },
    ciReceipt: ciReceipt(),
    ...overrides,
  }
}

function dependencies(overrides = {}) {
  let verifyCalls = 0
  const values = {
    checkControls: async () => ({ result: 'passed', drift: [] }),
    ciReceipt: async () => ciReceipt(),
    freeze: () => ({ lifted: false, problems: [] }),
    localTags: () => [],
    remoteTags: () => [],
    runVerify: () => {
      verifyCalls += 1
      return true
    },
    snapshot: () => snapshot(),
    ...overrides,
  }
  return { values, verifyCalls: () => verifyCalls }
}

test('rejects v-prefixed releases, existing tags, and mismatched intended SHAs', () => {
  assert.deepEqual(
    collectReleasePreflightProblems(
      evidence({
        version: 'v1.0.0',
        expectedSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        localTagShas: [SHA],
      })
    ).slice(0, 3),
    [
      'release version must be stable SemVer without a v prefix',
      'current HEAD does not match the intended release SHA',
      'release tag v1.0.0 already exists locally or remotely',
    ]
  )
})

test('disabled controls and unavailable canonical Renovate evidence block preflight', () => {
  const problems = collectReleasePreflightProblems(
    evidence({
      controlsReceipt: { result: 'failed', drift: ['GitHub immutable releases are disabled'] },
      ciReceipt: ciReceipt({ facts: { 'Failed configs': 'unavailable' } }),
    })
  )
  assert.ok(problems.includes('GitHub immutable releases are disabled'))
  assert.ok(problems.includes('exact-SHA CI receipt reports failed or unavailable Renovate configs'))
  assert.ok(problems.includes('exact-SHA CI receipt has no authoritative Renovate version'))
})

test('successful preflight runs canonical verification once and preserves repository identity', async () => {
  const fixture = dependencies()
  const result = await runReleasePreflight(
    { version: '1.0.0', expectedSha: SHA },
    fixture.values
  )
  assert.equal(result.result, 'passed')
  assert.equal(result.verified, true)
  assert.equal(fixture.verifyCalls(), 1)
})

test('failed static evidence never launches canonical verification', async () => {
  const fixture = dependencies({ localTags: () => [SHA] })
  const result = await runReleasePreflight(
    { version: '1.0.0', expectedSha: SHA },
    fixture.values
  )
  assert.equal(result.result, 'failed')
  assert.equal(fixture.verifyCalls(), 0)
})

test('CI receipt must bind the exact SHA and renovate-integration facts', () => {
  assert.deepEqual(collectCiReceiptProblems(ciReceipt(), SHA), [])
  assert.ok(
    collectCiReceiptProblems(ciReceipt({ testedSha: 'a'.repeat(40) }), SHA).includes(
      'exact-SHA CI receipt does not bind the intended release commit'
    )
  )
  assert.ok(
    collectCiReceiptProblems(ciReceipt({ ref: 'refs/pull/1/merge' }), SHA).includes(
      'exact-SHA CI receipt is not the main-branch CI gate'
    )
  )
  assert.ok(
    collectCiReceiptProblems(
      ciReceipt({ facts: { ...ciReceipt().facts, 'Evidence errors': 'missing integration output' } }),
      SHA
    ).includes('exact-SHA CI receipt lacks successful pinned-runtime integration evidence')
  )
})

test('CLI requires explicit version and intended release SHA', () => {
  assert.deepEqual(
    parseReleasePreflightArguments(['--version', '1.0.0', '--expected-sha', SHA]),
    { version: '1.0.0', expectedSha: SHA }
  )
  assert.throws(() => parseReleasePreflightArguments(['--version', '1.0.0']), /usage:/)
})
