import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  PRESET_DIGEST_1_0_0,
  PRESET_DIGEST_1_1_0,
} from './release-preflight.mjs'
import {
  collectReleaseVerificationProblems,
  parseReleaseVerificationArguments,
  resolveRemoteTagShas,
  runReleaseVerification,
  taggedPreset,
} from './release-verify.mjs'

const pythonPolicy = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'default.json'),
  'utf8'
)

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

test('a python-policy tree may not be verified as a 1.0.x patch', () => {
  for (const version of ['1.0.1', '1.0.2']) {
    const problems = collectReleaseVerificationProblems(evidence({
      version,
      release: { ...evidence().release, tag_name: version },
      expectedPreset: pythonPolicy,
      taggedPreset: pythonPolicy,
    }))
    assert.ok(
      problems.some((problem) => problem.includes(PRESET_DIGEST_1_0_0) && problem.includes(PRESET_DIGEST_1_1_0)),
      `${version} of the python-policy tree must be refused`
    )
  }
})

test('1.1.0 verification accepts only the reviewed python-policy digest', () => {
  assert.deepEqual(
    collectReleaseVerificationProblems(evidence({
      version: '1.1.0',
      release: { ...evidence().release, tag_name: '1.1.0' },
      expectedPreset: pythonPolicy,
      taggedPreset: pythonPolicy,
    })),
    []
  )
  const problems = collectReleaseVerificationProblems(evidence({
    version: '1.1.0',
    release: { ...evidence().release, tag_name: '1.1.0' },
    expectedPreset: '{"extends":[]}',
    taggedPreset: '{"extends":[]}',
  }))
  assert.ok(problems.some((problem) => problem.includes(PRESET_DIGEST_1_1_0)))
})

test('1.1.1 verification accepts only a byte-identical republish of 1.1.0', () => {
  const release = { ...evidence().release, tag_name: '1.1.1' }
  assert.deepEqual(
    collectReleaseVerificationProblems(evidence({
      version: '1.1.1',
      release,
      expectedPreset: pythonPolicy,
      taggedPreset: pythonPolicy,
    })),
    []
  )
  const index = pythonPolicy.indexOf('5 days')
  const changed = `${pythonPolicy.slice(0, index)}6${pythonPolicy.slice(index + 1)}`
  const problems = collectReleaseVerificationProblems(evidence({
    version: '1.1.1',
    release,
    expectedPreset: changed,
    taggedPreset: changed,
  }))
  assert.ok(problems.some((problem) => problem.includes(PRESET_DIGEST_1_1_0)))
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

// The doubles above inject an async taggedPreset, but createGithubApiClient
// runs gh through spawnSync and returns the decoded body directly. That gap let
// a .then() call on a plain object ship: it could not run until a release
// existed, so publishing 1.0.0 was its first execution. These bind the real
// helper to the synchronous client contract instead of a friendlier stand-in.
const syncClient = (response) => ({ get: () => response })

test('taggedPreset decodes content from the synchronous gh client', () => {
  const preset = taggedPreset('1.0.0', { repository: 'owner/repo' }, syncClient({
    encoding: 'base64',
    content: Buffer.from('{"extends":[]}', 'utf8').toString('base64') + '\n',
  }))
  assert.equal(preset, '{"extends":[]}')
})

test('taggedPreset rejects a response that is not base64 content', () => {
  for (const response of [
    { encoding: 'utf-8', content: 'plain' },
    { encoding: 'base64', content: undefined },
    undefined,
  ]) {
    assert.throws(
      () => taggedPreset('1.0.0', { repository: 'owner/repo' }, syncClient(response)),
      /base64 default\.json content/
    )
  }
})

test('CLI requires explicit version and expected release SHA', () => {
  assert.deepEqual(
    parseReleaseVerificationArguments(['--version', '1.0.0', '--expected-sha', SHA]),
    { version: '1.0.0', expectedSha: SHA }
  )
  assert.throws(() => parseReleaseVerificationArguments(['--version', '1.0.0']), /usage:/)
})
