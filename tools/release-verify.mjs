#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { createGithubApiClient, readDesiredReleaseControls } from './release-controls.mjs'
import { isMainModule } from './is-main.mjs'
import {
  compareRepositorySnapshots,
  snapshotRepository,
} from './repository-readonly-identity.mjs'
import { readRenovateVersion } from './renovate-runtime.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const STABLE_VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u
const SHA = /^[0-9a-f]{40}$/u

export function collectReleaseVerificationProblems({
  version,
  expectedSha,
  before,
  remoteTagShas = [],
  release,
  expectedPreset,
  taggedPreset,
  presetResolved,
}) {
  const problems = []
  if (!STABLE_VERSION.test(version ?? '')) {
    problems.push('release version must be stable SemVer without a v prefix')
  }
  if (!SHA.test(expectedSha ?? '')) problems.push('expected release SHA must contain 40 lowercase hex characters')
  if (before?.headSha !== expectedSha) problems.push('current HEAD does not match the expected release SHA')
  if (before?.status) problems.push('release verification requires a clean repository')
  if (remoteTagShas.length !== 1 || remoteTagShas[0] !== expectedSha) {
    problems.push(`remote tag ${version} does not resolve uniquely to the expected release SHA`)
  }
  if (release?.tag_name !== version) problems.push('GitHub Release does not bind the requested tag')
  if (release?.draft !== false || release?.prerelease !== false) {
    problems.push('GitHub Release must be a published stable release')
  }
  if (release?.immutable !== true) problems.push('GitHub Release is not immutable')
  if (typeof taggedPreset !== 'string' || taggedPreset !== expectedPreset) {
    problems.push('tagged default.json does not match the expected release commit')
  }
  if (presetResolved !== true) {
    problems.push('Renovate could not resolve and validate the version-pinned preset')
  }
  return problems
}

function git(arguments_) {
  const result = spawnSync('git', ['-C', repositoryRoot, ...arguments_], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 30_000,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`git ${arguments_.join(' ')} failed: ${(result.stderr || 'no output').trim()}`)
  }
  return result.stdout
}

export function resolveRemoteTagShas(version, output) {
  const records = output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, reference] = line.split(/\s+/u)
      return { reference, sha }
    })
  const dereferenced = records.find(({ reference }) => reference === `refs/tags/${version}^{}`)
  const direct = records.find(({ reference }) => reference === `refs/tags/${version}`)
  return [dereferenced?.sha ?? direct?.sha].filter(Boolean)
}

function remoteTagShas(version) {
  return resolveRemoteTagShas(version, git([
    'ls-remote',
    '--tags',
    'origin',
    `refs/tags/${version}`,
    `refs/tags/${version}^{}`,
  ]))
}

function expectedPreset(expectedSha) {
  return git(['show', `${expectedSha}:default.json`])
}

// createGithubApiClient runs gh through spawnSync, so `get` returns the decoded
// body directly rather than a promise. The other callers await it, and awaiting
// a non-thenable is harmless, so only this one broke. It could not run until a
// release existed, so publishing 1.0.0 was also its first real execution.
export function taggedPreset(version, desired, client) {
  const response = client.get(
    `repos/${desired.repository}/contents/default.json?ref=${encodeURIComponent(version)}`
  )
  if (response?.encoding !== 'base64' || typeof response?.content !== 'string') {
    throw new Error('GitHub did not return base64 default.json content for the release tag')
  }
  return Buffer.from(response.content.replaceAll('\n', ''), 'base64').toString('utf8')
}

function resolvePinnedPreset(version) {
  const renovateVersion = readRenovateVersion(repositoryRoot)
  const resolver = fileURLToPath(new URL('./resolve-release-preset.mjs', import.meta.url))
  const result = spawnSync(
    'npx',
    [
      '--yes',
      '--package',
      `renovate@${renovateVersion}`,
      '--',
      'node',
      resolver,
      '--version',
      version,
    ],
    {
      cwd: repositoryRoot,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !name.startsWith('RENOVATE_'))
      ),
      stdio: 'inherit',
      timeout: 120_000,
    }
  )
  if (result.error) throw result.error
  return result.status === 0
}

function realDependencies(desired) {
  const client = createGithubApiClient(desired.apiVersion)
  return {
    expectedPreset,
    release: (version) => client.get(`repos/${desired.repository}/releases/tags/${encodeURIComponent(version)}`),
    remoteTags: remoteTagShas,
    resolvePreset: resolvePinnedPreset,
    snapshot: () => snapshotRepository(repositoryRoot),
    taggedPreset: (version) => taggedPreset(version, desired, client),
  }
}

export async function runReleaseVerification(
  { version, expectedSha },
  dependencies = realDependencies(readDesiredReleaseControls())
) {
  const before = dependencies.snapshot()
  const evidence = {
    before,
    expectedPreset: dependencies.expectedPreset(expectedSha),
    expectedSha,
    presetResolved: dependencies.resolvePreset(version),
    release: await dependencies.release(version),
    remoteTagShas: dependencies.remoteTags(version),
    taggedPreset: await dependencies.taggedPreset(version),
    version,
  }
  const problems = collectReleaseVerificationProblems(evidence)
  const after = dependencies.snapshot()
  problems.push(...compareRepositorySnapshots('renovate-config', before, after))
  return {
    schema: 'renovate-config.release-verification',
    schemaVersion: 1,
    result: problems.length === 0 ? 'passed' : 'failed',
    repository: 'jasondockery/renovate-config',
    version,
    expectedSha,
    releaseId: evidence.release?.id ?? null,
    problems: [...new Set(problems)],
  }
}

export function parseReleaseVerificationArguments(arguments_) {
  if (
    arguments_.length === 4 &&
    arguments_[0] === '--version' &&
    arguments_[2] === '--expected-sha'
  ) {
    return { version: arguments_[1], expectedSha: arguments_[3] }
  }
  throw new Error(
    'usage: node tools/release-verify.mjs --version X.Y.Z --expected-sha 40_HEX_SHA'
  )
}

if (isMainModule(import.meta.url)) {
  try {
    const receipt = await runReleaseVerification(
      parseReleaseVerificationArguments(process.argv.slice(2))
    )
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
    if (receipt.result !== 'passed') process.exitCode = 1
  } catch (error) {
    process.stderr.write(`release verification: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
