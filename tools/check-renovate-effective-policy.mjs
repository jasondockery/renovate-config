#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
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
const NAMED_PRESET_PATH = 'groundwork-core.json'
const REVIEWED_POLICY_PATH = 'tools/fixtures/preset/default-five-day-policy.json'
const GITMODULES_FIXTURE = 'tools/fixtures/dependency-extraction/.gitmodules.fixture'
const CORE_GITLINK = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const OTHER_GITLINK = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

export const policyValidatorArguments = Object.freeze([
  '--strict',
  '--no-global',
  ACCEPTED_POLICY_PATH,
])

export const namedPresetValidatorArguments = Object.freeze([
  '--strict',
  '--no-global',
  NAMED_PRESET_PATH,
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

function gitIn(directory, arguments_) {
  const result = spawnSync('git', ['-C', directory, ...arguments_], {
    encoding: 'utf8',
    timeout: 30_000,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`git ${arguments_.join(' ')} failed: ${(result.stderr || result.stdout || '').trim()}`)
  }
  return result.stdout
}

function materializeGitSubmodulesFixture(repoRoot) {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-gitmodules-'))
  fs.chmodSync(fixtureDir, 0o700)
  fs.copyFileSync(path.join(repoRoot, GITMODULES_FIXTURE), path.join(fixtureDir, '.gitmodules'))
  gitIn(fixtureDir, ['init'])
  gitIn(fixtureDir, ['config', 'user.email', 'groundwork-core-policy@example.test'])
  gitIn(fixtureDir, ['config', 'user.name', 'groundwork-core-policy'])
  gitIn(fixtureDir, ['config', 'commit.gpgsign', 'false'])
  gitIn(fixtureDir, ['add', '.gitmodules'])
  gitIn(fixtureDir, ['update-index', '--add', '--cacheinfo', `160000,${CORE_GITLINK},core`])
  gitIn(fixtureDir, ['update-index', '--add', '--cacheinfo', `160000,${OTHER_GITLINK},other`])
  gitIn(fixtureDir, ['commit', '--quiet', '-m', 'gitmodules fixture'])
  return fixtureDir
}

async function extractGitSubmodules(repoRoot, extractPackageFile, GlobalConfig) {
  const fixtureDir = materializeGitSubmodulesFixture(repoRoot)
  const previous = { ...GlobalConfig.get() }
  GlobalConfig.set({ ...previous, localDir: fixtureDir })
  try {
    const extracted = await extractPackageFile('', '.gitmodules', {})
    const deps = extracted?.deps ?? []
    const core = deps.find((dependency) => dependency.depName === 'core')
    const other = deps.find((dependency) => dependency.depName === 'other')
    assert.ok(core, 'the git-submodules fixture must yield a core dependency when branch = v0.8.0')
    assert.ok(other, 'the git-submodules fixture must yield a second submodule with a different depName')
    assert.equal(extracted.datasource, 'git-refs', 'git-submodules must extract through git-refs before package rules')
    assert.equal(core.currentValue, 'v0.8.0', 'core must take its current value from branch = v0.8.0')
    assert.equal(core.currentDigest, CORE_GITLINK)
    assert.equal(core.versioning, 'semver', 'a semver branch pin must select semver versioning')
    return { core, other, datasource: extracted.datasource }
  } finally {
    GlobalConfig.set(previous)
    fs.rmSync(fixtureDir, { force: true, recursive: true })
  }
}

function submoduleDependency(config, { dep, datasource, manager = 'git-submodules', updateType }) {
  return {
    ...config,
    ...(updateType === undefined ? {} : { updateType }),
    ...dep,
    datasource: dep.datasource ?? datasource,
    manager,
    currentVersion: dep.currentValue,
  }
}

function validateNamedPreset(repoRoot, environment, run) {
  const named = JSON.parse(fs.readFileSync(path.join(repoRoot, NAMED_PRESET_PATH), 'utf8'))
  assert.equal(
    Object.hasOwn(named, 'minimumReleaseAge'),
    false,
    'groundwork-core.json must inherit minimumReleaseAge from the default preset'
  )
  assert.equal(
    Object.hasOwn(named, 'internalChecksFilter'),
    false,
    'groundwork-core.json must inherit internalChecksFilter from the default preset'
  )
  assert.equal(named['git-submodules']?.enabled, true, 'groundwork-core.json must enable git-submodules')
  const rule = named.packageRules?.find((entry) =>
    JSON.stringify(entry.matchManagers) === JSON.stringify(['git-submodules']) &&
    JSON.stringify(entry.matchDepNames) === JSON.stringify(['core'])
  )
  assert.ok(rule, 'groundwork-core.json must contain the reviewed core submodule rule')
  assert.equal(rule.overrideDatasource, 'github-tags')
  assert.equal(rule.overridePackageName, 'jasondockery/groundwork-core')
  assert.equal(rule.versioning, 'semver')
  assert.equal(rule.groupName, 'groundwork-core')
  assert.equal(rule.commitMessageTopic, 'groundwork-core')
  assert.equal(rule.automerge, false)
  const digestRule = named.packageRules.find((entry) =>
    JSON.stringify(entry.matchDepNames) === JSON.stringify(['core']) &&
    JSON.stringify(entry.matchUpdateTypes) === JSON.stringify(['digest'])
  )
  assert.ok(digestRule, 'groundwork-core.json must disable core digest-only updates')
  assert.deepEqual(digestRule.matchManagers, ['git-submodules'])
  assert.equal(digestRule.enabled, false)
  const otherRule = named.packageRules.find((entry) =>
    JSON.stringify(entry.matchDepNames) === JSON.stringify(['!core'])
  )
  assert.ok(otherRule, 'groundwork-core.json must disable git-submodules other than core')
  assert.deepEqual(otherRule.matchManagers, ['git-submodules'])
  assert.equal(otherRule.enabled, false)
  const description = Array.isArray(named.description) ? named.description.join('\n') : String(named.description)
  assert.match(description, /gitlink must equal the commit of the tag/u, 'description must state the adoption requirement')
  assert.match(description, /matchDepNames/u, 'description must give the consumer group-rule exclusion snippet')

  const validated = run('renovate-config-validator', namedPresetValidatorArguments, {
    cwd: repoRoot,
    env: renovateCleanEnvironment(environment),
    encoding: 'utf8',
    timeout: 60_000,
  })
  if (validated.error) throw validated.error
  assert.equal(
    validated.status,
    0,
    `strict named-preset validation failed:\n${validated.stderr || validated.stdout || 'no output'}`
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

function pythonRuntime(config, extracted, overrides = {}) {
  return {
    ...config,
    ...extracted,
    manager: 'mise',
    currentVersion: extracted.currentValue,
    ...overrides,
  }
}

function pythonFromExtract(extracted, {
  manager,
  expectedPackageName,
  expectedDatasource,
  expectedCurrentValue,
}) {
  const python = extracted?.deps?.find((dependency) => dependency.depName === 'python')
  assert.ok(python, `the ${manager} extraction fixture must yield a python dependency from the manager`)
  if (expectedPackageName === undefined) {
    assert.notEqual(
      python.packageName,
      'python/cpython',
      `${manager} must not resolve python to python/cpython`
    )
  } else {
    assert.equal(python.packageName, expectedPackageName, `${manager} must resolve python to ${expectedPackageName}`)
  }
  assert.equal(python.datasource, expectedDatasource, `${manager} python must use the ${expectedDatasource} datasource`)
  assert.equal(
    python.currentValue,
    expectedCurrentValue,
    `the ${manager} extraction fixture must pin python ${expectedCurrentValue}`
  )
  return python
}

async function extractMisePython(repoRoot, extractPackageFile, GlobalConfig) {
  const fixture = fs.readFileSync(
    path.join(repoRoot, 'tools/fixtures/dependency-extraction/mise.toml.fixture'),
    'utf8'
  )
  const previous = { ...GlobalConfig.get() }
  GlobalConfig.set({ ...previous, localDir: previous.localDir ?? os.tmpdir() })
  try {
    return pythonFromExtract(await extractPackageFile(fixture, 'mise.toml'), {
      manager: 'mise',
      expectedPackageName: 'python/cpython',
      expectedDatasource: 'github-tags',
      expectedCurrentValue: '3.13.5',
    })
  } finally {
    GlobalConfig.set(previous)
  }
}

function extractAsdfPython(repoRoot, extractPackageFile) {
  const fixture = fs.readFileSync(
    path.join(repoRoot, 'tools/fixtures/dependency-extraction/.tool-versions.fixture'),
    'utf8'
  )
  return pythonFromExtract(extractPackageFile(fixture), {
    manager: 'asdf',
    expectedPackageName: 'python/cpython',
    expectedDatasource: 'github-tags',
    expectedCurrentValue: '3.13.5',
  })
}

function extractPyenvPython(repoRoot, extractPackageFile) {
  const fixture = fs.readFileSync(
    path.join(repoRoot, 'tools/fixtures/dependency-extraction/.python-version.fixture'),
    'utf8'
  )
  return pythonFromExtract(extractPackageFile(fixture), {
    manager: 'pyenv',
    expectedDatasource: 'docker',
    expectedCurrentValue: '3.13.5',
  })
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
  validateNamedPreset(repoRoot, environment, run)

  const [
    { resolveConfigPresets },
    { applyPackageRules },
    { filterInternalChecks },
    { api: semver },
    { extractPackageFile: extractMisePackageFile },
    { extractPackageFile: extractAsdfPackageFile },
    { extractPackageFile: extractPyenvPackageFile },
    { GlobalConfig },
    { getDefaultVersioning },
    { get: getVersioning },
    { classifyRelease },
    { mergeChildConfig },
    { extractPackageFile: extractGitSubmodulesPackageFile },
  ] = await Promise.all([
    importRenovateModule(runtimeRoot, 'config/presets/index.js'),
    importRenovateModule(runtimeRoot, 'util/package-rules/index.js'),
    importRenovateModule(runtimeRoot, 'workers/repository/process/lookup/filter-checks.js'),
    importRenovateModule(runtimeRoot, 'modules/versioning/semver/index.js'),
    importRenovateModule(runtimeRoot, 'modules/manager/mise/extract.js'),
    importRenovateModule(runtimeRoot, 'modules/manager/asdf/extract.js'),
    importRenovateModule(runtimeRoot, 'modules/manager/pyenv/extract.js'),
    importRenovateModule(runtimeRoot, 'config/global.js'),
    importRenovateModule(runtimeRoot, 'modules/datasource/common.js'),
    importRenovateModule(runtimeRoot, 'modules/versioning/index.js'),
    importRenovateModule(runtimeRoot, 'workers/repository/process/lookup/update-type.js'),
    importRenovateModule(runtimeRoot, 'config/utils.js'),
    importRenovateModule(runtimeRoot, 'modules/manager/git-submodules/index.js'),
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

  // Renovate 44 opts these update types out of minimumReleaseAge entirely, in
  // security:minimumReleaseAgeNpm, because they carry no release timestamp: an
  // age rule on them produced updates that would never come. Renovate 43
  // inherited three days here, so this pins the corrected upstream behavior
  // rather than the old number. It is the same stance this file already takes
  // for lockFileMaintenance below -- a policy that cannot be enforced must not
  // be claimed -- and the owner rule still matches only major/minor/patch, so
  // the five-day claim never covered these types either.
  //
  // The practical consequence is worth stating plainly: bump and rollback
  // updates are not age-gated. They were not effectively gated before either,
  // but the configuration used to imply that they were.
  for (const updateType of ['bump', 'rollback']) {
    const inherited = await applyPackageRules(
      dependency(resolved, { updateType }),
      `${updateType}-inherited-age-proof`
    )
    assert.equal(
      inherited.minimumReleaseAge,
      null,
      `${updateType} updates must not claim release-age enforcement they cannot perform`
    )
    assert.equal(inherited.internalChecksFilter, 'strict')
  }

  const lockfile = await applyPackageRules(dependency(resolved, {
    updateType: 'lockFileMaintenance',
    isLockFileMaintenance: true,
  }), 'lockfile-proof')
  assert.equal(lockfile.minimumReleaseAge, null, 'Renovate lockfile maintenance must not claim release-age enforcement')

  const pythonFromMise = await extractMisePython(repoRoot, extractMisePackageFile, GlobalConfig)
  const pythonVersioningName = pythonFromMise.versioning ?? getDefaultVersioning(pythonFromMise.datasource)
  const pythonVersioning = getVersioning(pythonVersioningName)
  const pythonLineBumpType = classifyRelease(pythonVersioning, pythonFromMise.currentValue, '3.15.0')
  assert.equal(
    pythonLineBumpType,
    'minor',
    'github-tags versioning at the pinned runtime must classify 3.13.5 to 3.15.0 as minor'
  )

  const pythonMinor = await applyPackageRules(
    pythonRuntime(resolved, pythonFromMise, { updateType: pythonLineBumpType }),
    'python-mise-line-bump-proof'
  )
  assert.equal(
    pythonMinor.dependencyDashboardApproval,
    true,
    'a Python 3.13 to 3.15 mise bump must wait for Dependency Dashboard approval'
  )
  assert.equal(pythonMinor.automerge, false, 'a Python 3.13 to 3.15 mise bump must never automerge')
  assert.equal(
    pythonMinor.minimumReleaseAge,
    '5 days',
    'Python line-bump approval must not loosen the five-day floor'
  )

  const pythonMajor = await applyPackageRules(
    pythonRuntime(resolved, pythonFromMise, { updateType: 'major' }),
    'python-mise-major-proof'
  )
  assert.equal(pythonMajor.dependencyDashboardApproval, true, 'a Python major line bump must wait for Dependency Dashboard approval')
  assert.equal(pythonMajor.automerge, false, 'a Python major line bump must never automerge')

  const pythonPatchType = classifyRelease(pythonVersioning, pythonFromMise.currentValue, '3.13.6')
  assert.equal(
    pythonPatchType,
    'patch',
    'github-tags versioning at the pinned runtime must classify 3.13.5 to 3.13.6 as patch'
  )
  const pythonPatch = await applyPackageRules(
    pythonRuntime(resolved, pythonFromMise, { updateType: pythonPatchType }),
    'python-mise-patch-proof'
  )
  assert.notEqual(
    pythonPatch.dependencyDashboardApproval,
    true,
    'a Python patch bump within a line must not require Dependency Dashboard approval'
  )
  assert.equal(
    pythonPatch.minimumReleaseAge,
    '5 days',
    'a Python patch bump must keep the five-day floor'
  )

  const pythonFromAsdf = extractAsdfPython(repoRoot, extractAsdfPackageFile)
  const asdfVersioningName = pythonFromAsdf.versioning ?? getDefaultVersioning(pythonFromAsdf.datasource)
  const asdfVersioning = getVersioning(asdfVersioningName)
  const pythonAsdfLineBumpType = classifyRelease(asdfVersioning, pythonFromAsdf.currentValue, '3.15.0')
  assert.equal(
    pythonAsdfLineBumpType,
    'minor',
    'github-tags versioning at the pinned runtime must classify asdf 3.13.5 to 3.15.0 as minor'
  )
  const pythonAsdfMinor = await applyPackageRules(
    pythonRuntime(resolved, pythonFromAsdf, { manager: 'asdf', updateType: pythonAsdfLineBumpType }),
    'python-asdf-minor-proof'
  )
  assert.equal(
    pythonAsdfMinor.dependencyDashboardApproval,
    true,
    'asdf Python maps to the same python/cpython package, so a minor line bump needs dashboard approval'
  )
  assert.equal(pythonAsdfMinor.automerge, false, 'asdf Python minor line bumps must never automerge')

  const pypiPython = await applyPackageRules(dependency(resolved, {
    datasource: 'pypi',
    depName: 'python',
    packageName: 'python',
    manager: 'pip_requirements',
    updateType: 'minor',
  }), 'pypi-python-proof')
  assert.notEqual(
    pypiPython.dependencyDashboardApproval,
    true,
    'a PyPI package named python must not inherit the CPython runtime line-bump gate'
  )

  const dockerPython = await applyPackageRules(dependency(resolved, {
    datasource: 'docker',
    depName: 'python',
    packageName: 'python',
    manager: 'dockerfile',
    updateType: 'minor',
  }), 'docker-python-proof')
  assert.notEqual(
    dockerPython.dependencyDashboardApproval,
    true,
    'a dockerfile python image must not inherit the CPython runtime line-bump gate'
  )

  const pythonFromPyenv = extractPyenvPython(repoRoot, extractPyenvPackageFile)
  const pyenvPython = await applyPackageRules(
    pythonRuntime(resolved, pythonFromPyenv, { manager: 'pyenv', updateType: 'minor' }),
    'pyenv-python-proof'
  )
  assert.notEqual(
    pyenvPython.dependencyDashboardApproval,
    true,
    'a pyenv python pin must not inherit the CPython runtime line-bump gate'
  )

  assert.notEqual(
    resolved['git-submodules']?.enabled,
    true,
    'default.json alone must leave git-submodules at Renovate\'s disabled default'
  )

  const namedSource = JSON.parse(fs.readFileSync(path.resolve(repoRoot, NAMED_PRESET_PATH), 'utf8'))
  const { config: resolvedNamed } = await resolveConfigPresets(
    structuredClone(namedSource),
    structuredClone(namedSource)
  )
  const resolvedCombined = mergeChildConfig(structuredClone(resolved), structuredClone(resolvedNamed))
  assert.equal(
    resolvedCombined['git-submodules']?.enabled,
    true,
    'default.json plus groundwork-core.json must enable git-submodules'
  )

  const { core, other, datasource: gitSubmodulesDatasource } = await extractGitSubmodules(
    repoRoot,
    extractGitSubmodulesPackageFile,
    GlobalConfig
  )

  const effectiveCore = await applyPackageRules(
    submoduleDependency(resolvedCombined, { dep: core, datasource: gitSubmodulesDatasource }),
    'groundwork-core-github-tags-proof'
  )
  assert.equal(effectiveCore.datasource, 'github-tags', 'core must resolve through github-tags after the named preset')
  assert.equal(
    effectiveCore.packageName,
    'jasondockery/groundwork-core',
    'core must look up jasondockery/groundwork-core on github-tags'
  )
  assert.equal(effectiveCore.groupName, 'groundwork-core')
  assert.equal(effectiveCore.commitMessageTopic, 'groundwork-core')
  assert.equal(effectiveCore.automerge, false, 'core pin bumps must require human merge')
  assert.equal(effectiveCore.minimumReleaseAge, '5 days', 'core must inherit the five-day floor')
  assert.equal(effectiveCore.internalChecksFilter, 'strict', 'core must inherit strict internal checks')
  assert.equal(effectiveCore.versioning, 'semver')
  const coreJustUnder = await policyResult(filterInternalChecks, semver, effectiveCore, JUST_UNDER_FIVE_DAYS)
  assert.equal(coreJustUnder.pendingChecks, true, 'a core tag one minute under five days must remain pending')
  const coreJustOver = await policyResult(filterInternalChecks, semver, effectiveCore, JUST_OVER_FIVE_DAYS)
  assert.equal(coreJustOver.pendingChecks, false, 'a core tag one minute over five days must advance')

  const coreDigest = await applyPackageRules(
    submoduleDependency(resolvedCombined, { dep: core, datasource: gitSubmodulesDatasource, updateType: 'digest' }),
    'groundwork-core-digest-disabled-proof'
  )
  assert.equal(coreDigest.enabled, false, 'core digest-only updates must be disabled')
  const coreMinor = await applyPackageRules(
    submoduleDependency(resolvedCombined, { dep: core, datasource: gitSubmodulesDatasource, updateType: 'minor' }),
    'groundwork-core-minor-enabled-proof'
  )
  assert.notEqual(coreMinor.enabled, false, 'core version updates must stay enabled')

  const otherWithCoreRule = await applyPackageRules(
    submoduleDependency(resolvedCombined, { dep: other, datasource: gitSubmodulesDatasource }),
    'other-submodule-untouched-by-core-rule-proof'
  )
  assert.equal(
    otherWithCoreRule.datasource,
    'git-refs',
    'a different submodule depName must not inherit the core github-tags override'
  )
  assert.notEqual(otherWithCoreRule.packageName, 'jasondockery/groundwork-core')
  assert.equal(otherWithCoreRule.enabled, false, 'a git-submodules dependency other than core must be disabled')
  assert.notEqual(otherWithCoreRule.groupName, 'groundwork-core')

  const otherDefaultOnly = await applyPackageRules(
    submoduleDependency(resolved, { dep: other, datasource: gitSubmodulesDatasource }),
    'other-submodule-default-only-proof'
  )
  assert.notEqual(
    otherDefaultOnly.datasource,
    'github-tags',
    'another submodule must stay off github-tags when only default.json is extended'
  )
  assert.notEqual(otherDefaultOnly.groupName, 'groundwork-core')

  output.log(`ok: Renovate ${expectedVersion} resolved daily mature updates, five-day normal age, unenforceable bump/rollback age declined, human-reviewed security bypass, weekly lockfile maintenance, Python line-bump dashboard approval, and opt-in groundwork-core submodule pin bumps`)
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
