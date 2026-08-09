import assert from 'node:assert/strict'
import test from 'node:test'
import {
  collectReleaseVerificationProblems,
  parseReleaseVerificationArguments,
  resolveRemoteTagShas,
  runReleaseVerification,
} from './release-verify.mjs'

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

function evidence(overrides = {}) {
  return {
    version: '1.0.0',
    expectedSha: SHA,
    before: snapshot(),
    remoteTagShas: [SHA],
    release: {
      id: 7,
      tag_name: '1.0.0',
      draft: false,
      prerelease: false,
      immutable: true,
    },
    expectedPreset: '{"extends":[]}',
    taggedPreset: '{"extends":[]}',
    presetResolved: true,
    ...overrides,
  }
}

test('published release must be stable, immutable, and exact-SHA bound', () => {
  const problems = collectReleaseVerificationProblems(evidence({
    version: 'v1.0.0',
    remoteTagShas: ['a'.repeat(40)],
    release: { tag_name: 'v1.0.0', draft: true, prerelease: false, immutable: false },
  }))
  assert.ok(problems.includes('release version must be stable SemVer without a v prefix'))
  assert.ok(problems.includes('remote tag v1.0.0 does not resolve uniquely to the expected release SHA'))
  assert.ok(problems.includes('GitHub Release must be a published stable release'))
  assert.ok(problems.includes('GitHub Release is not immutable'))
})

test('tagged preset must match the expected commit, independent of default branch state', () => {
  assert.ok(
    collectReleaseVerificationProblems(evidence({ taggedPreset: '{"different":true}' })).includes(
      'tagged default.json does not match the expected release commit'
    )
  )
})

test('annotated tags resolve through their dereferenced commit SHA', () => {
  assert.deepEqual(
    resolveRemoteTagShas(
      '1.0.0',
      `${'a'.repeat(40)}\trefs/tags/1.0.0\n${SHA}\trefs/tags/1.0.0^{}\n`
    ),
    [SHA]
  )
})

test('version-pinned Renovate resolution is mandatory', () => {
  assert.ok(
    collectReleaseVerificationProblems(evidence({ presetResolved: false })).includes(
      'Renovate could not resolve and validate the version-pinned preset'
    )
  )
})

test('successful verification preserves the repository and returns release identity', async () => {
  const result = await runReleaseVerification(
    { version: '1.0.0', expectedSha: SHA },
    {
      expectedPreset: () => '{"extends":[]}',
      release: async () => evidence().release,
      remoteTags: () => [SHA],
      resolvePreset: () => true,
      snapshot: () => snapshot(),
      taggedPreset: async () => '{"extends":[]}',
    }
  )
  assert.equal(result.result, 'passed')
  assert.equal(result.releaseId, 7)
})

test('repository mutation during verification fails closed', async () => {
  let count = 0
  const result = await runReleaseVerification(
    { version: '1.0.0', expectedSha: SHA },
    {
      expectedPreset: () => '{"extends":[]}',
      release: async () => evidence().release,
      remoteTags: () => [SHA],
      resolvePreset: () => true,
      snapshot: () => snapshot({ trackedFingerprint: `sha256:${count++}` }),
      taggedPreset: async () => '{"extends":[]}',
    }
  )
  assert.equal(result.result, 'failed')
  assert.ok(result.problems.includes('renovate-config tracked-file fingerprint changed'))
})

test('CLI requires explicit version and expected release SHA', () => {
  assert.deepEqual(
    parseReleaseVerificationArguments(['--version', '1.0.0', '--expected-sha', SHA]),
    { version: '1.0.0', expectedSha: SHA }
  )
  assert.throws(() => parseReleaseVerificationArguments(['--version', '1.0.0']), /usage:/)
})
