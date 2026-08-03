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
const PROPOSAL_PATH = 'tools/fixtures/preset/default-five-day-policy.json'
const PROPOSAL_RULE = Object.freeze({
  description: "Raise normal npm version updates above config:best-practices' three-day npm floor; update types without Renovate release-age support remain governed by their repository inventory controls.",
  matchDatasources: ['npm'],
  matchUpdateTypes: ['major', 'minor', 'patch'],
  minimumReleaseAge: '5 days',
  internalChecksFilter: 'strict',
})
const PROPOSAL_SECURITY = Object.freeze({
  enabled: true,
  schedule: ['at any time'],
  minimumReleaseAge: null,
  prHourlyLimit: 0,
  prConcurrentLimit: 0,
})

export const proposalValidatorArguments = Object.freeze([
  '--strict',
  '--no-global',
  PROPOSAL_PATH,
])

function renovateCleanEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) => !key.startsWith('RENOVATE_'))
  )
}

export function assertReviewedProposalDelta(accepted, proposal) {
  assert.ok(
    Array.isArray(proposal.description) &&
      proposal.description.length > 0 &&
      proposal.description.every((line) => typeof line === 'string' && line.trim()),
    'proposal description must contain reviewed non-empty strings'
  )
  const expected = structuredClone(accepted)
  expected.description = structuredClone(proposal.description)
  expected.internalChecksFilter = 'strict'
  expected.packageRules = [structuredClone(PROPOSAL_RULE)]
  expected.vulnerabilityAlerts = {
    ...structuredClone(accepted.vulnerabilityAlerts),
    ...structuredClone(PROPOSAL_SECURITY),
  }
  assert.deepEqual(
    proposal,
    expected,
    'proposal may differ from accepted default.json only in reviewed descriptions, strict age policy, and explicit security bypass fields'
  )
}

function validateProposalFixture(repoRoot, configPath, environment, run) {
  assert.equal(configPath, PROPOSAL_PATH, 'effective proposal proof accepts only the reviewed proposal fixture')
  const accepted = JSON.parse(fs.readFileSync(path.join(repoRoot, 'default.json'), 'utf8'))
  const proposal = JSON.parse(fs.readFileSync(path.join(repoRoot, configPath), 'utf8'))
  assertReviewedProposalDelta(accepted, proposal)

  const validated = run('renovate-config-validator', proposalValidatorArguments, {
    cwd: repoRoot,
    env: renovateCleanEnvironment(environment),
    encoding: 'utf8',
    timeout: 60_000,
  })
  if (validated.error) throw validated.error
  assert.equal(
    validated.status,
    0,
    `strict proposal validation failed:\n${validated.stderr || validated.stdout || 'no output'}`
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
  configPath = 'default.json',
  environment = process.env,
  run = spawnSync,
  output = console,
} = {}) {
  const expectedVersion = readRenovateVersion(repoRoot)
  const runtimeRoot = findPinnedRenovateRoot(environment)
  const runtimeManifest = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'package.json'), 'utf8'))
  assert.equal(runtimeManifest.version, expectedVersion, 'PATH Renovate must match .renovate-version')
  if (configPath !== 'default.json') validateProposalFixture(repoRoot, configPath, environment, run)

  const [{ resolveConfigPresets }, { applyPackageRules }, { filterInternalChecks }, { api: semver }] = await Promise.all([
    importRenovateModule(runtimeRoot, 'config/presets/index.js'),
    importRenovateModule(runtimeRoot, 'util/package-rules/index.js'),
    importRenovateModule(runtimeRoot, 'workers/repository/process/lookup/filter-checks.js'),
    importRenovateModule(runtimeRoot, 'modules/versioning/semver/index.js'),
  ])
  const source = JSON.parse(fs.readFileSync(path.resolve(repoRoot, configPath), 'utf8'))
  const { config: resolved } = await resolveConfigPresets(structuredClone(source), structuredClone(source))

  const effectiveNpm = await applyPackageRules(
    dependency(resolved, { updateType: 'minor' }),
    'npm-five-day-proof'
  )
  assert.equal(effectiveNpm.minimumReleaseAge, '5 days', 'the later npm rule must override inherited age policy')
  assert.equal(effectiveNpm.internalChecksFilter, 'strict', 'the effective npm rule must fail closed while releases age')
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
  const vulnerabilityJustUnder = await policyResult(
    filterInternalChecks,
    semver,
    effectiveVulnerability,
    JUST_UNDER_FIVE_DAYS
  )
  assert.equal(vulnerabilityJustUnder.pendingChecks, false, 'vulnerability updates must bypass the normal age floor')

  const lockfile = await applyPackageRules(dependency(resolved, {
    updateType: 'lockFileMaintenance',
    isLockFileMaintenance: true,
  }), 'lockfile-proof')
  assert.equal(lockfile.minimumReleaseAge, null, 'Renovate lockfile maintenance must not claim release-age enforcement')

  output.log(`ok: Renovate ${expectedVersion} resolved five-day normal updates, security bypass, and lockfile exception`)
  return { ok: true, version: expectedVersion }
}

export function parseArguments(argv) {
  if (argv.length === 0) return { configPath: 'default.json' }
  if (argv.length === 2 && argv[0] === '--config' && argv[1] && !path.isAbsolute(argv[1])) {
    return { configPath: argv[1] }
  }
  throw new Error('usage: node tools/check-renovate-effective-policy.mjs [--config <relative-path>]')
}

if (isMainModule(import.meta.url)) {
  try {
    await checkEffectivePolicy(parseArguments(process.argv.slice(2)))
  } catch (error) {
    console.error(`effective Renovate policy failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
