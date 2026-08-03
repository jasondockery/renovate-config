#!/usr/bin/env node
import fs from 'node:fs'
import process from 'node:process'
import { isMainModule } from './is-main.mjs'

const EXPECTED_REPOSITORIES = Object.freeze([
  'jasondockery/renovate-config',
  'jasondockery/roost',
  'jasondockery/groundwork',
])
const SHA = /^[0-9a-f]{40}$/u
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/u
const RENOVATE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u
const MAX_FAILURE_DETAIL_BYTES = 4096

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(new Date(value).getTime())
}

function validFailureDetail(value) {
  return typeof value === 'string' && Buffer.byteLength(value) <= MAX_FAILURE_DETAIL_BYTES
}

function identityChanged(repository) {
  return repository.startingSha !== repository.endingSha ||
    repository.startingStatus !== '' ||
    repository.endingStatus !== '' ||
    repository.startingTrackedFingerprint !== repository.endingTrackedFingerprint ||
    repository.startingIgnoredFingerprint !== repository.endingIgnoredFingerprint ||
    repository.relevantIgnoredUnchanged !== true
}

function inlineDetail(value) {
  return String(value).replace(/[\r\n\t]+/gu, ' ').replace(/`/gu, "'").replace(/\s{2,}/gu, ' ').trim()
}

export function validateCompatibilityReport(report) {
  if (report?.schema !== 'renovate-config.compatibility-receipt' || report.schemaVersion !== 1) {
    throw new Error('compatibility report schema is invalid')
  }
  if (!['passed', 'failed'].includes(report.result) || !['github-actions', 'local'].includes(report.source)) {
    throw new Error('compatibility report result or source is invalid')
  }
  if (
    (report.source === 'github-actions' && (!/^[1-9][0-9]*$/u.test(String(report.runId)) || !Number.isInteger(report.runAttempt) || report.runAttempt < 1)) ||
    (report.source === 'local' && (report.runId !== 'local' || report.runAttempt !== 0))
  ) throw new Error('compatibility report run identity is invalid')
  if (
    !SHA.test(report.testedRenovateConfigSha ?? '') ||
    !RENOVATE_VERSION.test(report.renovateVersion ?? '') ||
    !validTimestamp(report.startedAt) ||
    !validTimestamp(report.finishedAt) ||
    new Date(report.finishedAt) < new Date(report.startedAt)
  ) throw new Error('compatibility report source identity or timing is invalid')
  if (
    !report.integration ||
    !['passed', 'failed'].includes(report.integration.result) ||
    !Array.isArray(report.identityProblems) ||
    !Array.isArray(report.repositories) ||
    report.repositories.length !== EXPECTED_REPOSITORIES.length
  ) throw new Error('compatibility report evidence is incomplete')
  if (
    (![null, undefined].includes(report.integration.status) && !Number.isInteger(report.integration.status)) ||
    (![null, undefined].includes(report.integration.signal) && typeof report.integration.signal !== 'string') ||
    !validFailureDetail(report.integration.error) ||
    !validFailureDetail(report.integration.stdoutTail) ||
    !validFailureDetail(report.integration.stderrTail)
  ) throw new Error('compatibility report integration diagnostics are invalid')
  if (
    report.integration.result === 'failed' &&
    ![report.integration.error, report.integration.stdoutTail, report.integration.stderrTail].some((value) => value.trim())
  ) throw new Error('failed compatibility integration has no bounded diagnostic evidence')

  for (const repositoryName of EXPECTED_REPOSITORIES) {
    const matches = report.repositories.filter(({ repository }) => repository === repositoryName)
    if (matches.length !== 1) throw new Error(`compatibility report scope is invalid for ${repositoryName}`)
    const repository = matches[0]
    const countsValid = Number.isInteger(repository.extractionTupleCount) && repository.extractionTupleCount >= 0 &&
      Number.isInteger(repository.declarationCount) && repository.declarationCount >= 0 &&
      Number.isInteger(repository.scannerHitCount) && repository.scannerHitCount >= 0
    const failedCountsUnavailable = report.result === 'failed' && report.integration.result === 'failed' &&
      repository.extractionTupleCount === null && repository.declarationCount === null &&
      repository.scannerHitCount === null
    if (
      (!countsValid && !failedCountsUnavailable) ||
      !SHA.test(repository.startingSha ?? '') ||
      !SHA.test(repository.endingSha ?? '') ||
      typeof repository.startingStatus !== 'string' ||
      typeof repository.endingStatus !== 'string' ||
      !FINGERPRINT.test(repository.startingTrackedFingerprint ?? '') ||
      !FINGERPRINT.test(repository.endingTrackedFingerprint ?? '') ||
      !FINGERPRINT.test(repository.startingIgnoredFingerprint ?? '') ||
      !FINGERPRINT.test(repository.endingIgnoredFingerprint ?? '') ||
      typeof repository.relevantIgnoredUnchanged !== 'boolean'
    ) throw new Error(`compatibility report identity is invalid for ${repositoryName}`)
  }

  if (report.result === 'passed') {
    if (report.integration.result !== 'passed' || report.integration.status !== 0) {
      throw new Error('passed compatibility report has a failed integration result')
    }
    if (report.identityProblems.length !== 0) throw new Error('passed compatibility report contains identity problems')
    for (const repository of report.repositories) {
      if (identityChanged(repository)) throw new Error(`passed compatibility report contains changed source identity for ${repository.repository}`)
    }
    const policy = report.repositories.find(({ repository }) => repository === 'jasondockery/renovate-config')
    if (policy.startingSha !== report.testedRenovateConfigSha) {
      throw new Error('tested renovate-config SHA does not match the policy repository identity')
    }
  }
  return report
}

export function renderCompatibilityReport(report) {
  validateCompatibilityReport(report)
  const lines = [
    `## Latest-head Renovate compatibility · ${report.result}`,
    '',
    `Run: \`${report.runId}.${String(report.runAttempt)}\` · Renovate: \`${report.renovateVersion}\``,
    `Policy SHA: \`${report.testedRenovateConfigSha}\``,
    `Started: \`${report.startedAt}\` · Finished: \`${report.finishedAt}\``,
    '',
    '| Repository | Tested SHA | Declarations | Extraction | Scanner | Source identity |',
    '| --- | --- | ---: | ---: | ---: | --- |',
  ]
  for (const repository of report.repositories) {
    const unchanged = !identityChanged(repository)
    const declarations = repository.declarationCount ?? 'unavailable'
    const extraction = repository.extractionTupleCount ?? 'unavailable'
    const scanner = repository.scannerHitCount ?? 'unavailable'
    lines.push(
      `| ${repository.repository} | \`${repository.startingSha}\` | ${declarations} | ${extraction} | ` +
      `${scanner} | ${unchanged ? 'unchanged' : 'changed'} |`
    )
  }
  if (report.identityProblems.length > 0) {
    lines.push('', '### Identity findings', '')
    for (const problem of report.identityProblems) lines.push(`- ${problem}`)
  }
  if (report.integration.result === 'failed') {
    lines.push('', '### Integration failure', '')
    for (const [label, value] of [
      ['Error', report.integration.error],
      ['Standard error tail', report.integration.stderrTail],
      ['Standard output tail', report.integration.stdoutTail],
    ]) {
      if (value.trim()) lines.push(`- ${label}: \`${inlineDetail(value)}\``)
    }
  }
  return `${lines.join('\n')}\n`
}

if (isMainModule(import.meta.url)) {
  const input = process.argv[2]
  if (!input || process.argv.length !== 3) {
    console.error('usage: node tools/render-renovate-compatibility.mjs <report.json>')
    process.exit(64)
  }
  try {
    const report = JSON.parse(fs.readFileSync(input, 'utf8'))
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, renderCompatibilityReport(report))
    if (report.result !== 'passed') process.exitCode = 1
  } catch (error) {
    console.error(`renovate compatibility receipt: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
