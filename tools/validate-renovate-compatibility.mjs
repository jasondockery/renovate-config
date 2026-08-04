#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { writeAtomicJson } from './atomic-write.mjs'
import { isMainModule } from './is-main.mjs'
import { readRenovateVersion } from './renovate-runtime.mjs'
import {
  compareRepositorySnapshots,
  snapshotRepository,
  summarizeRelevantIgnored,
} from './repository-readonly-identity.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const MAX_FAILURE_DETAIL_BYTES = 4096
const COVERAGE_PREFIX = 'RENOVATE_COVERAGE_EVIDENCE '

function isInside(candidate, root) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

export function validateCompatibilityReportPath(file, targetRoots) {
  const target = path.resolve(file)
  const parent = fs.realpathSync(path.dirname(target))
  const resolvedTarget = path.join(parent, path.basename(target))
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
    throw new Error('compatibility report must not be a symbolic link')
  }
  for (const root of targetRoots) {
    const resolvedRoot = fs.realpathSync(root)
    if (isInside(resolvedTarget, resolvedRoot)) {
      throw new Error(`compatibility report must be outside every tested repository: ${resolvedRoot}`)
    }
  }
  return resolvedTarget
}

function boundedFailureDetail(value) {
  const text = String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '?')
  const bytes = Buffer.from(text)
  return bytes.length <= MAX_FAILURE_DETAIL_BYTES
    ? text
    : bytes.subarray(bytes.length - MAX_FAILURE_DETAIL_BYTES).toString('utf8')
}

export function parseCoverageEvidence(stdout, repositories) {
  const records = String(stdout ?? '').split(/\r?\n/u).filter((line) => line.startsWith(COVERAGE_PREFIX))
  if (records.length !== 1) throw new Error('integration output must contain exactly one coverage evidence record')
  const evidence = JSON.parse(records[0].slice(COVERAGE_PREFIX.length))
  if (!Array.isArray(evidence) || evidence.length !== repositories.length) {
    throw new Error('coverage evidence repository scope is incomplete')
  }
  return repositories.map((repository) => {
    const matches = evidence.filter((row) => row?.repository === repository)
    if (
      matches.length !== 1 ||
      !Number.isInteger(matches[0].tuples) || matches[0].tuples < 0 ||
      !Number.isInteger(matches[0].declarations) || matches[0].declarations < 0 ||
      !Number.isInteger(matches[0].scanHits) || matches[0].scanHits < 0
    ) throw new Error(`coverage evidence is invalid for ${repository}`)
    return matches[0]
  })
}

export function loadTargets(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'compatibility-targets.json'), 'utf8'))
  if (
    manifest.schemaVersion !== 1 ||
    !['manual-only', 'scheduled'].includes(manifest.activation) ||
    !Array.isArray(manifest.targets) ||
    manifest.targets.length !== 3
  ) throw new Error('compatibility-targets.json must declare activation and exactly three schema-v1 targets')
  return manifest.targets.map((target) => ({
    ...target,
    root: path.resolve(root, target.directory),
  }))
}

export function runCompatibility({
  root = repositoryRoot,
  environment = process.env,
  run = spawnSync,
  clock = () => new Date(),
  output = console,
} = {}) {
  const startedAt = clock().toISOString()
  const targets = loadTargets(root)
  const targetRoots = targets.map(({ root: targetRoot }) => targetRoot)
  const reportPath = environment.RENOVATE_COMPATIBILITY_REPORT
    ? validateCompatibilityReportPath(environment.RENOVATE_COMPATIBILITY_REPORT, targetRoots)
    : null
  const before = Object.fromEntries(targets.map((target) => [
    target.repository,
    snapshotRepository(target.root, target.ignoredPaths),
  ]))
  const version = readRenovateVersion(root)
  const completed = run(
    'npx',
    ['--yes', '--package', `renovate@${version}`, '--', 'node', 'tools/check-renovate-repository-coverage.mjs'],
    {
      cwd: root,
      env: environment,
      encoding: 'utf8',
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: 240_000,
    }
  )
  if (completed.stdout) output.log(completed.stdout.trimEnd())
  if (completed.stderr) output.error(completed.stderr.trimEnd())

  const after = Object.fromEntries(targets.map((target) => [
    target.repository,
    snapshotRepository(target.root, target.ignoredPaths),
  ]))
  const identityProblems = targets.flatMap((target) => compareRepositorySnapshots(
    target.repository,
    before[target.repository],
    after[target.repository]
  ))
  let coverageEvidence = []
  let evidenceError = ''
  try {
    coverageEvidence = parseCoverageEvidence(completed.stdout, targets.map(({ repository }) => repository))
  } catch (error) {
    evidenceError = error instanceof Error ? error.message : String(error)
  }
  const integrationResult = !completed.error && completed.status === 0 && !evidenceError ? 'passed' : 'failed'
  const integrationError = completed.error?.message || evidenceError || (
    integrationResult === 'failed'
      ? `Renovate integration exited with status ${completed.status ?? 'unavailable'} and signal ${completed.signal ?? 'none'}`
      : ''
  )
  const result = integrationResult === 'passed' && identityProblems.length === 0 ? 'passed' : 'failed'
  const coverageByRepository = new Map(coverageEvidence.map((row) => [row.repository, row]))
  const finishedAt = clock().toISOString()
  const policyRepository = targets.find(({ repository }) => repository === 'jasondockery/renovate-config')
  if (!policyRepository) throw new Error('compatibility targets must include renovate-config')
  const report = {
    schema: 'renovate-config.compatibility-receipt',
    schemaVersion: 1,
    result,
    source: environment.GITHUB_ACTIONS === 'true' ? 'github-actions' : 'local',
    runId: environment.GITHUB_RUN_ID ?? 'local',
    runAttempt: environment.GITHUB_RUN_ATTEMPT ? Number(environment.GITHUB_RUN_ATTEMPT) : 0,
    testedRenovateConfigSha: before[policyRepository.repository].headSha,
    startedAt,
    finishedAt,
    renovateVersion: version,
    integration: {
      result: integrationResult,
      status: Number.isInteger(completed.status) ? completed.status : null,
      signal: completed.signal ?? null,
      error: boundedFailureDetail(integrationError),
      stdoutTail: integrationResult === 'failed' ? boundedFailureDetail(completed.stdout) : '',
      stderrTail: integrationResult === 'failed' ? boundedFailureDetail(completed.stderr) : '',
    },
    identityProblems,
    repositories: targets.map((target) => ({
      repository: target.repository,
      extractionTupleCount: coverageByRepository.get(target.repository)?.tuples ?? null,
      declarationCount: coverageByRepository.get(target.repository)?.declarations ?? null,
      scannerHitCount: coverageByRepository.get(target.repository)?.scanHits ?? null,
      startingSha: before[target.repository].headSha,
      endingSha: after[target.repository].headSha,
      startingStatus: before[target.repository].status,
      endingStatus: after[target.repository].status,
      startingTrackedFingerprint: before[target.repository].trackedFingerprint,
      endingTrackedFingerprint: after[target.repository].trackedFingerprint,
      startingIgnoredFingerprint: summarizeRelevantIgnored(before[target.repository]),
      endingIgnoredFingerprint: summarizeRelevantIgnored(after[target.repository]),
      relevantIgnoredUnchanged: JSON.stringify(before[target.repository].relevantIgnored) ===
        JSON.stringify(after[target.repository].relevantIgnored),
    })),
  }
  if (reportPath) writeAtomicJson(reportPath, report)
  for (const repository of report.repositories) {
    output.log(`identity: ${repository.repository} ${repository.startingSha} ${repository.startingTrackedFingerprint}`)
  }
  for (const problem of identityProblems) output.error(`compatibility identity: ${problem}`)
  if (completed.error) output.error(`compatibility integration could not start: ${completed.error.message}`)
  if (evidenceError) output.error(`compatibility evidence: ${evidenceError}`)
  return report
}

if (isMainModule(import.meta.url)) {
  try {
    const report = runCompatibility()
    process.exitCode = report.result === 'passed' ? 0 : 1
  } catch (error) {
    console.error(`renovate compatibility: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
