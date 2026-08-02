import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  buildRenovateConfigReceipt,
  renderRenovateConfigSummary,
  writeRenovateConfigReceipt,
} from './renovate-config-receipt.mjs'

const tool = path.join(path.dirname(fileURLToPath(import.meta.url)), 'renovate-config-receipt.mjs')
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('workflow receipt preserves provenance, advisory budget, phases, and proof facts', () => {
  const receipt = buildRenovateConfigReceipt({
    receiptKind: 'ci-gate',
    title: 'CI',
    result: 'passed',
    scope: 'deterministic checks',
    platform: 'linux',
    proofType: 'fixture proof',
    startedEpoch: 100,
    finishedEpoch: 112,
    budgetSeconds: 10,
    phases: [
      { name: 'test', durationSeconds: 7, result: 'passed' },
      { name: 'validate', durationSeconds: 3, result: 'passed' },
    ],
    facts: { 'Read-only': 'passed' },
    reproduce: 'pnpm validate',
    reproduceLabel: 'Local tests/validation equivalent',
    repository: 'o/r',
    workflow: 'CI',
    job: 'validate',
    runId: '123',
    runAttempt: '2',
    event: 'pull_request',
    ref: 'refs/pull/1/merge',
    testedSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
  })
  assert.equal(receipt.durationSeconds, 12)
  assert.equal(receipt.budgetState, 'exceeded')
  assert.deepEqual(receipt.phases[0], {
    name: 'test',
    durationSeconds: 7,
    result: 'passed',
  })
  assert.equal(receipt.schema, 'renovate-config.run-receipt')
  assert.equal(receipt.compatibility.outcome, 'passed')
  assert.equal(receipt.compatibility.cacheState, 'unavailable')
  assert.equal(receipt.compatibility.commandKind, 'local-equivalent')
  assert.equal(receipt.compatibility.invalidationState, 'valid for exact run and tested SHA only')
  assert.equal(receipt.receiptKind, 'ci-gate')
  assert.equal(receipt.runId, 123)
  assert.equal(receipt.runAttempt, 2)
  assert.equal(receipt.testedSha, 'a'.repeat(40))
  assert.equal(receipt.headSha, 'b'.repeat(40))
  assert.match(renderRenovateConfigSummary(receipt), /\| test \| 7 \| passed \|/)
  assert.match(renderRenovateConfigSummary(receipt), /Read-only: passed/)
  assert.match(renderRenovateConfigSummary(receipt), /Local tests\/validation equivalent: `pnpm validate`/)
})

test('workflow receipt CLI validates all intent before writing', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-receipt-'))
  const output = path.join(directory, 'receipt.json')
  const summary = path.join(directory, 'summary.md')
  const phases = path.join(directory, 'phases.tsv')
  const facts = path.join(directory, 'facts.tsv')
  fs.writeFileSync(phases, 'tests\t4\tpassed\n')
  fs.writeFileSync(facts, 'Configs\t3\n')
  execFileSync(process.execPath, [
    tool,
    '--output', output,
    '--summary', summary,
    '--receipt-kind', 'ci-gate',
    '--title', 'Validation',
    '--result', 'passed',
    '--scope', 'repository config',
    '--platform', 'linux',
    '--proof-type', 'deterministic proof',
    '--started-epoch', '100',
    '--finished-epoch', '104',
    '--budget-seconds', '30',
    '--phase-file', phases,
    '--fact-file', facts,
    '--reproduce', 'pnpm validate',
    '--reproduce-label', 'Local tests/validation equivalent',
  ])
  assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).facts.Configs, '3')
  assert.match(fs.readFileSync(summary, 'utf8'), /Validation · Passed/)
  assert.match(fs.readFileSync(summary, 'utf8'), /Local tests\/validation equivalent/)

  const rejected = path.join(directory, 'rejected.json')
  const result = spawnSync(process.execPath, [tool, '--output', rejected, '--unknown', 'value'])
  assert.equal(result.status, 64)
  assert.equal(fs.existsSync(rejected), false)

  fs.writeFileSync(facts, 'Configs\t3\nConfigs\t4\n')
  const duplicateFacts = spawnSync(process.execPath, [
    tool,
    '--output', rejected,
    '--title', 'Validation',
    '--result', 'passed',
    '--scope', 'repository config',
    '--platform', 'linux',
    '--proof-type', 'deterministic proof',
    '--started-epoch', '100',
    '--finished-epoch', '104',
    '--budget-seconds', '30',
    '--phase-file', phases,
    '--fact-file', facts,
    '--reproduce', 'pnpm validate',
  ])
  assert.equal(duplicateFacts.status, 64)
  assert.equal(fs.existsSync(rejected), false)
})

test('workflow receipt rejects contradictory, forged, and control-character evidence', () => {
  const base = {
    title: 'CI',
    result: 'passed',
    scope: 'deterministic checks',
    platform: 'linux',
    proofType: 'fixture proof',
    startedEpoch: 100,
    finishedEpoch: 101,
    budgetSeconds: 10,
    phases: [{ name: 'test', durationSeconds: 1, result: 'passed' }],
    facts: {},
    reproduce: 'pnpm validate',
  }
  assert.throws(
    () => buildRenovateConfigReceipt({ ...base, testedSha: 'short' }),
    /complete 40-hex commit/
  )
  assert.throws(
    () => buildRenovateConfigReceipt({ ...base, startedEpoch: 0 }),
    /at least 1/
  )
  assert.throws(
    () => buildRenovateConfigReceipt({ ...base, title: 'CI\u001b[31m' }),
    /control character/
  )
  assert.throws(
    () => buildRenovateConfigReceipt({ ...base, reproduceLabel: 'Run everything' }),
    /unsupported command label/
  )
  assert.throws(
    () => buildRenovateConfigReceipt({
      ...base,
      phases: [base.phases[0], base.phases[0]],
    }),
    /duplicate phase/
  )
  assert.throws(
    () => buildRenovateConfigReceipt({
      ...base,
      phases: [{ name: 'test', durationSeconds: 1, result: 'skipped', reason: 'not run' }],
    }),
    /passed receipt/
  )
})

test('security receipt preserves implementation and private-caller provenance separately', () => {
  const receipt = buildRenovateConfigReceipt({
    receiptKind: 'security-hygiene',
    title: 'Security hygiene',
    result: 'passed',
    scope: 'private caller delivery',
    platform: 'linux',
    proofType: 'live reusable-workflow proof',
    startedEpoch: 100,
    finishedEpoch: 101,
    budgetSeconds: 300,
    phases: [{ name: 'report', durationSeconds: 1, result: 'passed' }],
    facts: {},
    reproduce: 'dispatch private caller',
    repository: 'owner/renovate-config',
    workflow: 'Security hygiene',
    job: 'report',
    runId: '456',
    runAttempt: '1',
    event: 'workflow_call',
    ref: 'refs/heads/main',
    testedSha: 'a'.repeat(40),
    implementationSha: 'a'.repeat(40),
    callerRepository: 'owner/private-operations',
    callerSha: 'b'.repeat(40),
  })
  assert.equal(receipt.implementationSha, 'a'.repeat(40))
  assert.deepEqual(receipt.caller, {
    repository: 'owner/private-operations',
    sha: 'b'.repeat(40),
  })
  assert.equal(receipt.runId, 456)
})

test('authoritative receipt output fails closed while an advisory summary fails open', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-receipt-output-'))
  const receiptInput = {
    title: 'CI',
    result: 'passed',
    scope: 'deterministic checks',
    platform: 'linux',
    proofType: 'fixture proof',
    startedEpoch: 100,
    finishedEpoch: 101,
    budgetSeconds: 10,
    phases: [{ name: 'test', durationSeconds: 1, result: 'passed' }],
    facts: {},
    reproduce: 'pnpm test',
  }
  const output = path.join(directory, 'receipt.json')
  const summaryDirectory = path.join(directory, 'summary-directory')
  fs.mkdirSync(summaryDirectory)
  const warnings = []

  const receipt = writeRenovateConfigReceipt({
    ...receiptInput,
    output,
    summary: summaryDirectory,
    warn: (message) => warnings.push(message),
  })
  assert.equal(receipt.result, 'passed')
  assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).result, 'passed')
  assert.match(warnings.join('\n'), /summary unavailable after authoritative receipt write/)

  const outputDirectory = path.join(directory, 'output-directory')
  const untouchedSummary = path.join(directory, 'must-not-exist.md')
  fs.mkdirSync(outputDirectory)
  assert.throws(
    () => writeRenovateConfigReceipt({
      ...receiptInput,
      output: outputDirectory,
      summary: untouchedSummary,
    })
  )
  assert.equal(fs.existsSync(untouchedSummary), false)
})

test('every executable workflow keeps one sanitized receipt and explicit retention contract', () => {
  const ci = fs.readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8')
  const renovate = fs.readFileSync(path.join(repoRoot, '.github/workflows/renovate.yml'), 'utf8')
  const hygiene = fs.readFileSync(path.join(repoRoot, '.github/workflows/security-hygiene.yml'), 'utf8')

  assert.match(ci, /--output ci-receipt\.json/)
  assert.match(ci, /--receipt-kind ci-gate/)
  assert.match(ci, /^  tests:\n/m)
  assert.match(ci, /^  validation:\n/m)
  assert.match(ci, /^  workflow_security:\n/m)
  assert.match(ci, /^  ci-gate:\n/m)
  assert.match(ci, /needs: \[tests, validation, workflow_security\]/)
  assert.match(ci, /TEST_DECLARED_RESULT: \$\{\{ needs\.tests\.outputs\.result/)
  assert.match(ci, /VALIDATION_DECLARED_RESULT: \$\{\{ needs\.validation\.outputs\.result/)
  assert.match(ci, /SECURITY_DECLARED_RESULT: \$\{\{ needs\.workflow_security\.outputs\.result/)
  assert.match(ci, /GitHub job result and declared lane result disagree/)
  assert.match(ci, /receipt_status=0/)
  assert.match(ci, /\[ "\$result" = passed \] && \[ "\$receipt_status" -eq 0 \]/)
  assert.match(ci, /Observed workflow span after first required lane started/)
  assert.match(ci, /Aggregate compute time/)
  assert.match(ci, /workflow security is CI-only/)
  assert.match(ci, /--reproduce-label 'Local tests\/validation equivalent'/)
  assert.doesNotMatch(ci, /if-no-files-found: ignore/)
  assert.match(ci, /authoritative CI receipt was written/)
  assert.match(ci, /retention-days: 30/)

  assert.match(renovate, /mktemp -d "\/tmp\/renovate-run-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}\.XXXXXX"/)
  assert.match(renovate, /chmod 0700 "\$log_dir"/)
  assert.match(renovate, /runner_uid="\$\(id -u\)"/)
  assert.match(renovate, /0\) echo "::error::Renovate must not run as root"; exit 1/)
  assert.match(renovate, /stat -Lc '%d:%i' "\$log_dir"/)
  assert.match(renovate, /printf 'LOG_FILE=%s\/renovate\.jsonl\\n' "\$log_dir" >> "\$GITHUB_ENV"/)
  assert.match(renovate, /printf 'directory=%s\\n' "\$log_dir" >> "\$GITHUB_OUTPUT"/)
  assert.match(renovate, /printf 'identity=%s\\n' "\$log_directory_identity" >> "\$GITHUB_OUTPUT"/)
  assert.match(renovate, /printf 'runner-uid=%s\\n' "\$runner_uid" >> "\$GITHUB_OUTPUT"/)
  assert.match(renovate, /docker-user: \$\{\{ steps\.renovate-log\.outputs\.runner-uid \}\}/)
  assert.match(renovate, /docker-volumes: '\$\{\{ steps\.renovate-log\.outputs\.directory \}\}:\$\{\{ steps\.renovate-log\.outputs\.directory \}\}'/)
  assert.doesNotMatch(renovate, /docker-volumes: \/tmp:\/tmp/)
  assert.match(renovate, /RENOVATE_LOG_DIR: \$\{\{ steps\.renovate-log\.outputs\.directory \}\}/)
  assert.match(renovate, /RENOVATE_LOG_DIR_IDENTITY: \$\{\{ steps\.renovate-log\.outputs\.identity \}\}/)
  assert.match(renovate, /tools\/renovate-run-receipt\.mjs/)
  assert.match(renovate, /--log-directory "\$RENOVATE_LOG_DIR"/)
  assert.match(renovate, /--log-directory-identity "\$RENOVATE_LOG_DIR_IDENTITY"/)
  assert.match(renovate, /--token-outcome "\$TOKEN_OUTCOME"/)
  assert.match(renovate, /--phase-file "\$RUNNER_TEMP\/renovate-phases\.tsv"/)
  assert.match(renovate, /GitHub App token mint/)
  assert.match(renovate, /RENOVATE_APP_PERMISSIONS/)
  assert.match(renovate, /receipt producer is the only cleanup authority/)
  assert.match(renovate, /no fallback deletion was attempted/)
  assert.doesNotMatch(renovate, /rm -f -- "\$LOG_FILE"/)
  assert.doesNotMatch(renovate, /rmdir -- "\$RENOVATE_LOG_DIR"/)
  assert.match(renovate, /authoritative Renovate receipt was written/)
  assert.doesNotMatch(renovate, /path: .*renovate-run\.jsonl/)
  assert.match(renovate, /retention-days: 30/)

  assert.match(hygiene, /--output security-hygiene-run\.json/)
  assert.match(hygiene, /--receipt-kind security-hygiene/)
  assert.match(hygiene, /renovate-config\/hygiene-state\.json/)
  assert.match(hygiene, /name: Upload run receipt/)
  assert.match(hygiene, /path: renovate-config\/security-hygiene-run\.json/)
  assert.match(hygiene, /--tested-sha "\$IMPLEMENTATION_REF"/)
  assert.match(hygiene, /--caller-repository "\$CALLER_REPOSITORY"/)
  assert.match(hygiene, /--caller-sha "\$CALLER_SHA"/)
  assert.match(hygiene, /Caller repository/)
  assert.match(hygiene, /authoritative security receipt was written/)
  assert.match(hygiene, /retention-days: 30/)
})
