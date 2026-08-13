#!/usr/bin/env node
import assert from 'node:assert/strict'
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
const ACCEPTED_POLICY_PATH = 'default.json'
const REVIEWED_POLICY_PATH = 'tools/fixtures/preset/default-five-day-policy.json'

export const policyValidatorArguments = Object.freeze([
  '--strict',
  '--no-global',
  ACCEPTED_POLICY_PATH,
])

function renovateCleanEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) => !key.startsWith('RENOVATE_'))
  )
}

export function assertReviewedPolicy(accepted, reviewed) {
  assert.ok(
    Array.isArray(accepted.description) &&
      accepted.description.length > 0 &&
      accepted.description.every((line) => typeof line === 'string' && line.trim()),
    'accepted policy description must contain reviewed non-empty strings'
  )
  assert.deepEqual(
    accepted,
    reviewed,
    'accepted default.json must match the exact owner-reviewed five-day policy fixture'
  )
}

function validateAcceptedPolicy(repoRoot, environment, run) {
  const accepted = JSON.parse(fs.readFileSync(path.join(repoRoot, 'default.json'), 'utf8'))
  const reviewed = JSON.parse(fs.readFileSync(path.join(repoRoot, REVIEWED_POLICY_PATH), 'utf8'))
  assertReviewedPolicy(accepted, reviewed)

  const validated = run('renovate-config-validator', policyValidatorArguments, {
    cwd: repoRoot,
    env: renovateCleanEnvironment(environment),
    encoding: 'utf8',
    timeout: 60_000,
  })
  if (validated.error) throw validated.error
  assert.equal(
    validated.status,
    0,
    `strict accepted-policy validation failed:\n${validated.stderr || validated.stdout || 'no output'}`
  )
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
    datasource: 'npm',
    depName: 'fixture-package',
    packageName: 'fixture-package',
    manager: 'npm',
    versioning: 'semver',
    ...overrides,
  }
}

async function policyResult(filterInternalChecks, versioning, config, millisecondsOld) {
  return filterInternalChecks(config, versioning, 'minor', [release(millisecondsOld)])
}

export async function checkEffectivePolicy({
  repoRoot = repositoryRoot,
  environment = process.env,
  run = spawnSync,
  output = console,
} = {}) {
  const expectedVersion = readRenovateVersion(repoRoot)
  const runtimeRoot = findPinnedRenovateRoot(environment)
  const runtimeManifest = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'package.json'), 'utf8'))
  assert.equal(runtimeManifest.version, expectedVersion, 'PATH Renovate must match .renovate-version')
  validateAcceptedPolicy(repoRoot, environment, run)

  const [{ resolveConfigPresets }, { applyPackageRules }, { filterInternalChecks }, { api: semver }] = await Promise.all([
    importRenovateModule(runtimeRoot, 'config/presets/index.js'),
    importRenovateModule(runtimeRoot, 'util/package-rules/index.js'),
    importRenovateModule(runtimeRoot, 'workers/repository/process/lookup/filter-checks.js'),
    importRenovateModule(runtimeRoot, 'modules/versioning/semver/index.js'),
  ])
  const source = JSON.parse(fs.readFileSync(path.resolve(repoRoot, ACCEPTED_POLICY_PATH), 'utf8'))
  const { config: resolved } = await resolveConfigPresets(structuredClone(source), structuredClone(source))
  assert.deepEqual(source.extends, ['config:best-practices'], 'the active preset must not add a routine calendar gate')
  assert.equal(Object.hasOwn(source, 'schedule'), false, 'routine updates must be eligible on every daily run')
  assert.equal(resolved.schedule, undefined, 'the resolved root policy must not inherit a routine calendar gate')

  const effectiveNpm = await applyPackageRules(
    dependency(resolved, { updateType: 'minor' }),
    'npm-five-day-proof'
  )
  assert.equal(effectiveNpm.minimumReleaseAge, '5 days', 'the later npm rule must override inherited age policy')
  assert.equal(effectiveNpm.internalChecksFilter, 'strict', 'the effective npm rule must fail closed while releases age')
  assert.equal(effectiveNpm.schedule, undefined, 'mature npm updates must advance on the next daily run')
  const npmJustUnder = await policyResult(filterInternalChecks, semver, effectiveNpm, JUST_UNDER_FIVE_DAYS)
  assert.equal(npmJustUnder.pendingChecks, true, 'an npm release one minute under five days must remain pending')
  const npmJustOver = await policyResult(filterInternalChecks, semver, effectiveNpm, JUST_OVER_FIVE_DAYS)
  assert.equal(npmJustOver.pendingChecks, false, 'an npm release one minute over five days must advance')

  const effectiveNonNpm = await applyPackageRules(dependency(resolved, {
    datasource: 'github-releases',
    depName: 'sharkdp/bat',
    packageName: 'sharkdp/bat',
    manager: 'custom.regex',
    updateType: 'minor',
  }), 'github-release-five-day-proof')
  assert.equal(effectiveNonNpm.minimumReleaseAge, '5 days')
  assert.equal(effectiveNonNpm.internalChecksFilter, 'strict')
  const nonNpmJustUnder = await policyResult(filterInternalChecks, semver, effectiveNonNpm, JUST_UNDER_FIVE_DAYS)
  assert.equal(nonNpmJustUnder.pendingChecks, true, 'a timestamped GitHub release one minute under five days must remain pending')
  const nonNpmJustOver = await policyResult(filterInternalChecks, semver, effectiveNonNpm, JUST_OVER_FIVE_DAYS)
  assert.equal(nonNpmJustOver.pendingChecks, false, 'a timestamped GitHub release one minute over five days must advance')

  const vulnerabilityRule = {
    matchDatasources: ['npm'],
    matchPackageNames: ['fixture-package'],
    isVulnerabilityAlert: true,
    force: { ...resolved.vulnerabilityAlerts },
  }
  const vulnerability = dependency({
    ...resolved,
    packageRules: [...resolved.packageRules, vulnerabilityRule],
  }, { isVulnerabilityAlert: true })
  const effectiveVulnerability = await applyPackageRules(vulnerability, 'vulnerability-proof')
  assert.equal(effectiveVulnerability.minimumReleaseAge, null)
  assert.deepEqual(effectiveVulnerability.schedule, ['at any time'])
  assert.equal(effectiveVulnerability.prHourlyLimit, 0)
  assert.equal(effectiveVulnerability.prConcurrentLimit, 0)
  assert.equal(effectiveVulnerability.prCreation, 'immediate')
  assert.equal(effectiveVulnerability.automerge, false, 'vulnerability updates must require human merge review')
  assert.equal(effectiveVulnerability.platformAutomerge, false, 'the platform must not merge vulnerability updates')
  const vulnerabilityJustUnder = await policyResult(
    filterInternalChecks,
    semver,
    effectiveVulnerability,
    JUST_UNDER_FIVE_DAYS
  )
  assert.equal(vulnerabilityJustUnder.pendingChecks, false, 'vulnerability updates must bypass the normal age floor')

  // `config:best-practices` assigns three days to these uncommon npm update
  // types. The later owner rule intentionally matches only major/minor/patch,
  // so pin the inherited behavior instead of implying that the five-day claim
  // covers every update type.
  for (const updateType of ['bump', 'rollback']) {
    const inherited = await applyPackageRules(
      dependency(resolved, { updateType }),
      `${updateType}-inherited-age-proof`
    )
    assert.equal(
      inherited.minimumReleaseAge,
      '3 days',
      `${updateType} updates must retain the reviewed inherited three-day policy`
    )
    assert.equal(inherited.internalChecksFilter, 'strict')
  }

  const lockfile = await applyPackageRules(dependency(resolved, {
    updateType: 'lockFileMaintenance',
    isLockFileMaintenance: true,
  }), 'lockfile-proof')
  assert.equal(lockfile.minimumReleaseAge, null, 'Renovate lockfile maintenance must not claim release-age enforcement')

  output.log(`ok: Renovate ${expectedVersion} resolved daily mature updates, five-day normal age, inherited bump/rollback age, human-reviewed security bypass, and weekly lockfile maintenance`)
  return { ok: true, version: expectedVersion }
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
