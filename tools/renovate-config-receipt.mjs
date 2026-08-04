#!/usr/bin/env node
import fs from 'node:fs'
import process from 'node:process'
import { writeAtomicFile } from './atomic-write.mjs'
import { isMainModule } from './is-main.mjs'

// Internal evidence format for this repository's three workflows. This is not
// the future cross-repository receipt library; the compatibility object is the
// deliberately small mapping that can later be field-proved against
// Groundwork and Roost without making renovate-config a tooling package.

const RESULTS = new Set(['passed', 'failed', 'cancelled', 'skipped'])
const RECEIPT_KINDS = new Set(['ci-gate', 'renovate-run', 'security-hygiene', 'local'])
const CACHE_STATES = new Set(['warm', 'cold', 'not-applicable', 'unavailable', 'mixed'])
const COMMAND_LABELS = new Set(['Reproduce', 'Local tests/validation equivalent'])

function text(value, label, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new Error(`${label} must be ${allowEmpty ? 'text' : 'non-empty text'}`)
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} contains a control character`)
  }
  return value
}

function integer(value, label, { minimum = 0 } = {}) {
  if (!/^[0-9]+$/.test(String(value ?? ''))) {
    throw new Error(`${label} must be a non-negative integer`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${label} must be a safe integer of at least ${minimum}`)
  }
  return parsed
}

function readRows(file, columns, label) {
  const accepted = Array.isArray(columns) ? columns : [columns]
  if (!file) return []
  const rows = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line, index) => {
      const values = line.split('\t')
      if (!accepted.includes(values.length)) {
        throw new Error(`${label} line ${index + 1} must contain ${accepted.join(' or ')} tab-separated fields`)
      }
      return values
    })
  const seen = new Set()
  for (const [index, values] of rows.entries()) {
    values.forEach((value, column) => {
      text(value, `${label} line ${index + 1} field ${column + 1}`, {
        allowEmpty: label === 'phase file' && column === 3,
      })
    })
    if (seen.has(values[0])) throw new Error(`${label} contains duplicate name: ${values[0]}`)
    seen.add(values[0])
  }
  return rows
}

export function buildRenovateConfigReceipt({
  receiptKind = 'local',
  title,
  result,
  scope,
  platform,
  proofType,
  startedEpoch,
  finishedEpoch,
  budgetSeconds,
  phases = [],
  facts = {},
  reproduce,
  reproduceLabel = 'Reproduce',
  repository = process.env.GITHUB_REPOSITORY || 'local',
  workflow = process.env.GITHUB_WORKFLOW || 'local',
  job = process.env.GITHUB_JOB || 'local',
  runId = process.env.GITHUB_RUN_ID || null,
  runAttempt = process.env.GITHUB_RUN_ATTEMPT || null,
  event = process.env.GITHUB_EVENT_NAME || null,
  ref = process.env.GITHUB_REF || null,
  testedSha = process.env.GITHUB_SHA || 'local',
  // GitHub exposes no GITHUB_HEAD_SHA; the PR head comes from the workflow
  // context, so callers pass --head-sha explicitly rather than relying on env.
  headSha = null,
  implementationSha = null,
  callerRepository = null,
  callerSha = null,
}) {
  if (!RECEIPT_KINDS.has(receiptKind)) throw new Error(`unsupported receipt kind: ${receiptKind}`)
  title = text(title, 'title')
  scope = text(scope, 'scope')
  platform = text(platform, 'platform')
  proofType = text(proofType, 'proof type')
  reproduce = text(reproduce, 'reproduce command')
  if (!COMMAND_LABELS.has(reproduceLabel)) {
    throw new Error(`unsupported command label: ${reproduceLabel}`)
  }
  repository = text(repository, 'repository')
  workflow = text(workflow, 'workflow')
  job = text(job, 'job')
  testedSha = text(testedSha, 'tested SHA')
  for (const [label, value] of [
    ['tested SHA', testedSha],
    ['head SHA', headSha],
    ['implementation SHA', implementationSha],
    ['caller SHA', callerSha],
  ]) {
    if (value !== null && value !== 'local' && !/^[0-9a-f]{40}$/iu.test(value)) {
      throw new Error(`${label} must be local or a complete 40-hex commit`)
    }
  }
  if (headSha !== null) text(headSha, 'head SHA')
  if (implementationSha !== null) text(implementationSha, 'implementation SHA')
  if ((callerRepository === null) !== (callerSha === null)) {
    throw new Error('caller repository and caller SHA must be provided together')
  }
  if (callerRepository !== null) text(callerRepository, 'caller repository')
  const checkedRunId = runId === null ? null : integer(runId, 'run ID', { minimum: 1 })
  const checkedRunAttempt = runAttempt === null ? null : integer(runAttempt, 'run attempt', { minimum: 1 })
  if (event !== null) text(event, 'event')
  if (ref !== null) text(ref, 'ref')
  if (!RESULTS.has(result)) throw new Error(`unsupported result: ${result}`)
  const started = integer(startedEpoch, 'started epoch', { minimum: 1 })
  const finished = integer(finishedEpoch, 'finished epoch')
  if (finished < started) throw new Error('finished epoch must not precede started epoch')
  const budget = integer(budgetSeconds, 'budget seconds', { minimum: 1 })
  const phaseNames = new Set()
  const checkedPhases = phases.map((phase) => {
    if (!phase || !RESULTS.has(phase.result)) throw new Error('each phase needs a name and valid result')
    const name = text(phase.name, 'phase name')
    if (phaseNames.has(name)) throw new Error(`duplicate phase: ${name}`)
    phaseNames.add(name)
    const checked = {
      name,
      durationSeconds: integer(phase.durationSeconds, `duration for ${name}`),
      result: phase.result,
    }
    if (phase.result === 'skipped' && !phase.reason) {
      throw new Error(`skipped phase ${name} needs a reason`)
    }
    if (phase.reason !== undefined) {
      checked.reason = text(phase.reason, `reason for ${name}`)
    }
    return checked
  })
  if (result === 'passed' && checkedPhases.some((phase) => phase.result !== 'passed')) {
    throw new Error('a passed receipt may contain only passed phases')
  }
  const checkedFacts = {}
  for (const [name, value] of Object.entries(facts)) {
    checkedFacts[text(name, 'fact name')] = text(value, `fact ${name}`)
  }
  const durationSeconds = finished - started
  const cacheState = checkedFacts['Cache state'] ?? 'unavailable'
  if (!CACHE_STATES.has(cacheState)) {
    throw new Error('Cache state must use the cross-repository compatibility vocabulary')
  }
  const slowestPhases = [...checkedPhases]
    .sort((left, right) => right.durationSeconds - left.durationSeconds)
    .slice(0, 5)
    .map(({ name, durationSeconds: phaseDuration, result: phaseResult }) => ({
      name,
      durationSeconds: phaseDuration,
      result: phaseResult,
    }))
  return {
    schema: 'renovate-config.run-receipt',
    schemaVersion: 1,
    receiptKind,
    repository,
    workflow,
    job,
    runId: checkedRunId,
    runAttempt: checkedRunAttempt,
    event,
    ref,
    testedSha,
    headSha,
    implementationSha,
    caller: callerRepository === null ? null : { repository: callerRepository, sha: callerSha },
    title,
    result,
    scope,
    platform,
    proofType,
    startedAt: new Date(started * 1000).toISOString(),
    finishedAt: new Date(finished * 1000).toISOString(),
    durationSeconds,
    budgetSeconds: budget,
    budgetState: durationSeconds <= budget ? 'within' : 'exceeded',
    phases: checkedPhases,
    facts: checkedFacts,
    reproduce,
    reproduceLabel,
    compatibility: {
      outcome: result,
      identity: testedSha === 'local' ? 'unbound local tree' : `exact SHA ${testedSha}`,
      command: reproduce,
      commandKind: reproduceLabel === 'Reproduce' ? 'reproduce' : 'local-equivalent',
      proofType,
      durationSeconds,
      slowestPhases,
      cacheState,
      invalidationState: testedSha === 'local' ? 'not reusable' : 'valid for exact run and tested SHA only',
    },
  }
}

function markdown(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ')
}

export function renderRenovateConfigSummary(receipt) {
  const resultLabel = receipt.result[0].toUpperCase() + receipt.result.slice(1)
  const lines = [
    `## ${markdown(receipt.title)} · ${resultLabel}`,
    '',
    `- Duration: **${receipt.durationSeconds}s** (advisory budget ${receipt.budgetSeconds}s · ${receipt.budgetState})`,
    `- Scope: ${markdown(receipt.scope)}`,
    `- Proof: ${markdown(receipt.proofType)}`,
    `- Tested commit: \`${markdown(receipt.testedSha)}\` · Platform: ${markdown(receipt.platform)}`,
    `- Run: \`${markdown(receipt.runId ?? 'local')}\` · Attempt: \`${markdown(receipt.runAttempt ?? 'local')}\` · Event: \`${markdown(receipt.event ?? 'local')}\``,
    `- Reuse: ${markdown(receipt.compatibility.invalidationState)} · Cache: ${markdown(receipt.compatibility.cacheState)}`,
  ]
  const slowest = [...receipt.phases]
    .sort((left, right) => right.durationSeconds - left.durationSeconds)
    .slice(0, 5)
  if (slowest.length > 0) {
    lines.push('', '### Slowest phases', '', '| Phase | Seconds | Result | Reason |', '| --- | ---: | --- | --- |')
    for (const phase of slowest) {
      lines.push(`| ${markdown(phase.name)} | ${phase.durationSeconds} | ${phase.result} | ${markdown(phase.reason ?? '')} |`)
    }
  }
  const facts = Object.entries(receipt.facts)
  if (facts.length > 0) {
    lines.push('', '### Key proof', '')
    for (const [name, value] of facts) lines.push(`- ${markdown(name)}: ${markdown(value)}`)
  }
  lines.push('', `${markdown(receipt.reproduceLabel ?? 'Reproduce')}: \`${markdown(receipt.reproduce)}\``, '')
  return lines.join('\n')
}

export function writeAdvisorySummary(file, contents, {
  warn = (message) => console.error(message),
} = {}) {
  try {
    writeAtomicFile(file, contents)
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    warn(`receipt summary unavailable after authoritative receipt write: ${message}`)
    return false
  }
}

export function writeRenovateConfigReceipt({ output, summary, warn, ...input }) {
  if (!output) throw new Error('output path is required')
  const receipt = buildRenovateConfigReceipt(input)
  const rendered = summary ? renderRenovateConfigSummary(receipt) : undefined
  writeAtomicFile(output, `${JSON.stringify(receipt, null, 2)}\n`)
  if (summary) writeAdvisorySummary(summary, rendered, { warn })
  return receipt
}

function usage() {
  return 'usage: node tools/renovate-config-receipt.mjs --output FILE [--summary FILE] --receipt-kind KIND --title TEXT --result RESULT --scope TEXT --platform TEXT --proof-type TEXT --started-epoch N --finished-epoch N --budget-seconds N [--phase-file TSV] [--fact-file TSV] [--repository OWNER/NAME] [--workflow NAME] [--job NAME] [--tested-sha 40-HEX] [--head-sha 40-HEX] [--implementation-sha 40-HEX] [--caller-repository OWNER/NAME --caller-sha 40-HEX] --reproduce COMMAND [--reproduce-label LABEL]'
}

function parseArguments(argv) {
  const values = {}
  const supported = new Set([
    '--output',
    '--summary',
    '--receipt-kind',
    '--title',
    '--result',
    '--scope',
    '--platform',
    '--proof-type',
    '--started-epoch',
    '--finished-epoch',
    '--budget-seconds',
    '--phase-file',
    '--fact-file',
    '--repository',
    '--workflow',
    '--job',
    '--tested-sha',
    '--head-sha',
    '--implementation-sha',
    '--caller-repository',
    '--caller-sha',
    '--reproduce',
    '--reproduce-label',
  ])
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
  const phaseRows = readRows(values['--phase-file'], [3, 4], 'phase file')
  const factRows = readRows(values['--fact-file'], 2, 'fact file')
  return {
    output: values['--output'],
    summary: values['--summary'],
    receiptKind: values['--receipt-kind'],
    title: values['--title'],
    result: values['--result'],
    scope: values['--scope'],
    platform: values['--platform'],
    proofType: values['--proof-type'],
    startedEpoch: values['--started-epoch'],
    finishedEpoch: values['--finished-epoch'],
    budgetSeconds: values['--budget-seconds'],
    phases: phaseRows.map(([name, durationSeconds, result, reason]) => ({
      name,
      durationSeconds,
      result,
      ...(reason ? { reason } : {}),
    })),
    facts: Object.fromEntries(factRows),
    repository: values['--repository'],
    workflow: values['--workflow'],
    job: values['--job'],
    testedSha: values['--tested-sha'],
    headSha: values['--head-sha'],
    implementationSha: values['--implementation-sha'],
    callerRepository: values['--caller-repository'],
    callerSha: values['--caller-sha'],
    reproduce: values['--reproduce'],
    reproduceLabel: values['--reproduce-label'],
  }
}

if (isMainModule(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2))
    if (options.help) {
      console.log(usage())
    } else {
      writeRenovateConfigReceipt(options)
    }
  } catch (error) {
    console.error(`renovate-config-receipt: ${error instanceof Error ? error.message : String(error)}`)
    console.error(usage())
    process.exitCode = 64
  }
}
