import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  parseRenovateLog,
  parseRenovateLogFile,
  renderRenovateSummary,
  writeRenovateReceipt,
} from './renovate-run-receipt.mjs'
import { buildRenovateConfigReceipt } from './renovate-config-receipt.mjs'
import { readRenovateVersion } from './renovate-runtime.mjs'

const expected = ['jasondockery/renovate-config', 'jasondockery/roost', 'jasondockery/groundwork']
const tool = path.join(path.dirname(fileURLToPath(import.meta.url)), 'renovate-run-receipt.mjs')
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const renovateVersion = readRenovateVersion(repositoryRoot)
const capturedFixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  `renovate-${renovateVersion}-structured-log.jsonl`
)
const preflightRecord = {
  level: 30,
  msg: 'Renovate log mount preflight passed',
}
const log = [
  { level: 30, repository: expected[0], msg: 'Repository started' },
  { level: 40, repository: expected[0], msg: 'Transient provider warning' },
  {
    level: 30,
    repository: expected[0],
    msg: 'Repository timing splits (milliseconds)',
    total: 12_345,
    splits: { init: 100, lookup: 12_245 },
  },
  { level: 50, repository: expected[1], msg: 'Provider request failed' },
  { level: 40, repository: expected[1], msg: 'Repository has errors' },
  {
    level: 30,
    repository: expected[1],
    msg: 'Repository timing splits (milliseconds)',
    total: 500,
  },
  {
    level: 30,
    repository: expected[2],
    msg: 'Repository timing splits (milliseconds)',
    total: 750,
  },
].map((entry) => JSON.stringify(entry)).join('\n')

function successfulLog(extraEntries = []) {
  return [
    preflightRecord,
    ...extraEntries,
    ...expected.map((repository, index) => ({
      level: 30,
      repository,
      msg: 'Repository timing splits (milliseconds)',
      total: (index + 1) * 1000,
    })),
  ].map((entry) => JSON.stringify(entry)).join('\n')
}

function directoryIdentity(directory) {
  const status = fs.lstatSync(directory, { bigint: true })
  return `${status.dev}:${status.ino}`
}

function cliFixture({
  prefix = 'renovate-run-case-',
  logText = successfulLog(),
  phaseText = 'GitHub App token mint\t1\tpassed\t\nRenovate execution\t2\tpassed\t\n',
  tokenOutcome = 'success',
  actionOutcome = 'success',
  createLog = true,
  output,
  summary,
} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const logDirectory = path.join(directory, 'private-log')
  fs.mkdirSync(logDirectory, { mode: 0o700 })
  const logFile = path.join(logDirectory, 'renovate.jsonl')
  const phaseFile = path.join(directory, 'phases.tsv')
  const outputFile = output ?? path.join(directory, 'receipt.json')
  const summaryFile = summary ?? path.join(directory, 'summary.md')
  if (createLog) fs.writeFileSync(logFile, logText)
  fs.writeFileSync(phaseFile, phaseText)
  const values = {
    '--log': logFile,
    '--log-directory': logDirectory,
    '--log-directory-identity': directoryIdentity(logDirectory),
    '--repositories': expected.join(','),
    '--token-outcome': tokenOutcome,
    '--outcome': actionOutcome,
    '--phase-file': phaseFile,
    '--version': '1.2.3',
    '--log-level': 'info',
    '--started-epoch': '100',
    '--finished-epoch': '103',
    '--output': outputFile,
    '--summary': summaryFile,
  }
  const arguments_ = [tool]
  for (const [name, value] of Object.entries(values)) arguments_.push(name, value)
  return {
    directory,
    logDirectory,
    logFile,
    output: outputFile,
    summary: summaryFile,
    values,
    arguments_,
  }
}

test('Renovate structured logs become bounded per-repository facts', () => {
  assert.deepEqual(parseRenovateLog(log, expected), {
    repositories: [
      {
        repository: expected[0],
        durationSeconds: 13,
        warnings: 1,
        errors: 0,
        result: 'passed',
      },
      {
        repository: expected[1],
        durationSeconds: 1,
        warnings: 1,
        errors: 1,
        result: 'failed',
      },
      {
        repository: expected[2],
        durationSeconds: 1,
        warnings: 0,
        errors: 0,
        result: 'passed',
      },
    ],
    evidence: {
      containerLogPreflight: false,
      sourceConfirmedMessageLessUpdates: 0,
      globalWarnings: 0,
      globalErrors: 0,
      unexpectedRepositoryRecords: 0,
      unexpectedRepositoryInformational: 0,
      unexpectedRepositoryWarnings: 0,
      unexpectedRepositoryErrors: 0,
      unexpectedRepositoryTimings: 0,
    },
  })
})

test('the sanitized pinned-runtime fixture preserves real lifecycle and timing shapes', () => {
  const parsed = parseRenovateLogFile(capturedFixture, expected)
  assert.deepEqual(
    parsed.repositories.map(({ repository, durationSeconds, result }) => ({
      repository,
      durationSeconds,
      result,
    })),
    [
      { repository: expected[0], durationSeconds: 1, result: 'passed' },
      { repository: expected[1], durationSeconds: 2, result: 'failed' },
      { repository: expected[2], durationSeconds: 3, result: 'passed' },
    ]
  )
  assert.equal(parsed.evidence.globalWarnings, 1)
  assert.equal(parsed.evidence.globalErrors, 1)
  assert.equal(parsed.evidence.sourceConfirmedMessageLessUpdates, 1)
  const fixtureText = fs.readFileSync(capturedFixture, 'utf8')
  assert.doesNotMatch(fixtureText, /token|authorization|payload|stderr|branchName/i)
})

test('structured log parsing bounds bytes, lines, line length, and unknown shapes', () => {
  const oneTiming = JSON.stringify({
    level: 30,
    repository: expected[0],
    msg: 'Repository timing splits (milliseconds)',
    total: 1,
  })
  assert.throws(
    () => parseRenovateLog(oneTiming, [expected[0]], { byteLimit: 1 }),
    /byte limit/
  )
  assert.throws(
    () => parseRenovateLog(`${oneTiming}\n${oneTiming}`, [expected[0]], { lineLimit: 1 }),
    /line limit/
  )
  assert.throws(
    () => parseRenovateLog(oneTiming, [expected[0]], { lineByteLimit: 10 }),
    /line 1.*byte limit/
  )
  assert.throws(
    () => parseRenovateLog(oneTiming, [expected[0]], { parseMilliseconds: 0 }),
    /parse limit must be a positive safe integer/
  )
  assert.throws(
    () => parseRenovateLog(JSON.stringify({ repository: expected[0], msg: 'Repository started' }), [expected[0]]),
    /unknown level shape/
  )
  assert.throws(
    () => parseRenovateLog(JSON.stringify({ level: 30, repository: expected[0], payload: {} }), [expected[0]]),
    /has no message/
  )
})

test('only the source-confirmed logger.debug({ update }) record may omit a message', () => {
  const approved = {
    name: 'renovate',
    level: 20,
    repository: expected[0],
    baseBranch: 'main',
    update: {
      bucket: 'non-major',
      newVersion: '1.1.0',
      newValue: '^1.1.0',
      updateType: 'minor',
    },
  }
  const parsed = parseRenovateLog(successfulLog([approved]), expected)
  assert.equal(parsed.evidence.sourceConfirmedMessageLessUpdates, 1)

  for (const mutate of [
    (entry) => { entry.level = 30 },
    (entry) => { entry.extra = true },
    (entry) => { entry.update.extra = true },
    (entry) => { delete entry.update.newValue },
    (entry) => { entry.msg = '' },
    (entry) => { entry.msg = '   ' },
  ]) {
    const hostile = structuredClone(approved)
    mutate(hostile)
    assert.throws(
      () => parseRenovateLog(successfulLog([hostile]), expected),
      /has no message/
    )
  }
})

test('successful parsing fails closed on missing, malformed, or duplicate timing facts', () => {
  assert.throws(
    () => parseRenovateLog(`${JSON.stringify({ level: 30, repository: expected[0], msg: 'Repository started' })}\n`, expected),
    /omitted repository timing/
  )
  assert.throws(() => parseRenovateLog('{broken', expected), /line 1/)
  assert.throws(() => parseRenovateLog(`${log}\n${JSON.stringify({ level: 30, repository: expected[0], msg: 'Repository timing splits (milliseconds)', total: 1 })}`, expected), /duplicate/)
  assert.throws(
    () => parseRenovateLog(log, ['invalid repository']),
    /owner\/name slugs/
  )
  assert.throws(
    () => parseRenovateLog(
      JSON.stringify({ level: 30, repository: expected[0], msg: 'Repository timing splits (milliseconds)', total: Number.MAX_SAFE_INTEGER + 1 }),
      [expected[0]]
    ),
    /non-negative total/
  )
})

test('failed Renovate executions can publish an honest partial receipt', () => {
  const { repositories } = parseRenovateLog(
    `${JSON.stringify({ level: 50, repository: expected[0], msg: 'Authentication failed' })}\n`,
    expected,
    { requireComplete: false }
  )
  assert.equal(repositories[0].result, 'failed')
  assert.equal(repositories[1].result, 'unknown')

  const receipt = buildRenovateConfigReceipt({
    title: 'Renovate run',
    result: 'failed',
    scope: 'three repositories',
    platform: 'linux',
    proofType: 'live run',
    startedEpoch: 100,
    finishedEpoch: 101,
    budgetSeconds: 10,
    facts: {},
    reproduce: 'workflow_dispatch',
  })
  receipt.repositories = repositories
  assert.match(renderRenovateSummary(receipt), /unavailable/)
})

test('global severity and unexpected repositories become bounded fail-closed evidence', () => {
  const entries = [
    { level: 60, msg: 'global fatal with sensitive detail' },
    { level: 40, msg: 'global warning with sensitive detail' },
    { level: 50, repository: 'unexpected/error', msg: 'unexpected error' },
    {
      level: 30,
      repository: 'unexpected/timing',
      msg: 'Repository timing splits (milliseconds)',
      total: 1,
    },
  ]
  const parsed = parseRenovateLog(successfulLog(entries), expected)
  assert.deepEqual(parsed.evidence, {
    containerLogPreflight: true,
    sourceConfirmedMessageLessUpdates: 0,
    globalWarnings: 1,
    globalErrors: 1,
    unexpectedRepositoryRecords: 2,
    unexpectedRepositoryInformational: 1,
    unexpectedRepositoryWarnings: 0,
    unexpectedRepositoryErrors: 1,
    unexpectedRepositoryTimings: 1,
  })
})

test('action-success receipts fail on dangerous unexpected evidence but advise on informational records', () => {
  const cases = [
    ['global-fatal', { level: 60, msg: 'global fatal' }, 1, /global ERROR\/FATAL/],
    ['unexpected-error', { level: 50, repository: 'unexpected/error', msg: 'failed' }, 1, /unexpected repositories/],
    [
      'unexpected-timing',
      { level: 30, repository: 'unexpected/timing', msg: 'Repository timing splits (milliseconds)', total: 1 },
      1,
      /unexpected repositories/,
    ],
  ]
  for (const [name, entry, expectedStatus, evidencePattern] of cases) {
    const fixture = cliFixture({ prefix: `renovate-${name}-`, logText: successfulLog([entry]) })
    const result = spawnSync(process.execPath, fixture.arguments_)
    assert.equal(result.status, expectedStatus, name)
    const receipt = JSON.parse(fs.readFileSync(fixture.output, 'utf8'))
    assert.equal(receipt.result, 'failed', name)
    assert.match(receipt.facts['Structured evidence'], evidencePattern, name)
    assert.doesNotMatch(JSON.stringify(receipt), /global fatal|unexpected\/error|unexpected\/timing/, name)
  }

  const informational = cliFixture({
    prefix: 'renovate-unexpected-info-',
    logText: successfulLog([{ level: 30, repository: 'unexpected/info', msg: 'Repository started' }]),
  })
  const informationalResult = spawnSync(process.execPath, informational.arguments_)
  assert.equal(informationalResult.status, 0)
  const informationalReceipt = JSON.parse(fs.readFileSync(informational.output, 'utf8'))
  assert.equal(informationalReceipt.result, 'passed')
  assert.equal(informationalReceipt.facts['Unexpected repository informational records'], '1')

  const warning = cliFixture({
    prefix: 'renovate-global-warning-',
    logText: successfulLog([{ level: 40, msg: 'bounded global warning' }]),
  })
  const warningResult = spawnSync(process.execPath, warning.arguments_)
  assert.equal(warningResult.status, 0)
  const warningReceipt = JSON.parse(fs.readFileSync(warning.output, 'utf8'))
  assert.equal(warningReceipt.result, 'passed')
  assert.equal(warningReceipt.facts['Global warnings'], '1')
  assert.doesNotMatch(JSON.stringify(warningReceipt), /bounded global warning/)
})

test('a repository error makes an action-success receipt and process fail after writing evidence', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-run-receipt-'))
  const logDirectory = path.join(directory, 'private-log')
  fs.mkdirSync(logDirectory, { mode: 0o700 })
  const logFile = path.join(logDirectory, 'renovate.jsonl')
  const output = path.join(directory, 'receipt.json')
  const summary = path.join(directory, 'summary.md')
  const phases = path.join(directory, 'phases.tsv')
  fs.writeFileSync(logFile, log)
  fs.writeFileSync(phases, 'Runner and checkout\t1\tpassed\t\nGitHub App token mint\t1\tpassed\t\nRenovate execution\t18\tpassed\t\n')
  const result = spawnSync(process.execPath, [
    tool,
    '--log', logFile,
    '--log-directory', logDirectory,
    '--log-directory-identity', directoryIdentity(logDirectory),
    '--repositories', expected.join(','),
    '--token-outcome', 'success',
    '--outcome', 'success',
    '--phase-file', phases,
    '--version', '1.2.3',
    '--log-level', 'info',
    '--started-epoch', '100',
    '--finished-epoch', '120',
    '--output', output,
    '--summary', summary,
  ])
  assert.equal(result.status, 1)
  assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).result, 'failed')
  assert.match(fs.readFileSync(summary, 'utf8'), /Renovate run · Failed/)
})

test('a failed token mint and skipped Renovate action produce owner-directed failure evidence', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-token-receipt-'))
  const logDirectory = path.join(directory, 'private-log')
  fs.mkdirSync(logDirectory, { mode: 0o700 })
  const logFile = path.join(logDirectory, 'renovate.jsonl')
  const phaseFile = path.join(directory, 'phases.tsv')
  const output = path.join(directory, 'receipt.json')
  const summary = path.join(directory, 'summary.md')
  fs.writeFileSync(logFile, '')
  fs.writeFileSync(
    phaseFile,
    'Runner and checkout\t2\tpassed\t\nNode setup\t1\tpassed\t\nRenovate runtime resolution\t1\tpassed\t\nGitHub App token mint\t3\tfailed\t\nRenovate execution\t0\tskipped\tGitHub App token mint did not pass\n'
  )
  const result = spawnSync(process.execPath, [
    tool,
    '--log', logFile,
    '--log-directory', logDirectory,
    '--log-directory-identity', directoryIdentity(logDirectory),
    '--repositories', expected.join(','),
    '--token-outcome', 'failure',
    '--outcome', 'skipped',
    '--phase-file', phaseFile,
    '--version', '1.2.3',
    '--log-level', 'info',
    '--started-epoch', '100',
    '--finished-epoch', '107',
    '--output', output,
    '--summary', summary,
  ])
  assert.equal(result.status, 1)
  const receipt = JSON.parse(fs.readFileSync(output, 'utf8'))
  assert.equal(receipt.result, 'failed')
  assert.equal(receipt.facts['GitHub App token'], 'failed')
  assert.equal(receipt.facts['Renovate action'], 'skipped')
  assert.equal(receipt.repositories.every((repository) => repository.result === 'unknown'), true)
  assert.match(receipt.repair, /Approve the GitHub App installation permission update/)
  assert.match(fs.readFileSync(summary, 'utf8'), /GitHub App token mint did not pass/)
})

test('missing successful-run timing writes a failed evidence receipt instead of losing the summary', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-missing-evidence-'))
  const logDirectory = path.join(directory, 'private-log')
  fs.mkdirSync(logDirectory, { mode: 0o700 })
  const logFile = path.join(logDirectory, 'renovate.jsonl')
  const phaseFile = path.join(directory, 'phases.tsv')
  const output = path.join(directory, 'receipt.json')
  const summary = path.join(directory, 'summary.md')
  fs.writeFileSync(logFile, JSON.stringify({
    level: 30,
    repository: expected[0],
    msg: 'Repository timing splits (milliseconds)',
    total: 1000,
  }))
  fs.writeFileSync(phaseFile, 'GitHub App token mint\t1\tpassed\t\nRenovate execution\t2\tpassed\t\n')
  const result = spawnSync(process.execPath, [
    tool,
    '--log', logFile,
    '--log-directory', logDirectory,
    '--log-directory-identity', directoryIdentity(logDirectory),
    '--repositories', expected.join(','),
    '--token-outcome', 'success',
    '--outcome', 'success',
    '--phase-file', phaseFile,
    '--version', '1.2.3',
    '--log-level', 'info',
    '--started-epoch', '100',
    '--finished-epoch', '103',
    '--output', output,
    '--summary', summary,
  ])
  assert.equal(result.status, 1)
  const receipt = JSON.parse(fs.readFileSync(output, 'utf8'))
  assert.equal(receipt.result, 'failed')
  assert.match(receipt.facts['Structured evidence'], new RegExp(`omitted repository timing for: ${expected[1]}`))
  assert.equal(receipt.repositories[0].result, 'passed')
  assert.equal(receipt.repositories[1].result, 'unknown')
  assert.match(fs.readFileSync(summary, 'utf8'), /Re-dispatch Renovate/)
})

test('a complete successful run publishes only bounded facts and deletes the raw log', () => {
  const secretMarker = 'raw-provider-token-should-never-escape'
  const fixture = cliFixture({
    logText: successfulLog([{
      level: 30,
      repository: expected[0],
      msg: `provider response ${secretMarker}`,
      payload: { authorization: secretMarker },
    }]),
  })
  fs.chmodSync(fixture.logFile, 0o444)
  const result = spawnSync(process.execPath, fixture.arguments_)

  assert.equal(result.status, 0)
  assert.equal(fs.existsSync(fixture.logFile), false)
  assert.equal(fs.existsSync(fixture.logDirectory), false)
  const serialized = fs.readFileSync(fixture.output, 'utf8')
  const receipt = JSON.parse(serialized)
  assert.equal(receipt.receiptKind, 'renovate-run')
  assert.equal(receipt.result, 'passed')
  assert.deepEqual(
    receipt.repositories.map(({ result: repositoryResult }) => repositoryResult),
    ['passed', 'passed', 'passed']
  )
  assert.equal(receipt.facts['Raw structured log'], 'deleted before receipt publication')
  assert.equal(receipt.facts['Private log directory'], 'removed before receipt publication')
  assert.equal(receipt.facts['Container log preflight'], 'passed')
  assert.doesNotMatch(serialized, new RegExp(secretMarker))
  assert.doesNotMatch(fs.readFileSync(fixture.summary, 'utf8'), new RegExp(secretMarker))
})

test('a successful action without the container preflight record fails closed', () => {
  const logWithoutPreflight = expected.map((repository, index) => ({
    level: 30,
    repository,
    msg: 'Repository timing splits (milliseconds)',
    total: (index + 1) * 1000,
  })).map((entry) => JSON.stringify(entry)).join('\n')
  const fixture = cliFixture({ logText: logWithoutPreflight })

  const result = spawnSync(process.execPath, fixture.arguments_)

  assert.equal(result.status, 1)
  assert.equal(fs.existsSync(fixture.logFile), false)
  const receipt = JSON.parse(fs.readFileSync(fixture.output, 'utf8'))
  assert.equal(receipt.result, 'failed')
  assert.equal(receipt.facts['Container log preflight'], 'not observed')
  assert.match(receipt.facts['Structured evidence'], /omitted the container log-mount preflight record/)
})

test('an action failure before repository completion publishes sanitized failure evidence', () => {
  const fixture = cliFixture({
    logText: '',
    phaseText: 'GitHub App token mint\t1\tpassed\t\nRenovate execution\t2\tfailed\t\n',
    actionOutcome: 'failure',
  })
  const result = spawnSync(process.execPath, fixture.arguments_)

  assert.equal(result.status, 1)
  assert.equal(fs.existsSync(fixture.logFile), false)
  const receipt = JSON.parse(fs.readFileSync(fixture.output, 'utf8'))
  assert.equal(receipt.result, 'failed')
  assert.equal(receipt.facts['Renovate action'], 'failed')
  assert.equal(receipt.repositories.every(({ result: repositoryResult }) => repositoryResult === 'unknown'), true)
  assert.match(receipt.repair, /Re-dispatch Renovate/)
})

test('malformed and duplicate completion logs become sanitized failed receipts', () => {
  const duplicate = [
    { level: 30, repository: expected[0], msg: 'Repository timing splits (milliseconds)', total: 1 },
    { level: 30, repository: expected[0], msg: 'Repository timing splits (milliseconds)', total: 2 },
  ].map((entry) => JSON.stringify(entry)).join('\n')
  const cases = [
    ['malformed', '{truncated-json'],
    ['duplicate', duplicate],
  ]

  for (const [name, logText] of cases) {
    const fixture = cliFixture({ prefix: `renovate-${name}-`, logText })
    const result = spawnSync(process.execPath, fixture.arguments_)
    assert.equal(result.status, 1, name)
    assert.equal(fs.existsSync(fixture.logFile), false, name)
    const receipt = JSON.parse(fs.readFileSync(fixture.output, 'utf8'))
    assert.equal(receipt.result, 'failed', name)
    assert.match(receipt.facts['Structured evidence'], name === 'malformed' ? /line 1/ : /duplicate/, name)
    assert.doesNotMatch(JSON.stringify(receipt), /truncated-json/, name)
  }
})

test('raw-log deletion failure is explicit, sanitized, and authoritative', () => {
  const fixture = cliFixture()
  const receipt = writeRenovateReceipt(
    { values: fixture.values, repositories: expected },
    { removeLog: () => { throw new Error('host path and token must not escape') } }
  )

  assert.equal(receipt.result, 'failed')
  assert.equal(receipt.facts['Raw structured log'], 'deletion failed; raw log was not uploaded')
  assert.equal(receipt.facts['Private log directory'], 'not removed because raw log deletion failed')
  assert.match(receipt.repair, /temporary-file deletion failure/)
  assert.equal(fs.existsSync(fixture.logFile), true)
  assert.doesNotMatch(fs.readFileSync(fixture.output, 'utf8'), /host path and token/)
})

test('private log containment rejects an external file without reading or deleting it', () => {
  const fixture = cliFixture()
  const externalDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-external-log-'))
  const externalLog = path.join(externalDirectory, 'renovate.jsonl')
  const secretMarker = 'external-log-must-not-be-read'
  fs.writeFileSync(externalLog, secretMarker)
  fixture.values['--log'] = externalLog

  const receipt = writeRenovateReceipt(
    { values: fixture.values, repositories: expected }
  )

  assert.equal(receipt.result, 'failed')
  assert.match(receipt.facts['Structured evidence'], /expected direct child/)
  assert.equal(receipt.facts['Raw structured log'], 'validation failed; raw log was not uploaded')
  assert.equal(fs.readFileSync(externalLog, 'utf8'), secretMarker)
  assert.doesNotMatch(fs.readFileSync(fixture.output, 'utf8'), new RegExp(secretMarker))
})

test('private log containment rejects symlinks without following or deleting them', () => {
  const fixture = cliFixture()
  const target = path.join(fixture.directory, 'external-target.jsonl')
  const secretMarker = 'symlink-target-must-not-be-read'
  fs.writeFileSync(target, secretMarker)
  fs.unlinkSync(fixture.logFile)
  fs.symlinkSync(target, fixture.logFile)

  const result = spawnSync(process.execPath, fixture.arguments_)

  assert.equal(result.status, 1)
  assert.equal(fs.lstatSync(fixture.logFile).isSymbolicLink(), true)
  assert.equal(fs.readFileSync(target, 'utf8'), secretMarker)
  const receipt = JSON.parse(fs.readFileSync(fixture.output, 'utf8'))
  assert.match(receipt.facts['Structured evidence'], /regular non-symlink file/)
  assert.doesNotMatch(JSON.stringify(receipt), new RegExp(secretMarker))
})

test('parent-directory symlink replacement preserves the external target through CLI cleanup', () => {
  const fixture = cliFixture()
  const externalDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-symlink-target-'))
  const externalLog = path.join(externalDirectory, 'renovate.jsonl')
  const secretMarker = 'parent-symlink-target-must-not-be-read-or-deleted'
  fs.writeFileSync(externalLog, secretMarker)
  fs.rmSync(fixture.logDirectory, { recursive: true })
  fs.symlinkSync(externalDirectory, fixture.logDirectory)

  const result = spawnSync(process.execPath, fixture.arguments_)

  assert.equal(result.status, 1)
  assert.equal(fs.lstatSync(fixture.logDirectory).isSymbolicLink(), true)
  assert.equal(fs.readFileSync(externalLog, 'utf8'), secretMarker)
  const receipt = JSON.parse(fs.readFileSync(fixture.output, 'utf8'))
  assert.match(receipt.facts['Structured evidence'], /not a real directory/)
  assert.doesNotMatch(JSON.stringify(receipt), new RegExp(secretMarker))
})

test('same-path directory replacement with matching owner and mode fails identity binding', () => {
  const fixture = cliFixture()
  const originalIdentity = fixture.values['--log-directory-identity']
  const replacementDirectory = path.join(fixture.directory, 'replacement-private-log')
  fs.mkdirSync(replacementDirectory, { mode: 0o700 })
  const replacementIdentity = directoryIdentity(replacementDirectory)
  assert.notEqual(replacementIdentity, originalIdentity)
  fs.writeFileSync(path.join(replacementDirectory, 'renovate.jsonl'), successfulLog())
  fs.rmSync(fixture.logDirectory, { recursive: true })
  fs.renameSync(replacementDirectory, fixture.logDirectory)
  assert.equal(directoryIdentity(fixture.logDirectory), replacementIdentity)

  const result = spawnSync(process.execPath, fixture.arguments_)

  assert.equal(result.status, 1)
  assert.equal(fs.existsSync(fixture.logFile), true)
  const receipt = JSON.parse(fs.readFileSync(fixture.output, 'utf8'))
  assert.match(receipt.facts['Structured evidence'], /identity changed after runner creation/)
})

test('special permission bits fail the exact private-directory mode contract', () => {
  const fixture = cliFixture()
  fs.chmodSync(fixture.logDirectory, 0o1700)

  const result = spawnSync(process.execPath, fixture.arguments_)

  assert.equal(result.status, 1)
  assert.equal(fs.existsSync(fixture.logFile), true)
  const receipt = JSON.parse(fs.readFileSync(fixture.output, 'utf8'))
  assert.match(receipt.facts['Structured evidence'], /does not have mode 0700/)
})

test('a skipped Renovate action records no raw log and removes the exact empty directory', () => {
  const fixture = cliFixture({
    createLog: false,
    tokenOutcome: 'failure',
    actionOutcome: 'skipped',
  })

  const result = spawnSync(process.execPath, fixture.arguments_)

  assert.equal(result.status, 1)
  assert.equal(fs.existsSync(fixture.logDirectory), false)
  const receipt = JSON.parse(fs.readFileSync(fixture.output, 'utf8'))
  assert.equal(receipt.facts['Raw structured log'], 'not produced because Renovate did not run')
  assert.equal(receipt.facts['Private log directory'], 'removed before receipt publication')
  assert.equal(receipt.facts['Structured evidence'], 'not produced because Renovate did not run')
  assert.doesNotMatch(receipt.repair, /containment failure/)
})

test('unexpected private-directory entries make cleanup fail closed after raw-log deletion', () => {
  const fixture = cliFixture()
  fs.writeFileSync(path.join(fixture.logDirectory, 'unexpected-entry'), 'bounded')

  const result = spawnSync(process.execPath, fixture.arguments_)

  assert.equal(result.status, 1)
  assert.equal(fs.existsSync(fixture.logFile), false)
  assert.equal(fs.existsSync(fixture.logDirectory), true)
  const receipt = JSON.parse(fs.readFileSync(fixture.output, 'utf8'))
  assert.equal(receipt.facts['Raw structured log'], 'deleted before receipt publication')
  assert.equal(receipt.facts['Private log directory'], 'removal failed; private directory was not uploaded')
  assert.match(receipt.repair, /unexpected entries/)
})

test('run receipt write fails closed and summary write fails open after receipt publication', () => {
  const outputFailure = cliFixture()
  fs.mkdirSync(outputFailure.output)
  const failed = spawnSync(process.execPath, outputFailure.arguments_)
  assert.equal(failed.status, 64)
  assert.equal(fs.existsSync(outputFailure.logFile), false)
  assert.equal(fs.existsSync(outputFailure.summary), false)

  const summaryFailure = cliFixture()
  fs.mkdirSync(summaryFailure.summary)
  const passed = spawnSync(process.execPath, summaryFailure.arguments_)
  assert.equal(passed.status, 0)
  assert.equal(fs.existsSync(summaryFailure.logFile), false)
  assert.equal(JSON.parse(fs.readFileSync(summaryFailure.output, 'utf8')).result, 'passed')
  assert.match(passed.stderr.toString(), /summary unavailable after authoritative receipt write/)
})
