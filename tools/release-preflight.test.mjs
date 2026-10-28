import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { collectPresetFreezeProblems } from './check-preset-freeze.mjs'
import {
  collectCiReceiptProblems,
  collectReleasePreflightProblems,
  freezeReleasePresetDigest,
  hashPreset,
  parseReleasePreflightArguments,
  PRESET_DIGEST_1_0_0,
  PRESET_DIGEST_1_1_0,
  runReleasePreflight,
} from './release-preflight.mjs'

const SHA = '0123456789abcdef0123456789abcdef01234567'
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pythonPolicy = fs.readFileSync(path.join(repositoryRoot, 'default.json'), 'utf8')
const preset1_0_0 = execFileSync('git', ['show', '1.0.0:default.json'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
})

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
    freeze: { lifted: false, problems: [], digest: PRESET_DIGEST_1_0_0 },
    expectedPreset: pythonPolicy,
    ciReceipt: ciReceipt(),
    ...overrides,
  }
}

function dependencies(overrides = {}) {
  let verifyCalls = 0
  const values = {
    checkControls: async () => ({ result: 'passed', drift: [] }),
    ciReceipt: async () => ciReceipt(),
    expectedPreset: () => pythonPolicy,
    freeze: () => ({ lifted: false, problems: [], digest: PRESET_DIGEST_1_0_0 }),
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

// The freeze protects preset content, not releasing. Refusing every later
// release deadlocked the bootstrap: 1.0.0 is immutable, so broken release
// tooling could never be repaired. A 1.0.x patch is permitted only while
// default.json still hashes to the 1.0.0 digest. Issue #30 also authorizes
// exactly 1.1.0 at the reviewed Python line-bump digest. Any other new major
// or minor still waits for the lift.
test('a 1.0.x patch may follow 1.0.0 only at the 1.0.0 preset digest', () => {
  const problems = collectReleasePreflightProblems(
    evidence({
      version: '1.0.1',
      freeze: { lifted: false, problems: [], digest: PRESET_DIGEST_1_0_0 },
      expectedPreset: preset1_0_0,
    })
  )
  assert.deepEqual(problems, [])
})

test('a python-policy tree may not be tagged as a 1.0.x patch', () => {
  for (const version of ['1.0.1', '1.0.2']) {
    const problems = collectReleasePreflightProblems(
      evidence({
        version,
        freeze: { lifted: false, problems: [], digest: PRESET_DIGEST_1_1_0 },
        expectedPreset: pythonPolicy,
      })
    )
    assert.ok(
      problems.includes(
        `release ${version} may ship only while default.json hashes to ${PRESET_DIGEST_1_0_0}; current digest is ${PRESET_DIGEST_1_1_0}`
      ),
      `${version} of the python-policy tree must be refused`
    )
  }
})

test('the owner-approved 1.1.0 Python line-bump exception may follow 1.0.0 at the reviewed digest', () => {
  assert.deepEqual(
    collectReleasePreflightProblems(
      evidence({
        version: '1.1.0',
        freeze: { lifted: false, problems: [], digest: PRESET_DIGEST_1_1_0 },
        expectedPreset: pythonPolicy,
      })
    ),
    []
  )
})

test('1.1.0 is refused when the preset digest is not the reviewed 1.1.0 policy', () => {
  for (const expectedPreset of [preset1_0_0, '{"extends":[]}\n']) {
    const problems = collectReleasePreflightProblems(
      evidence({
        version: '1.1.0',
        freeze: { lifted: false, problems: [], digest: hashPreset(expectedPreset) },
        expectedPreset,
      })
    )
    assert.ok(
      problems.includes(
        `release 1.1.0 may ship only while default.json hashes to ${PRESET_DIGEST_1_1_0}; current digest is ${hashPreset(expectedPreset)}`
      ),
      `1.1.0 with digest ${hashPreset(expectedPreset)} must be refused`
    )
  }
})

test('the live freeze digest is the reviewed 1.1.0 allowance', () => {
  assert.equal(hashPreset(pythonPolicy), PRESET_DIGEST_1_1_0)
  assert.equal(hashPreset(preset1_0_0), PRESET_DIGEST_1_0_0)
  assert.equal(collectPresetFreezeProblems().digest, PRESET_DIGEST_1_1_0)
  assert.equal(freezeReleasePresetDigest('1.1.0'), PRESET_DIGEST_1_1_0)
  assert.equal(freezeReleasePresetDigest('1.0.1'), PRESET_DIGEST_1_0_0)
  assert.equal(freezeReleasePresetDigest('1.0.2'), PRESET_DIGEST_1_0_0)
})

test('a mapped version with the wrong digest is refused after the freeze marker is lifted', () => {
  for (const version of ['1.0.1', '1.1.0']) {
    const required = freezeReleasePresetDigest(version)
    const problems = collectReleasePreflightProblems(
      evidence({
        version,
        freeze: { lifted: true, problems: [] },
        expectedPreset: '{"extends":[]}\n',
      })
    )
    assert.ok(
      problems.includes(
        `release ${version} may ship only while default.json hashes to ${required}; current digest is ${hashPreset('{"extends":[]}\n')}`
      ),
      `${version} with the wrong digest must be refused after lift`
    )
  }
})

test('a mapped version with the right digest is accepted after the freeze marker is lifted', () => {
  assert.deepEqual(
    collectReleasePreflightProblems(
      evidence({
        version: '1.0.1',
        freeze: { lifted: true, problems: [] },
        expectedPreset: preset1_0_0,
      })
    ),
    []
  )
  assert.deepEqual(
    collectReleasePreflightProblems(
      evidence({
        version: '1.1.0',
        freeze: { lifted: true, problems: [] },
        expectedPreset: pythonPolicy,
      })
    ),
    []
  )
})

test('an unmapped version such as 1.2.0 is allowed once the freeze marker is lifted', () => {
  assert.deepEqual(
    collectReleasePreflightProblems(
      evidence({
        version: '1.2.0',
        freeze: { lifted: true, problems: [] },
        expectedPreset: pythonPolicy,
      })
    ),
    []
  )
})

const FREEZE_REFUSAL =
  'during the preset freeze only a 1.0.x patch, the owner-approved 1.1.0 Python line-bump exception, or a byte-identical next-patch republish of an approved release may follow 1.0.0; any other new major, minor or patch requires the freeze to be lifted'

test('a new major or unreviewed minor still waits for the freeze to lift', () => {
  for (const version of ['1.2.0', '2.0.0']) {
    assert.ok(
      collectReleasePreflightProblems(
        evidence({ version, freeze: { lifted: false, problems: [], digest: PRESET_DIGEST_1_1_0 } })
      ).includes(FREEZE_REFUSAL),
      `${version} must be refused while the freeze holds`
    )
  }
})

// Issue #41: history was rewritten, and the immutable 1.0.0 and 1.1.0 tags
// cannot move onto it. The next patch of an approved release may republish
// that release's preset byte for byte, and nothing else.
function flipOneByte(content) {
  const index = content.indexOf('5 days')
  assert.ok(index >= 0, 'fixture must contain the five-day floor')
  return `${content.slice(0, index)}6${content.slice(index + 1)}`
}

test('the next patch of an approved release republishes its identical preset during the freeze', () => {
  assert.equal(freezeReleasePresetDigest('1.1.1'), PRESET_DIGEST_1_1_0)
  assert.deepEqual(
    collectReleasePreflightProblems(
      evidence({
        version: '1.1.1',
        freeze: { lifted: false, problems: [], digest: PRESET_DIGEST_1_1_0 },
        expectedPreset: pythonPolicy,
      })
    ),
    []
  )
})

test('a republish that changes one byte of the approved preset is refused', () => {
  const changed = flipOneByte(pythonPolicy)
  assert.equal(changed.length, pythonPolicy.length)
  assert.notEqual(hashPreset(changed), PRESET_DIGEST_1_1_0)
  for (const lifted of [false, true]) {
    const problems = collectReleasePreflightProblems(
      evidence({
        version: '1.1.1',
        freeze: { lifted, problems: [], digest: hashPreset(changed) },
        expectedPreset: changed,
      })
    )
    assert.ok(
      problems.includes(
        `release 1.1.1 may ship only while default.json hashes to ${PRESET_DIGEST_1_1_0}; current digest is ${hashPreset(changed)}`
      ),
      `a one-byte change under 1.1.1 must be refused (freeze lifted: ${lifted})`
    )
  }
})

test('a republish may not carry another approved release\'s preset', () => {
  const problems = collectReleasePreflightProblems(
    evidence({
      version: '1.1.1',
      freeze: { lifted: false, problems: [], digest: PRESET_DIGEST_1_0_0 },
      expectedPreset: preset1_0_0,
    })
  )
  assert.ok(
    problems.includes(
      `release 1.1.1 may ship only while default.json hashes to ${PRESET_DIGEST_1_1_0}; current digest is ${PRESET_DIGEST_1_0_0}`
    )
  )
})

test('identical bytes under a different minor or major are not a republish', () => {
  for (const version of ['1.2.1', '1.2.0', '2.1.1', '2.0.1', '0.1.1']) {
    assert.equal(freezeReleasePresetDigest(version), undefined, `${version} must stay unmapped`)
    assert.ok(
      collectReleasePreflightProblems(
        evidence({
          version,
          freeze: { lifted: false, problems: [], digest: PRESET_DIGEST_1_1_0 },
          expectedPreset: pythonPolicy,
        })
      ).includes(FREEZE_REFUSAL),
      `${version} must be refused while the freeze holds`
    )
  }
})

test('a republish of a version that was never approved is refused', () => {
  // 1.1.1 is itself a republish, not an approved release, so 1.1.2 does not
  // chain from it; nor does any patch skip past the approved release.
  for (const version of ['1.1.2', '1.1.3', '1.1.10', '0.0.1', '1.3.1']) {
    assert.equal(freezeReleasePresetDigest(version), undefined, `${version} must stay unmapped`)
    assert.ok(
      collectReleasePreflightProblems(
        evidence({
          version,
          freeze: { lifted: false, problems: [], digest: PRESET_DIGEST_1_1_0 },
          expectedPreset: pythonPolicy,
        })
      ).includes(FREEZE_REFUSAL),
      `${version} must be refused while the freeze holds`
    )
  }
})

test('malformed or oversized versions never resolve to an approved release', () => {
  for (const version of [
    '1.1.01',
    'v1.1.1',
    '1.1.1-rc.1',
    ' 1.1.1',
    '1.1.1\n',
    '01.1.1',
    '1.1',
    '1.1.9007199254740993',
    undefined,
  ]) {
    assert.equal(freezeReleasePresetDigest(version), undefined, `${JSON.stringify(version)} must stay unmapped`)
  }
})

test('a patch release cannot smuggle a changed preset past the freeze', () => {
  const problems = collectReleasePreflightProblems(
    evidence({
      version: '1.0.1',
      freeze: {
        lifted: false,
        problems: ['default.json changed while the preset bootstrap freeze is in effect.'],
        digest: PRESET_DIGEST_1_0_0,
      },
    })
  )
  assert.ok(problems.includes('default.json changed while the preset bootstrap freeze is in effect.'))
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
