import assert from 'node:assert/strict'
import test from 'node:test'
import {
  renderCompatibilityReport,
  validateCompatibilityReport,
} from './render-renovate-compatibility.mjs'

const fingerprint = `sha256:${'b'.repeat(64)}`
const repositories = [
  'jasondockery/renovate-config',
  'jasondockery/roost',
  'jasondockery/groundwork',
].map((repository) => ({
  repository,
  extractionTupleCount: 2,
  declarationCount: 2,
  scannerHitCount: 3,
  startingSha: 'a'.repeat(40),
  endingSha: 'a'.repeat(40),
  startingStatus: '',
  endingStatus: '',
  startingTrackedFingerprint: fingerprint,
  endingTrackedFingerprint: fingerprint,
  startingIgnoredFingerprint: fingerprint,
  endingIgnoredFingerprint: fingerprint,
  relevantIgnoredUnchanged: true,
}))
const report = {
  schema: 'renovate-config.compatibility-receipt',
  schemaVersion: 1,
  result: 'passed',
  source: 'github-actions',
  runId: '123',
  runAttempt: 1,
  testedRenovateConfigSha: 'a'.repeat(40),
  startedAt: '2026-08-03T01:00:00Z',
  finishedAt: '2026-08-03T01:01:00Z',
  renovateVersion: ['43', '272', '6'].join('.'),
  integration: { result: 'passed', status: 0, signal: null, error: '', stdoutTail: '', stderrTail: '' },
  identityProblems: [],
  repositories,
}

test('renders a self-identifying unchanged compatibility receipt', () => {
  assert.equal(validateCompatibilityReport(structuredClone(report)).result, 'passed')
  assert.match(renderCompatibilityReport(structuredClone(report)), /Extraction \| Scanner \| Source identity/)
})

test('rejects passed receipts with any changed source identity', () => {
  for (const mutate of [
    (value) => { value.repositories[0].endingSha = 'c'.repeat(40) },
    (value) => { value.repositories[0].endingStatus = '?? generated.json' },
    (value) => { value.repositories[0].endingTrackedFingerprint = `sha256:${'c'.repeat(64)}` },
    (value) => { value.repositories[0].relevantIgnoredUnchanged = false },
    (value) => { value.identityProblems.push('changed') },
  ]) {
    const changed = structuredClone(report)
    mutate(changed)
    assert.throws(() => validateCompatibilityReport(changed), /passed compatibility report/)
  }
})

test('rejects incomplete run identity, counts, and integration state', () => {
  const missingCount = structuredClone(report)
  missingCount.repositories[1].scannerHitCount = null
  assert.throws(() => validateCompatibilityReport(missingCount), /identity is invalid/)

  const failedIntegration = structuredClone(report)
  failedIntegration.integration.result = 'failed'
  failedIntegration.integration.status = 1
  failedIntegration.integration.error = 'synthetic integration failure'
  assert.throws(() => validateCompatibilityReport(failedIntegration), /failed integration/)
})

test('renders a failed receipt with unavailable counts and bounded diagnostics', () => {
  const failed = structuredClone(report)
  failed.result = 'failed'
  failed.integration = {
    result: 'failed',
    status: 1,
    signal: null,
    error: 'synthetic extraction failed',
    stdoutTail: '',
    stderrTail: 'bounded stderr evidence',
  }
  for (const repository of failed.repositories) {
    repository.extractionTupleCount = null
    repository.declarationCount = null
    repository.scannerHitCount = null
  }

  assert.equal(validateCompatibilityReport(failed).result, 'failed')
  const rendered = renderCompatibilityReport(failed)
  assert.match(rendered, /unavailable/)
  assert.match(rendered, /synthetic extraction failed/)
  assert.match(rendered, /bounded stderr evidence/)
})

test('rejects invalid versions and diagnostic-free failed integrations', () => {
  const invalidVersion = structuredClone(report)
  invalidVersion.renovateVersion = 'latest'
  assert.throws(() => validateCompatibilityReport(invalidVersion), /source identity or timing/)

  const noDiagnostic = structuredClone(report)
  noDiagnostic.result = 'failed'
  noDiagnostic.integration = {
    result: 'failed',
    status: null,
    signal: null,
    error: '',
    stdoutTail: '',
    stderrTail: '',
  }
  for (const repository of noDiagnostic.repositories) {
    repository.extractionTupleCount = null
    repository.declarationCount = null
    repository.scannerHitCount = null
  }
  assert.throws(() => validateCompatibilityReport(noDiagnostic), /no bounded diagnostic evidence/)
})
