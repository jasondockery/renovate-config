#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { performance } from 'node:perf_hooks'
import { isMainModule } from './is-main.mjs'
import {
  buildRenovateConfigReceipt,
  renderRenovateConfigSummary,
  writeAdvisorySummary,
} from './renovate-config-receipt.mjs'

const ACTION_RESULTS = {
  success: 'passed',
  failure: 'failed',
  cancelled: 'cancelled',
  skipped: 'skipped',
}
const RECEIPT_RESULTS = new Set(Object.values(ACTION_RESULTS))
const DEFAULT_LOG_BYTE_LIMIT = 64 * 1024 * 1024
const DEFAULT_LOG_LINE_LIMIT = 500_000
const DEFAULT_LOG_LINE_BYTE_LIMIT = 1024 * 1024
const DEFAULT_LOG_PARSE_MILLISECONDS = 30_000
const LOG_READ_CHUNK_BYTES = 64 * 1024

const TOKEN_PERMISSION_REPAIR =
  'Approve the GitHub App installation permission update so the installation grants the canonical RENOVATE_APP_PERMISSIONS union, then rerun Renovate. Do not remove required workflow scopes to bypass HTTP 422.'

function logLevel(entry, index) {
  if (Number.isSafeInteger(entry.level) && entry.level >= 10 && entry.level <= 60) {
    return entry.level
  }
  const named = { trace: 10, debug: 20, info: 30, warn: 40, warning: 40, error: 50, fatal: 60 }
  const level = named[String(entry.level).toLowerCase()]
  if (level === undefined) {
    throw new Error(`structured Renovate log line ${index + 1} has an unknown level shape`)
  }
  return level
}

function parseLine(line, index) {
  try {
    const entry = JSON.parse(line)
    if (!entry || Array.isArray(entry) || typeof entry !== 'object') throw new Error()
    if (typeof entry.msg !== 'string' || entry.msg.length === 0) {
      throw new Error(`structured Renovate log line ${index + 1} has no message`)
    }
    if (entry.repository !== undefined && entry.repo !== undefined && entry.repository !== entry.repo) {
      throw new Error(`structured Renovate log line ${index + 1} has conflicting repository fields`)
    }
    const repository = entry.repository ?? entry.repo
    if (repository !== undefined && (
      typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)
    )) {
      throw new Error(`structured Renovate log line ${index + 1} has an invalid repository shape`)
    }
    return entry
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('structured Renovate log line')) throw error
    throw new Error(`structured Renovate log line ${index + 1} is not a JSON object`)
  }
}

function parseRenovateEntries(entries, expectedRepositories, {
  requireComplete = true,
  parseMilliseconds = DEFAULT_LOG_PARSE_MILLISECONDS,
} = {}) {
  if (!Number.isSafeInteger(parseMilliseconds) || parseMilliseconds <= 0) {
    throw new Error('structured Renovate log parse limit must be a positive safe integer')
  }
  if (!Array.isArray(expectedRepositories) || expectedRepositories.length === 0) {
    throw new Error('at least one expected repository is required')
  }
  if (new Set(expectedRepositories).size !== expectedRepositories.length) {
    throw new Error('expected repositories must be unique')
  }
  if (expectedRepositories.some((repository) => !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository))) {
    throw new Error('expected repositories must be owner/name slugs')
  }
  const repositories = new Map(
    expectedRepositories.map((repository) => [repository, {
      repository,
      durationSeconds: null,
      warnings: 0,
      errors: 0,
      result: 'unknown',
    }])
  )
  const timings = new Set()
  const parseStarted = performance.now()
  const evidence = {
    globalWarnings: 0,
    globalErrors: 0,
    unexpectedRepositoryRecords: 0,
    unexpectedRepositoryInformational: 0,
    unexpectedRepositoryWarnings: 0,
    unexpectedRepositoryErrors: 0,
    unexpectedRepositoryTimings: 0,
  }
  for (const { line, index } of entries) {
    if (performance.now() - parseStarted > parseMilliseconds) {
      throw new Error(`structured Renovate log parsing exceeded ${parseMilliseconds}ms`)
    }
    const entry = parseLine(line, index)
    const level = logLevel(entry, index)
    const repository = entry.repository ?? entry.repo
    const message = entry.msg
    if (repository === undefined) {
      if (level >= 50) evidence.globalErrors += 1
      else if (level >= 40) evidence.globalWarnings += 1
      continue
    }
    if (!repositories.has(repository)) {
      evidence.unexpectedRepositoryRecords += 1
      if (level >= 50) evidence.unexpectedRepositoryErrors += 1
      else if (level >= 40) evidence.unexpectedRepositoryWarnings += 1
      else evidence.unexpectedRepositoryInformational += 1
      if (message === 'Repository timing splits (milliseconds)') {
        if (!Number.isSafeInteger(entry.total) || entry.total < 0) {
          throw new Error(`repository timing for unexpected repository has no non-negative total`)
        }
        evidence.unexpectedRepositoryTimings += 1
      }
      continue
    }
    const receipt = repositories.get(repository)
    if (level >= 50) {
      receipt.errors += 1
      receipt.result = 'failed'
    } else if (level >= 40) receipt.warnings += 1
    if (/Repository has errors/i.test(message)) receipt.result = 'failed'
    if (message === 'Repository timing splits (milliseconds)') {
      if (timings.has(repository)) throw new Error(`duplicate repository timing for ${repository}`)
      if (!Number.isSafeInteger(entry.total) || entry.total < 0) {
        throw new Error(`repository timing for ${repository} has no non-negative total`)
      }
      if (entry.splits !== undefined && (
        !entry.splits || Array.isArray(entry.splits) || typeof entry.splits !== 'object' ||
        Object.values(entry.splits).some((value) => !Number.isSafeInteger(value) || value < 0)
      )) {
        throw new Error(`repository timing for ${repository} has an invalid splits shape`)
      }
      timings.add(repository)
      receipt.durationSeconds = Math.ceil(entry.total / 1000)
    }
  }
  if (performance.now() - parseStarted > parseMilliseconds) {
    throw new Error(`structured Renovate log parsing exceeded ${parseMilliseconds}ms`)
  }
  const missing = expectedRepositories.filter((repository) => !timings.has(repository))
  if (requireComplete && missing.length > 0) {
    throw new Error(`structured Renovate log omitted repository timing for: ${missing.join(', ')}`)
  }
  for (const receipt of repositories.values()) {
    if (receipt.result !== 'failed') {
      receipt.result = receipt.durationSeconds === null ? 'unknown' : 'passed'
    }
  }
  return { repositories: [...repositories.values()], evidence }
}

function boundedTextEntries(text, {
  byteLimit = DEFAULT_LOG_BYTE_LIMIT,
  lineLimit = DEFAULT_LOG_LINE_LIMIT,
  lineByteLimit = DEFAULT_LOG_LINE_BYTE_LIMIT,
} = {}) {
  if (typeof text !== 'string') throw new Error('structured Renovate log must be text')
  if (Buffer.byteLength(text) > byteLimit) {
    throw new Error(`structured Renovate log exceeds the ${byteLimit}-byte limit`)
  }
  const entries = []
  for (const [index, line] of text.split('\n').entries()) {
    if (!line) continue
    if (entries.length >= lineLimit) {
      throw new Error(`structured Renovate log exceeds the ${lineLimit}-line limit`)
    }
    if (Buffer.byteLength(line) > lineByteLimit) {
      throw new Error(`structured Renovate log line ${index + 1} exceeds the ${lineByteLimit}-byte limit`)
    }
    entries.push({ line, index })
  }
  return entries
}

function *boundedFileEntries(file, {
  byteLimit = DEFAULT_LOG_BYTE_LIMIT,
  lineLimit = DEFAULT_LOG_LINE_LIMIT,
  lineByteLimit = DEFAULT_LOG_LINE_BYTE_LIMIT,
  parseMilliseconds = DEFAULT_LOG_PARSE_MILLISECONDS,
} = {}) {
  const descriptor = fs.openSync(file, 'r')
  const chunk = Buffer.allocUnsafe(LOG_READ_CHUNK_BYTES)
  let pending = Buffer.alloc(0)
  let bytes = 0
  let lineCount = 0
  let physicalLine = 0
  const started = performance.now()
  try {
    while (true) {
      if (performance.now() - started > parseMilliseconds) {
        throw new Error(`structured Renovate log parsing exceeded ${parseMilliseconds}ms`)
      }
      const read = fs.readSync(descriptor, chunk, 0, chunk.length, null)
      if (read === 0) break
      bytes += read
      if (bytes > byteLimit) throw new Error(`structured Renovate log exceeds the ${byteLimit}-byte limit`)
      pending = Buffer.concat([pending, chunk.subarray(0, read)])
      let newline
      while ((newline = pending.indexOf(10)) !== -1) {
        let raw = pending.subarray(0, newline)
        pending = pending.subarray(newline + 1)
        physicalLine += 1
        if (raw.at(-1) === 13) raw = raw.subarray(0, -1)
        if (raw.length === 0) continue
        lineCount += 1
        if (lineCount > lineLimit) {
          throw new Error(`structured Renovate log exceeds the ${lineLimit}-line limit`)
        }
        if (raw.length > lineByteLimit) {
          throw new Error(`structured Renovate log line ${physicalLine} exceeds the ${lineByteLimit}-byte limit`)
        }
        const line = raw.toString('utf8')
        if (!Buffer.from(line, 'utf8').equals(raw)) {
          throw new Error(`structured Renovate log line ${physicalLine} is not valid UTF-8`)
        }
        yield { line, index: physicalLine - 1 }
      }
      if (pending.length > lineByteLimit) {
        throw new Error(`structured Renovate log line ${physicalLine + 1} exceeds the ${lineByteLimit}-byte limit`)
      }
    }
    if (pending.length > 0) {
      physicalLine += 1
      lineCount += 1
      if (lineCount > lineLimit) throw new Error(`structured Renovate log exceeds the ${lineLimit}-line limit`)
      const line = pending.toString('utf8')
      if (!Buffer.from(line, 'utf8').equals(pending)) {
        throw new Error(`structured Renovate log line ${physicalLine} is not valid UTF-8`)
      }
      yield { line, index: physicalLine - 1 }
    }
  } finally {
    fs.closeSync(descriptor)
  }
}

export function parseRenovateLog(text, expectedRepositories, options = {}) {
  return parseRenovateEntries(boundedTextEntries(text, options), expectedRepositories, options)
}

export function parseRenovateLogFile(file, expectedRepositories, options = {}) {
  return parseRenovateEntries(boundedFileEntries(file, options), expectedRepositories, options)
}

function markdown(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ')
}

export function renderRenovateSummary(receipt) {
  const lines = [renderRenovateConfigSummary(receipt).trimEnd()]
  lines.push('', '### Repository results', '', '| Repository | Seconds | Warnings | Errors | Result |', '| --- | ---: | ---: | ---: | --- |')
  for (const repository of receipt.repositories) {
    lines.push(
      `| ${markdown(repository.repository)} | ${repository.durationSeconds ?? 'unavailable'} | ${repository.warnings} | ${repository.errors} | ${repository.result} |`
    )
  }
  if (receipt.repair) lines.push('', '### Repair', '', receipt.repair)
  lines.push('')
  return lines.join('\n')
}

function writeAtomic(file, contents) {
  const temporary = `${file}.tmp-${process.pid}`
  try {
    fs.writeFileSync(temporary, contents, { flag: 'wx' })
    fs.renameSync(temporary, file)
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
  }
}

function usage() {
  return 'usage: node tools/renovate-run-receipt.mjs --log FILE --log-directory DIRECTORY --log-directory-identity DEVICE:INODE --repositories CSV --token-outcome OUTCOME --outcome OUTCOME --phase-file FILE --version VERSION --log-level LEVEL --started-epoch N --finished-epoch N --output FILE --summary FILE'
}

function validatePrivateLogDirectory(directory, expectedIdentity) {
  if (!/^\d+:\d+$/u.test(expectedIdentity)) {
    throw new Error('private Renovate log directory identity is invalid')
  }
  const resolvedDirectory = path.resolve(directory)
  let directoryStatus
  try {
    directoryStatus = fs.lstatSync(resolvedDirectory, { bigint: true })
  } catch {
    throw new Error('private Renovate log directory is missing or unreadable')
  }
  if (directoryStatus.isSymbolicLink() || !directoryStatus.isDirectory()) {
    throw new Error('private Renovate log directory is not a real directory')
  }
  if ((directoryStatus.mode & 0o7777n) !== 0o700n) {
    throw new Error('private Renovate log directory does not have mode 0700')
  }
  if (typeof process.getuid === 'function' && directoryStatus.uid !== BigInt(process.getuid())) {
    throw new Error('private Renovate log directory is not owned by the receipt runner')
  }
  if (`${directoryStatus.dev}:${directoryStatus.ino}` !== expectedIdentity) {
    throw new Error('private Renovate log directory identity changed after runner creation')
  }
  return resolvedDirectory
}

function inspectPrivateLogFile(file, directory, expectedIdentity) {
  const resolvedDirectory = validatePrivateLogDirectory(directory, expectedIdentity)
  const resolvedFile = path.resolve(file)
  if (resolvedFile !== path.join(resolvedDirectory, 'renovate.jsonl')) {
    throw new Error('structured Renovate log is not the expected direct child of the private log directory')
  }

  let fileStatus
  try {
    fileStatus = fs.lstatSync(resolvedFile)
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return { missing: true }
    }
    throw new Error('structured Renovate log is missing or unreadable')
  }
  if (fileStatus.isSymbolicLink() || !fileStatus.isFile()) {
    throw new Error('structured Renovate log is not a regular non-symlink file')
  }

  let realDirectory
  let realFile
  try {
    realDirectory = fs.realpathSync(resolvedDirectory)
    realFile = fs.realpathSync(resolvedFile)
  } catch {
    throw new Error('structured Renovate log containment could not be resolved')
  }
  if (realFile !== path.join(realDirectory, 'renovate.jsonl')) {
    throw new Error('structured Renovate log escapes the private log directory')
  }
  return { missing: false }
}

function readPhases(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line, index) => {
    const values = line.split('\t')
    if (values.length !== 4) {
      throw new Error(`phase line ${index + 1} must contain four tab-separated fields`)
    }
    const [name, durationSeconds, result, reason] = values
    if (!name || !RECEIPT_RESULTS.has(result)) {
      throw new Error(`phase line ${index + 1} has an invalid name or result`)
    }
    const phase = { name, durationSeconds, result }
    if (reason) phase.reason = reason
    return phase
  })
}

function parseArguments(argv) {
  const supported = new Set([
    '--log',
    '--log-directory',
    '--log-directory-identity',
    '--repositories',
    '--token-outcome',
    '--outcome',
    '--phase-file',
    '--version',
    '--log-level',
    '--started-epoch',
    '--finished-epoch',
    '--output',
    '--summary',
  ])
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help') return { help: true }
    if (!supported.has(argument)) throw new Error(`unknown argument: ${argument}`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${argument} requires a value`)
    if (values[argument] !== undefined) throw new Error(`${argument} may be provided only once`)
    values[argument] = value
    index += 1
  }
  for (const required of supported) {
    if (!values[required]) throw new Error(`${required} is required`)
  }
  if (!(values['--outcome'] in ACTION_RESULTS)) {
    throw new Error(`unsupported Renovate action outcome: ${values['--outcome']}`)
  }
  if (!(values['--token-outcome'] in ACTION_RESULTS)) {
    throw new Error(`unsupported GitHub App token outcome: ${values['--token-outcome']}`)
  }
  if (!/^\d+:\d+$/u.test(values['--log-directory-identity'])) {
    throw new Error('--log-directory-identity must be DEVICE:INODE')
  }
  const repositories = values['--repositories'].split(',').map((value) => value.trim()).filter(Boolean)
  return { values, repositories }
}

export function writeRenovateReceipt(options, {
  removeLog = (file) => fs.unlinkSync(file),
  removeLogDirectory = (directory) => fs.rmdirSync(directory),
  warn = (message) => console.error(message),
} = {}) {
  const { values, repositories: expected } = options
  const tokenResult = ACTION_RESULTS[values['--token-outcome']]
  const actionResult = ACTION_RESULTS[values['--outcome']]
  let evidenceError
  let privateLogStateValidated = false
  let rawLogMissing = false
  let repositories
  let evidence = {
    globalWarnings: 0,
    globalErrors: 0,
    unexpectedRepositoryRecords: 0,
    unexpectedRepositoryInformational: 0,
    unexpectedRepositoryWarnings: 0,
    unexpectedRepositoryErrors: 0,
    unexpectedRepositoryTimings: 0,
  }
  try {
    const logState = inspectPrivateLogFile(
      values['--log'],
      values['--log-directory'],
      values['--log-directory-identity']
    )
    privateLogStateValidated = true
    rawLogMissing = logState.missing
    if (rawLogMissing) {
      repositories = expected.map((repository) => ({
        repository,
        durationSeconds: null,
        warnings: 0,
        errors: 0,
        result: 'unknown',
      }))
      if (actionResult !== 'skipped') {
        evidenceError = 'structured Renovate log is missing after Renovate execution'
      }
    } else {
      const parsed = parseRenovateLogFile(
        values['--log'],
        expected,
        { requireComplete: false }
      )
      repositories = parsed.repositories
      evidence = parsed.evidence
      const evidenceProblems = []
      if (evidence.globalErrors > 0) {
        evidenceProblems.push(`structured Renovate log contains ${evidence.globalErrors} global ERROR/FATAL record(s)`)
      }
      if (
        evidence.unexpectedRepositoryWarnings > 0 ||
        evidence.unexpectedRepositoryErrors > 0 ||
        evidence.unexpectedRepositoryTimings > 0
      ) {
        evidenceProblems.push(
          'structured Renovate log contains warning, error, or timing evidence for unexpected repositories'
        )
      }
      if (tokenResult === 'passed' && actionResult === 'passed') {
        const missing = repositories
          .filter((repository) => repository.durationSeconds === null)
          .map((repository) => repository.repository)
        if (missing.length > 0) {
          evidenceProblems.push(`structured Renovate log omitted repository timing for: ${missing.join(', ')}`)
        }
      }
      if (evidenceProblems.length > 0) evidenceError = evidenceProblems.join('; ')
    }
  } catch (error) {
    evidenceError = error instanceof Error ? error.message : String(error)
    repositories = expected.map((repository) => ({
      repository,
      durationSeconds: null,
      warnings: 0,
      errors: 0,
      result: 'unknown',
    }))
  }
  const repositoriesFailed = repositories.some((repository) => repository.result === 'failed')
  let result = tokenResult === 'passed' && actionResult === 'passed' && !repositoriesFailed && !evidenceError
    ? 'passed'
    : 'failed'
  const phases = readPhases(values['--phase-file'])
  const repairs = []
  if (tokenResult === 'failed') repairs.push(TOKEN_PERMISSION_REPAIR)
  else if (tokenResult !== 'passed') {
    repairs.push('Repair the preceding setup or runtime phase so GitHub App token minting can run, then rerun Renovate.')
  } else if (actionResult !== 'passed' || evidenceError || repositoriesFailed) {
    repairs.push('Re-dispatch Renovate with log_level=debug and inspect the Run Renovate step before changing configuration or credentials.')
  }
  const receiptInput = (rawLogState, privateDirectoryState) => ({
    receiptKind: 'renovate-run',
    title: 'Renovate run',
    result,
    scope: `${expected.length} explicitly configured repositories`,
    platform: 'ubuntu-24.04',
    proofType: 'live self-hosted Renovate execution with sanitized structured-log facts',
    startedEpoch: values['--started-epoch'],
    finishedEpoch: values['--finished-epoch'],
    budgetSeconds: 2700,
    phases: [
      ...phases,
      ...repositories
        .filter((repository) => repository.durationSeconds !== null)
        .map((repository) => ({
          name: repository.repository,
          durationSeconds: repository.durationSeconds,
          result: repository.result === 'passed' ? 'passed' : 'failed',
        })),
    ],
    facts: {
      'GitHub App token': tokenResult,
      'Renovate action': actionResult,
      'Final result': result,
      'Renovate version': values['--version'],
      'Console log level': values['--log-level'],
      'Structured log level': 'debug',
      'Structured evidence': evidenceError ?? (
        rawLogMissing
          ? 'not produced because Renovate did not run'
          : 'complete for every configured repository'
      ),
      'Global warnings': String(evidence.globalWarnings),
      'Global errors': String(evidence.globalErrors),
      'Unexpected repository records': String(evidence.unexpectedRepositoryRecords),
      'Unexpected repository informational records': String(evidence.unexpectedRepositoryInformational),
      'Unexpected repository warnings': String(evidence.unexpectedRepositoryWarnings),
      'Unexpected repository errors': String(evidence.unexpectedRepositoryErrors),
      'Unexpected repository timings': String(evidence.unexpectedRepositoryTimings),
      'Raw structured log': rawLogState,
      'Private log directory': privateDirectoryState,
      'Cache state': 'unavailable',
    },
    reproduce: `workflow_dispatch Renovate with log_level=${values['--log-level']}`,
  })

  // Validate every receipt input before the first side effect. The raw log is
  // consumed only after parsing; no receipt may claim it was removed until the
  // unlink has actually succeeded.
  const absentLogState = actionResult === 'skipped'
    ? 'not produced because Renovate did not run'
    : 'missing after Renovate execution; raw log was not uploaded'
  buildRenovateConfigReceipt(receiptInput(rawLogMissing ? absentLogState : 'pending deletion', 'pending removal'))
  let rawLogState = rawLogMissing ? absentLogState : 'deleted before receipt publication'
  let privateDirectoryState = 'removed before receipt publication'
  if (!privateLogStateValidated) {
    result = 'failed'
    rawLogState = 'validation failed; raw log was not uploaded'
    privateDirectoryState = 'validation failed; private directory was not removed'
    repairs.unshift('Repair the private Renovate log containment failure, remove the runner temporary directory, then rerun Renovate.')
  } else {
    let rawLogRemoved = rawLogMissing
    if (!rawLogMissing) {
      let cleanupRevalidated = false
      try {
        const currentLogState = inspectPrivateLogFile(
          values['--log'],
          values['--log-directory'],
          values['--log-directory-identity']
        )
        if (currentLogState.missing) {
          throw new Error('structured Renovate log disappeared before deletion')
        }
        cleanupRevalidated = true
      } catch {
        result = 'failed'
        rawLogState = 'deletion revalidation failed; raw log was not uploaded'
        privateDirectoryState = 'not removed because raw log deletion failed'
        repairs.unshift('Repair the runner temporary-file deletion failure, remove the raw structured log and private directory, then rerun Renovate.')
      }
      if (cleanupRevalidated) {
        try {
          removeLog(values['--log'])
          rawLogRemoved = true
        } catch {
          result = 'failed'
          rawLogState = 'deletion failed; raw log was not uploaded'
          privateDirectoryState = 'not removed because raw log deletion failed'
          repairs.unshift('Repair the runner temporary-file deletion failure, remove the raw structured log and private directory, then rerun Renovate.')
        }
      }
    }
    if (rawLogRemoved) {
      try {
        validatePrivateLogDirectory(
          values['--log-directory'],
          values['--log-directory-identity']
        )
        removeLogDirectory(values['--log-directory'])
      } catch {
        result = 'failed'
        privateDirectoryState = 'removal failed; private directory was not uploaded'
        repairs.unshift('Repair the private Renovate log directory cleanup failure, remove unexpected entries, then rerun Renovate.')
      }
    }
  }

  const receipt = buildRenovateConfigReceipt(receiptInput(rawLogState, privateDirectoryState))
  receipt.repositories = repositories
  if (repairs.length > 0) receipt.repair = repairs.join(' ')
  writeAtomic(values['--output'], `${JSON.stringify(receipt, null, 2)}\n`)
  writeAdvisorySummary(values['--summary'], renderRenovateSummary(receipt), { warn })
  return receipt
}

if (isMainModule(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2))
    if (options.help) console.log(usage())
    else {
      const receipt = writeRenovateReceipt(options)
      if (receipt.result !== 'passed') process.exitCode = 1
    }
  } catch (error) {
    console.error(`renovate-run-receipt: ${error instanceof Error ? error.message : String(error)}`)
    console.error(usage())
    process.exitCode = 64
  }
}
