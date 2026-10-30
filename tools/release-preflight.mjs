#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { collectPresetFreezeProblems } from './check-preset-freeze.mjs'
import { isMainModule } from './is-main.mjs'
import {
  checkReleaseControls,
  createGithubApiClient,
  readDesiredReleaseControls,
} from './release-controls.mjs'
import {
  compareRepositorySnapshots,
  snapshotRepository,
} from './repository-readonly-identity.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const STABLE_VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u
const SHA = /^[0-9a-f]{40}$/u
// sha256(default.json) at the 1.0.0 five-day policy. 1.0.x patches may ship
// only this digest; a later policy under a 1.0.x tag would rewrite #1.0.0 pins.
export const PRESET_DIGEST_1_0_0 = 'e62535b203f7beed6bf242178ff26d710179ea4d475b187aef5b5eb51108ad0f'
// sha256(default.json) at the reviewed 1.1.0 Python line-bump policy (issue #30).
export const PRESET_DIGEST_1_1_0 = 'd913658716e5ee2a22708a808345b9017a11836c3a7ff8fa64c7e0094965a8a0'
// Each mapped release is bound to one exact preset digest whether or not the
// freeze marker still exists. Add a row with a reason when the owner approves
// another exception. Unmapped versions wait only while the marker is present.
//
// A row with `approvedRelease` records that exact owner-approved release and
// the default.json digest it shipped. Its next patch, X.Y.(Z+1), is then a
// byte-identical republish: it is mapped to the same digest and may carry no
// other preset content (issue #41). Immutable tags cannot move, so this is how
// an approved release gets a tag on rewritten history. A version that only
// matches another republish never chains further.
const FREEZE_RELEASE_PRESETS = Object.freeze([
  {
    // Tooling patches on the 1.0 line. Allowed only while default.json still
    // hashes to the 1.0.0 five-day policy.
    versions: /^1\.0\.(?:[1-9][0-9]*)$/u,
    digest: PRESET_DIGEST_1_0_0,
  },
  {
    // Owner-approved Python line-bump exception (issue #30). Exactly 1.1.0,
    // and only the reviewed 1.1.0 digest. Its republish is 1.1.1 (issue #41).
    versions: /^1\.1\.0$/u,
    digest: PRESET_DIGEST_1_1_0,
    approvedRelease: '1.1.0',
  },
  {
    // Owner-approved groundwork-core named preset (issue #45). Exactly 1.2.0,
    // at the unchanged 1.1.0 default.json digest. default.json is not edited.
    // Deliberately no approvedRelease: a 1.2.1 republish is only digest-gated on
    // default.json, so it could ship an unreviewed groundwork-core.json. There
    // is also no rewritten-history reason for a republish path (unlike 1.1.0).
    versions: /^1\.2\.0$/u,
    digest: PRESET_DIGEST_1_1_0,
  },
])

// Fail at module load if a recorded approved release is malformed or not the
// version its own row admits, so a typo can never widen the republish rule.
export function assertApprovedReleases(rows) {
  for (const entry of rows) {
    if (entry.approvedRelease === undefined) continue
    if (
      typeof entry.approvedRelease !== 'string' ||
      !STABLE_VERSION.test(entry.approvedRelease) ||
      !entry.versions.test(entry.approvedRelease)
    ) {
      throw new Error(
        `FREEZE_RELEASE_PRESETS approvedRelease ${JSON.stringify(entry.approvedRelease)} must be stable SemVer admitted by its own row`
      )
    }
  }
}
assertApprovedReleases(FREEZE_RELEASE_PRESETS)

export function republishedReleaseOf(version) {
  if (!STABLE_VERSION.test(version ?? '')) return undefined
  const [major, minor, patch] = version.split('.')
  if (patch === '0') return undefined
  // BigInt keeps very large patch numbers exact; a rounded patch must never
  // land on an approved release.
  return `${major}.${minor}.${BigInt(patch) - 1n}`
}

export function freezeReleasePresetDigest(version) {
  const direct = FREEZE_RELEASE_PRESETS.find((entry) => entry.versions.test(version ?? ''))
  if (direct !== undefined) return direct.digest
  const previous = republishedReleaseOf(version)
  if (previous === undefined) return undefined
  return FREEZE_RELEASE_PRESETS.find((entry) => entry.approvedRelease === previous)?.digest
}

export function hashPreset(content) {
  return createHash('sha256').update(content ?? '').digest('hex')
}

export function collectMappedPresetDigestProblems(version, presetContent, digestLabel = 'current digest') {
  const requiredDigest = freezeReleasePresetDigest(version)
  if (requiredDigest === undefined) return []
  const actual = hashPreset(presetContent)
  if (actual === requiredDigest) return []
  return [
    `release ${version} may ship only while default.json hashes to ${requiredDigest}; ${digestLabel} is ${actual}`,
  ]
}

export function collectCiReceiptProblems(receipt, expectedSha) {
  const problems = []
  if (
    receipt?.schema !== 'renovate-config.run-receipt' ||
    receipt?.schemaVersion !== 1 ||
    receipt?.receiptKind !== 'ci-gate'
  ) {
    problems.push('exact-SHA CI artifact is not an authoritative ci-gate receipt')
  }
  if (
    receipt?.repository !== 'jasondockery/renovate-config' ||
    receipt?.workflow !== 'CI' ||
    receipt?.job !== 'ci-gate' ||
    receipt?.event !== 'push' ||
    receipt?.ref !== 'refs/heads/main'
  ) {
    problems.push('exact-SHA CI receipt is not the main-branch CI gate')
  }
  if (!Number.isInteger(receipt?.runId) || receipt.runId < 1 || !Number.isInteger(receipt?.runAttempt) || receipt.runAttempt < 1) {
    problems.push('exact-SHA CI receipt has no valid run identity')
  }
  if (receipt?.result !== 'passed') problems.push('exact-SHA CI receipt did not pass')
  if (receipt?.testedSha !== expectedSha || receipt?.headSha !== expectedSha) {
    problems.push('exact-SHA CI receipt does not bind the intended release commit')
  }
  if (receipt?.facts?.['Failed configs'] !== 'none') {
    problems.push('exact-SHA CI receipt reports failed or unavailable Renovate configs')
  }
  if (!/^\d+\.\d+\.\d+$/u.test(receipt?.facts?.['Renovate version'] ?? '')) {
    problems.push('exact-SHA CI receipt has no authoritative Renovate version')
  }
  if (!receipt?.facts?.['Configs validated by renovate-integration']?.split(', ').includes('default.json')) {
    problems.push('exact-SHA CI receipt did not validate default.json with renovate-integration')
  }
  if (
    receipt?.facts?.['Evidence errors'] !== 'none' ||
    !receipt?.facts?.['Read-only proof']?.includes('integration success')
  ) {
    problems.push('exact-SHA CI receipt lacks successful pinned-runtime integration evidence')
  }
  return problems
}

export function collectReleasePreflightProblems({
  version,
  expectedSha,
  before,
  localTagShas = [],
  remoteTagShas = [],
  controlsReceipt,
  freeze,
  expectedPreset,
  ciReceipt,
}) {
  const problems = []
  if (!STABLE_VERSION.test(version ?? '')) {
    problems.push('release version must be stable SemVer without a v prefix')
  }
  if (!SHA.test(expectedSha ?? '')) problems.push('expected release SHA must contain 40 lowercase hex characters')
  if (before?.headSha !== expectedSha) problems.push('current HEAD does not match the intended release SHA')
  if (before?.status) problems.push('release preflight requires a clean repository')
  if (localTagShas.length > 0 || remoteTagShas.length > 0) {
    problems.push(`release tag ${version} already exists locally or remotely`)
  }
  if (controlsReceipt?.result !== 'passed') {
    problems.push(...(controlsReceipt?.drift ?? ['release controls did not pass']))
  }
  if (freeze?.problems?.length > 0) problems.push(...freeze.problems)
  if (version === '1.0.0' && freeze?.lifted !== false) {
    problems.push('first release requires the matching preset bootstrap freeze to remain in effect')
  }
  // Mapped versions are bound to an exact default.json digest even after the
  // freeze marker is deleted, so a 1.0.x tag of a later policy tree cannot
  // rewrite #1.0.0 pins as a patch. Hash the intended SHA's default.json the
  // same way release:verify does. Unmapped versions wait only while the marker
  // is present: refusing every later release deadlocked the bootstrap once
  // 1.0.0 shipped a broken verifier.
  problems.push(...collectMappedPresetDigestProblems(version, expectedPreset))
  if (
    freezeReleasePresetDigest(version) === undefined &&
    version !== '1.0.0' &&
    freeze?.lifted === false
  ) {
    problems.push(
      'during the preset freeze only a 1.0.x patch, the owner-approved 1.1.0 Python line-bump exception, the owner-approved 1.2.0 groundwork-core named-preset exception, or a byte-identical next-patch republish of an approved release may follow 1.0.0; any other new major, minor or patch requires the freeze to be lifted'
    )
  }
  problems.push(...collectCiReceiptProblems(ciReceipt, expectedSha))
  return [...new Set(problems)]
}

function runGit(arguments_, { allowMissing = false } = {}) {
  const result = spawnSync('git', ['-C', repositoryRoot, ...arguments_], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
  })
  if (result.error) throw result.error
  if (result.status !== 0 && !allowMissing) {
    throw new Error(`git ${arguments_.join(' ')} failed: ${(result.stderr || 'no output').trim()}`)
  }
  return result.status === 0 ? result.stdout.trim() : ''
}

function localTagShas(version) {
  const value = runGit(['rev-parse', '--verify', '-q', `refs/tags/${version}^{commit}`], {
    allowMissing: true,
  })
  return value ? [value] : []
}

function remoteTagShas(version) {
  const output = runGit([
    'ls-remote',
    '--tags',
    'origin',
    `refs/tags/${version}`,
    `refs/tags/${version}^{}`,
  ])
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(/\s+/u)[0])
}

async function exactShaCiReceipt(expectedSha, desired, client) {
  const repository = `repos/${desired.repository}`
  const runs = await client.get(
    `${repository}/actions/workflows/ci.yml/runs?head_sha=${expectedSha}&status=completed&per_page=100`
  )
  const run = (runs?.workflow_runs ?? [])
    .filter(({ conclusion, event, head_branch: headBranch, head_sha: headSha }) =>
      conclusion === 'success' &&
      event === 'push' &&
      headBranch === 'main' &&
      headSha === expectedSha
    )
    .sort((left, right) => right.id - left.id)[0]
  if (!run) return undefined
  const artifacts = await client.get(`${repository}/actions/runs/${run.id}/artifacts?per_page=100`)
  const expectedName = `renovate-config-ci-receipt-${run.id}-${run.run_attempt}`
  const artifact = (artifacts?.artifacts ?? []).find(
    ({ expired, name }) => expired === false && name === expectedName
  )
  if (!artifact) return undefined

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-release-ci-'))
  try {
    client.downloadArtifact(run.id, artifact.name, directory, desired.repository)
    const receipt = JSON.parse(fs.readFileSync(path.join(directory, 'ci-receipt.json'), 'utf8'))
    if (receipt.runId !== run.id || receipt.runAttempt !== run.run_attempt) return undefined
    return receipt
  } finally {
    fs.rmSync(directory, { force: true, recursive: true })
  }
}

function runVerify() {
  const result = spawnSync('pnpm', ['verify'], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: 'inherit',
    timeout: 300_000,
  })
  if (result.error) throw result.error
  return result.status === 0
}

function expectedPresetAt(expectedSha) {
  const result = spawnSync('git', ['-C', repositoryRoot, 'show', `${expectedSha}:default.json`], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 30_000,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `git show ${expectedSha}:default.json failed: ${(result.stderr || 'no output').trim()}`
    )
  }
  return result.stdout
}

function realDependencies(desired) {
  const client = createGithubApiClient(desired.apiVersion)
  return {
    checkControls: () => checkReleaseControls({ desired, client }),
    ciReceipt: (sha) => exactShaCiReceipt(sha, desired, client),
    expectedPreset: expectedPresetAt,
    freeze: () => collectPresetFreezeProblems(repositoryRoot),
    localTags: localTagShas,
    remoteTags: remoteTagShas,
    runVerify,
    snapshot: () => snapshotRepository(repositoryRoot),
  }
}

export async function runReleasePreflight(
  { version, expectedSha },
  dependencies = realDependencies(readDesiredReleaseControls())
) {
  const before = dependencies.snapshot()
  const evidence = {
    before,
    ciReceipt: await dependencies.ciReceipt(expectedSha),
    controlsReceipt: await dependencies.checkControls(),
    expectedSha,
    expectedPreset: dependencies.expectedPreset(expectedSha),
    freeze: dependencies.freeze(),
    localTagShas: dependencies.localTags(version),
    remoteTagShas: dependencies.remoteTags(version),
    version,
  }
  const problems = collectReleasePreflightProblems(evidence)
  let verified = false
  if (problems.length === 0) {
    verified = dependencies.runVerify()
    if (!verified) problems.push('pnpm verify failed')
  }

  const after = dependencies.snapshot()
  problems.push(...compareRepositorySnapshots('renovate-config', before, after))
  if (dependencies.localTags(version).length > 0 || dependencies.remoteTags(version).length > 0) {
    problems.push(`release tag ${version} appeared during preflight`)
  }

  return {
    schema: 'renovate-config.release-preflight',
    schemaVersion: 1,
    result: problems.length === 0 ? 'passed' : 'failed',
    repository: 'jasondockery/renovate-config',
    version,
    expectedSha,
    verified,
    ciRunId: evidence.ciReceipt?.runId ?? null,
    controls: evidence.controlsReceipt?.result ?? 'failed',
    freeze: evidence.freeze?.lifted ? 'lifted' : 'active',
    problems: [...new Set(problems)],
  }
}

export function parseReleasePreflightArguments(arguments_) {
  if (
    arguments_.length === 4 &&
    arguments_[0] === '--version' &&
    arguments_[2] === '--expected-sha'
  ) {
    return { version: arguments_[1], expectedSha: arguments_[3] }
  }
  throw new Error(
    'usage: node tools/release-preflight.mjs --version X.Y.Z --expected-sha 40_HEX_SHA'
  )
}

if (isMainModule(import.meta.url)) {
  try {
    const receipt = await runReleasePreflight(parseReleasePreflightArguments(process.argv.slice(2)))
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
    if (receipt.result !== 'passed') process.exitCode = 1
  } catch (error) {
    process.stderr.write(`release preflight: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
