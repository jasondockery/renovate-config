#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { isMainModule } from './is-main.mjs'
import { findPinnedRenovateRoot, importRenovateModule } from './pinned-renovate-runtime.mjs'
import { readRenovateVersion } from './renovate-runtime.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DAY = 24 * 60 * 60 * 1000
const MINUTE = 60 * 1000
const JUST_UNDER_FIVE_DAYS = 5 * DAY - MINUTE
const JUST_OVER_FIVE_DAYS = 5 * DAY + MINUTE
const JUST_UNDER_FOURTEEN_DAYS = 14 * DAY - MINUTE
const JUST_OVER_FOURTEEN_DAYS = 14 * DAY + MINUTE
const DEFAULT_POLICY_PATH = 'default.json'
const REVIEWED_DEFAULT_PATH = 'tools/fixtures/preset/default-five-day-policy.json'
const AUTOMERGE_POLICY_PATH = 'low-risk-automerge.json'
const REVIEWED_AUTOMERGE_PATH = 'tools/fixtures/preset/low-risk-automerge.json'

export function policyValidatorArguments(relativePath) {
  return ['--strict', '--no-global', relativePath]
}

function renovateCleanEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !key.startsWith('RENOVATE_')))
}

export function assertReviewedPolicy(accepted, reviewed, label = 'policy') {
  assert.ok(
    Array.isArray(accepted.description) && accepted.description.length > 0 &&
      accepted.description.every((line) => typeof line === 'string' && line.trim()),
    `${label} description must contain reviewed non-empty strings`
  )
  assert.deepEqual(accepted, reviewed, `${label} must match its exact owner-reviewed fixture`)
}

function readJson(repoRoot, relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'))
}

function validateReviewedPolicies(repoRoot, environment, run) {
  const pairs = [
    [DEFAULT_POLICY_PATH, REVIEWED_DEFAULT_PATH, 'default human-merge policy'],
    [AUTOMERGE_POLICY_PATH, REVIEWED_AUTOMERGE_PATH, 'standalone selective-automerge policy'],
  ]
  for (const [acceptedPath, reviewedPath, label] of pairs) {
    assertReviewedPolicy(readJson(repoRoot, acceptedPath), readJson(repoRoot, reviewedPath), label)
    const validated = run('renovate-config-validator', policyValidatorArguments(acceptedPath), {
      cwd: repoRoot,
      env: renovateCleanEnvironment(environment),
      encoding: 'utf8',
      timeout: 60_000,
    })
    if (validated.error) throw validated.error
    assert.equal(
      validated.status,
      0,
      `strict ${label} validation failed:\n${validated.stderr || validated.stdout || 'no output'}`
    )
  }
}

function release(millisecondsOld) {
  return {
    version: '1.1.0',
    releaseTimestamp: new Date(Date.now() - millisecondsOld).toISOString(),
  }
}

function dependency(config, overrides = {}) {
  return {
    ...config,
    currentValue: '1.0.0',
    currentVersion: '1.0.0',
    newValue: '1.1.0',
    newVersion: '1.1.0',
    datasource: 'npm',
    depName: 'fixture-package',
    packageName: 'fixture-package',
    manager: 'npm',
    versioning: 'semver',
    depType: 'devDependencies',
    updateType: 'minor',
    isMajor: false,
    isMinor: true,
    isPatch: false,
    major: 1,
    minor: 0,
    patch: 0,
    branchName: 'renovate/fixture-package-1.x',
    repository: 'jasondockery/fixture-consumer',
    baseBranch: 'main',
    groupName: null,
    pendingChecks: false,
    packageFile: 'package.json',
    ...overrides,
  }
}

async function policyResult(filterInternalChecks, versioning, config, millisecondsOld) {
  return filterInternalChecks(config, versioning, 'minor', [release(millisecondsOld)])
}

function authorityLines(rendered) {
  return rendered.match(/^Merge authority:.*$/gmu) ?? []
}

function configuredLabels(config) {
  return [...new Set([...(config.labels ?? []), ...(config.addLabels ?? [])])]
}

function assertRenderedAuthority(getPrHeader, generateBranchConfig, upgrades, expected) {
  const branch = generateBranchConfig(upgrades)
  const rendered = getPrHeader(branch)
  for (const field of ['Classification', 'Merge authority', 'Maturity', 'Developer action', 'AI review', 'Policy']) {
    const lines = rendered.match(new RegExp(`^${field}:.*$`, 'gmu')) ?? []
    assert.equal(
      lines.length,
      1,
      `rendered PR guidance must contain exactly one ${field} line for ${upgrades.map((upgrade) => upgrade.depName).join(', ')}:\n${rendered}`
    )
  }
  const lines = authorityLines(rendered)
  assert.match(
    lines[0],
    expected,
    `rendered merge authority contradicted the effective branch for ${upgrades.map((upgrade) => upgrade.depName).join(', ')}`
  )
  assert.match(rendered, /github\.com\/jasondockery\/fixture-consumer\/blob\/main\/renovate\.json/u)
  return { branch, rendered }
}

function stableDigest(value) {
  return createHash('sha256').update(`${JSON.stringify(value)}\n`).digest('hex')
}

export async function checkEffectivePolicy({
  repoRoot = repositoryRoot,
  environment = process.env,
  run = spawnSync,
  output = console,
} = {}) {
  const expectedVersion = readRenovateVersion(repoRoot)
  const runtimeRoot = findPinnedRenovateRoot(environment)
  const runtimeManifest = readJson(runtimeRoot, 'package.json')
  assert.equal(runtimeManifest.version, expectedVersion, 'PATH Renovate must match .renovate-version')
  validateReviewedPolicies(repoRoot, environment, run)

  const [
    { resolveConfigPresets },
    { mergeChildConfig },
    { applyPackageRules },
    { filterInternalChecks },
    { api: semver },
    { generateBranchConfig },
    { getPrHeader },
    { getPrNotes },
    { getOptions },
  ] = await Promise.all([
    importRenovateModule(runtimeRoot, 'config/presets/index.js'),
    importRenovateModule(runtimeRoot, 'config/utils.js'),
    importRenovateModule(runtimeRoot, 'util/package-rules/index.js'),
    importRenovateModule(runtimeRoot, 'workers/repository/process/lookup/filter-checks.js'),
    importRenovateModule(runtimeRoot, 'modules/versioning/semver/index.js'),
    importRenovateModule(runtimeRoot, 'workers/repository/updates/generate.js'),
    importRenovateModule(runtimeRoot, 'workers/repository/update/pr/body/header.js'),
    importRenovateModule(runtimeRoot, 'workers/repository/update/pr/body/notes.js'),
    importRenovateModule(runtimeRoot, 'config/options/index.js'),
  ])
  const renderPolicyGuidance = (branch) => getPrHeader(branch) || getPrNotes(branch)

  const updateTypeOption = getOptions().find((option) => option.name === 'matchUpdateTypes')
  assert.deepEqual(
    updateTypeOption?.allowedValues,
    ['major', 'minor', 'patch', 'pin', 'pinDigest', 'digest', 'lockFileMaintenance', 'rollback', 'bump', 'replacement'],
    'the pinned Renovate update-type inventory changed; classify the new engine semantics explicitly'
  )

  const defaultSource = readJson(repoRoot, DEFAULT_POLICY_PATH)
  const automergeSource = readJson(repoRoot, AUTOMERGE_POLICY_PATH)
  const localSource = readJson(repoRoot, 'renovate.json')
  const { config: resolvedDefault } = await resolveConfigPresets(
    structuredClone(defaultSource), structuredClone(defaultSource)
  )
  const { config: resolvedAutomerge } = await resolveConfigPresets(
    structuredClone(automergeSource), structuredClone(automergeSource)
  )
  const localWithoutRemotePreset = structuredClone(localSource)
  delete localWithoutRemotePreset.extends
  const { config: resolvedLocal } = await resolveConfigPresets(
    localWithoutRemotePreset, localWithoutRemotePreset
  )
  const resolvedConsumer = mergeChildConfig(resolvedAutomerge, resolvedLocal)

  assert.deepEqual(defaultSource.extends, ['config:best-practices'])
  assert.deepEqual(automergeSource.extends, ['config:best-practices'])
  assert.equal(
    JSON.stringify(automergeSource).includes('github>jasondockery/renovate-config'),
    false,
    'the named preset must be standalone rather than relying on a separately ordered repository preset'
  )
  assert.equal(resolvedDefault.schedule, undefined)
  assert.equal(resolvedAutomerge.schedule, undefined)

  const defaultRoutine = await applyPackageRules(dependency(resolvedDefault), 'default-human-proof')
  assert.equal(defaultRoutine.automerge, false, 'default.json must remain human-merge')
  assertRenderedAuthority(renderPolicyGuidance, generateBranchConfig, [defaultRoutine], /Human merge required/u)
  const defaultLockfile = await applyPackageRules(dependency(resolvedDefault, {
    updateType: 'lockFileMaintenance', isLockFileMaintenance: true, isMinor: false,
  }), 'default-lockfile-human-proof')
  assert.equal(defaultLockfile.automerge, false, 'default lockfile maintenance must remain human-merge')

  const eligibleMinor = await applyPackageRules(dependency(resolvedAutomerge), 'eligible-minor-proof')
  assert.equal(eligibleMinor.minimumReleaseAge, '14 days')
  assert.equal(eligibleMinor.internalChecksFilter, 'strict')
  assert.equal(eligibleMinor.automerge, true)
  assert.equal(eligibleMinor.automergeType, 'pr')
  assert.equal(eligibleMinor.ignoreTests, false)
  assert.equal(eligibleMinor.platformAutomerge, false)
  assert.deepEqual(
    configuredLabels(eligibleMinor).sort(),
    ['class:routine-dev', 'dependencies'].sort(),
    'eligible updates must expose a truthful class without an authority-bearing label'
  )
  assert.equal(
    (await policyResult(filterInternalChecks, semver, eligibleMinor, JUST_UNDER_FOURTEEN_DAYS)).pendingChecks,
    true
  )
  assert.equal(
    (await policyResult(filterInternalChecks, semver, eligibleMinor, JUST_OVER_FOURTEEN_DAYS)).pendingChecks,
    false
  )
  assertRenderedAuthority(renderPolicyGuidance, generateBranchConfig, [eligibleMinor], /Renovate may merge only/u)

  const eligiblePatch = await applyPackageRules(dependency(resolvedAutomerge, {
    updateType: 'patch', isMinor: false, isPatch: true, newValue: '1.0.1', newVersion: '1.0.1',
  }), 'eligible-patch-proof')
  assert.equal(eligiblePatch.automerge, true)

  const groupedEligibleMinor = {
    ...eligibleMinor,
    groupName: 'eligible-policy',
    branchName: 'renovate/eligible-policy',
  }
  const groupedEligiblePatch = {
    ...eligiblePatch,
    groupName: 'eligible-policy',
    branchName: 'renovate/eligible-policy',
    depName: 'second-fixture-package',
    packageName: 'second-fixture-package',
  }
  const eligibleGroup = assertRenderedAuthority(
    renderPolicyGuidance,
    generateBranchConfig,
    [groupedEligibleMinor, groupedEligiblePatch],
    /Renovate may merge only/u
  )
  assert.equal(eligibleGroup.branch.automerge, true, 'an all-eligible grouped PR must retain Renovate authority')
  assert.equal(
    eligibleGroup.branch.labels?.includes('review:human'),
    false,
    'an all-eligible grouped PR must not gain the denial marker'
  )

  const humanCases = [
    ['major', { updateType: 'major', isMajor: true, isMinor: false, newValue: '2.0.0', newVersion: '2.0.0' }],
    ['pre-1.0', { currentValue: '0.9.0', currentVersion: '0.9.0', newValue: '0.10.0', newVersion: '0.10.0', major: 0 }],
    ['production', { depType: 'dependencies' }],
    ['peer', { depType: 'peerDependencies' }],
    ['optional', { depType: 'optionalDependencies' }],
    ['action', { datasource: 'github-tags', manager: 'github-actions', depType: 'action' }],
    ['runtime', { depName: 'renovate', packageName: 'renovate' }],
    ['non-npm', { datasource: 'github-releases', manager: 'custom.regex', depName: 'sharkdp/bat', packageName: 'sharkdp/bat' }],
    ['pin', { updateType: 'pin', isMinor: false, isPin: true }],
    ['pin-digest', { updateType: 'pinDigest', isMinor: false, isPinDigest: true }],
    ['digest', { updateType: 'digest', isMinor: false, isDigest: true }],
    ['rollback', { updateType: 'rollback', isMinor: false, isRollback: true }],
    ['bump', { updateType: 'bump', isMinor: false }],
    ['replacement', { updateType: 'replacement', isMinor: false, isReplacement: true }],
    ['lockfile', { updateType: 'lockFileMaintenance', isMinor: false, isLockFileMaintenance: true }],
  ]
  const humanResults = new Map()
  for (const [label, overrides] of humanCases) {
    const effective = await applyPackageRules(dependency(resolvedAutomerge, overrides), `${label}-human-proof`)
    assert.equal(effective.automerge, false, `${label} must remain human-merge`)
    assert.equal(effective.platformAutomerge, false, `${label} must not gain platform merge authority`)
    assert.ok(configuredLabels(effective).includes('review:human'), `${label} must expose human review in the PR list`)
    assertRenderedAuthority(renderPolicyGuidance, generateBranchConfig, [effective], /Human merge required/u)
    humanResults.set(label, effective)
  }

  const vulnerabilityRule = {
    matchDatasources: ['npm'],
    matchPackageNames: ['fixture-package'],
    isVulnerabilityAlert: true,
    force: { ...resolvedAutomerge.vulnerabilityAlerts },
  }
  const vulnerability = await applyPackageRules(dependency({
    ...resolvedAutomerge,
    packageRules: [...resolvedAutomerge.packageRules, vulnerabilityRule],
  }, { isVulnerabilityAlert: true }), 'vulnerability-human-proof')
  assert.equal(vulnerability.minimumReleaseAge, null)
  assert.deepEqual(vulnerability.schedule, ['at any time'])
  assert.equal(vulnerability.automerge, false)
  assert.equal(vulnerability.platformAutomerge, false)
  assert.equal(
    (await policyResult(filterInternalChecks, semver, vulnerability, JUST_UNDER_FIVE_DAYS)).pendingChecks,
    false
  )
  assertRenderedAuthority(renderPolicyGuidance, generateBranchConfig, [vulnerability], /Human merge required/u)

  const mixedEligible = { ...eligibleMinor, groupName: 'mixed-policy', branchName: 'renovate/mixed-policy' }
  const mixedMajor = {
    ...humanResults.get('major'), groupName: 'mixed-policy', branchName: 'renovate/mixed-policy',
    depName: 'major-fixture', packageName: 'major-fixture',
  }
  const mixed = assertRenderedAuthority(
    renderPolicyGuidance, generateBranchConfig, [mixedEligible, mixedMajor], /Human merge required/u
  )
  assert.equal(mixed.branch.automerge, false, 'one ineligible update must make the complete grouped PR human-merge')
  assert.ok(mixed.branch.labels?.includes('review:human'), 'a mixed grouped PR must expose human review')

  const runnerInfrastructure = await applyPackageRules(dependency(resolvedConsumer, {
    depName: 'renovate', packageName: 'renovate',
  }), 'consumer-local-runner-infrastructure-proof')
  assert.equal(runnerInfrastructure.automerge, false, 'consumer-local rules must apply after the standalone preset')
  assert.ok(
    configuredLabels(runnerInfrastructure).includes('review:human'),
    'a consumer-local denial must retain the conservative human-review marker'
  )
  assertRenderedAuthority(
    renderPolicyGuidance,
    generateBranchConfig,
    [runnerInfrastructure],
    /Human merge required/u
  )

  const defaultNpm = await applyPackageRules(dependency(resolvedDefault), 'default-five-day-proof')
  assert.equal(defaultNpm.minimumReleaseAge, '5 days')
  assert.equal((await policyResult(filterInternalChecks, semver, defaultNpm, JUST_UNDER_FIVE_DAYS)).pendingChecks, true)
  assert.equal((await policyResult(filterInternalChecks, semver, defaultNpm, JUST_OVER_FIVE_DAYS)).pendingChecks, false)

  const resolvedDefaultConfigSha256 = stableDigest(resolvedDefault)
  const resolvedConfigSha256 = stableDigest(resolvedAutomerge)
  const readinessRegistry = readJson(repoRoot, 'automerge-consumers.json')
  assert.equal(
    readinessRegistry.humanMergeBaseline?.resolvedConfigSha256,
    resolvedDefaultConfigSha256,
    'automerge-consumers.json must bind the pinned engine human-baseline resolved-config digest'
  )
  assert.equal(
    readinessRegistry.preset?.resolvedConfigSha256,
    resolvedConfigSha256,
    'automerge-consumers.json must bind the pinned engine resolved-config digest'
  )
  output.log(
    `ok: Renovate ${expectedVersion} resolved standalone 14-day selective automerge, human default/lockfile/security/high-risk boundaries, local overrides, eligible-group authority, mixed-group denial, and rendered PR guidance (resolved sha256 ${resolvedConfigSha256})`
  )
  return { ok: true, version: expectedVersion, resolvedDefaultConfigSha256, resolvedConfigSha256 }
}

export function parseArguments(argv) {
  if (argv.length === 0) return {}
  throw new Error('usage: node tools/check-renovate-effective-policy.mjs')
}

if (isMainModule(import.meta.url)) {
  try {
    await checkEffectivePolicy(parseArguments(process.argv.slice(2)))
  } catch (error) {
    console.error(`effective Renovate policy failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
