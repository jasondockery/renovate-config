#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { writeAtomicFile } from './atomic-write.mjs'
import { runCommandLane } from './bounded-command.mjs'
import { isMainModule } from './is-main.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const VALIDATION_PHASE_DEADLINE_MILLISECONDS = 30_000
const VALIDATION_CANCEL_GRACE_MILLISECONDS = 1_000

export const VALIDATION_PHASES = Object.freeze([
  { name: 'Toolchain contract', script: 'tools/check-toolchain.mjs' },
  { name: 'Compass projection', script: 'tools/check-compass-projection.mjs' },
  { name: 'Preset freeze', script: 'tools/check-preset-freeze.mjs' },
  { name: 'Release controls desired state', script: 'tools/release-controls.mjs', arguments: ['validate'] },
  { name: 'Dependency coverage schema', script: 'tools/check-dependency-coverage-schema.mjs' },
  { name: 'Renovate system policy', script: 'tools/check-renovate-system-policy.mjs' },
  { name: 'Workflow action pins', script: 'tools/check-workflow-action-pins.mjs' },
  { name: 'Workflow timeout policy', script: 'tools/check-workflow-timeouts.mjs' },
  { name: 'GitHub external configuration', script: 'tools/github-external-config.mjs' },
  { name: 'Renovate runtime contract', script: 'tools/check-renovate-runtime.mjs' },
])

function formatDuration(milliseconds) {
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`
  return `${(milliseconds / 1000).toFixed(1)}s`
}

function renderTiming(records, totalMilliseconds) {
  const width = Math.max(...records.map(({ name }) => name.length))
  const lines = ['', 'Validation timing']
  for (const record of records) {
    const duration = record.result === 'skipped' ? '-' : formatDuration(record.durationMilliseconds)
    lines.push(`  ${record.name.padEnd(width)}  ${record.result.padEnd(7)}  ${duration}`)
  }
  lines.push(`  ${'Total'.padEnd(width)}  ${formatDuration(totalMilliseconds)}`, '')
  return lines.join('\n')
}

function signalExitCode(signal) {
  const known = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 }
  return known[signal] ?? 1
}

function classifyPhaseResult(completed) {
  if (completed.timedOut === true) return { exitCode: 124, reason: 'timeout' }
  if (completed.closureConfirmed === false) return { exitCode: 125, reason: 'closure' }
  if (Number.isInteger(completed.exitCode) && completed.exitCode !== 0) {
    return { exitCode: completed.exitCode, reason: completed.signal ? 'signal' : 'exit' }
  }
  if (completed.signal) return { exitCode: signalExitCode(completed.signal), reason: 'signal' }
  if (completed.error) return { exitCode: 1, reason: 'error' }
  if (completed.exitCode === 0) return { exitCode: 0, reason: 'success' }
  return { exitCode: 1, reason: 'error' }
}

export async function runValidation({
  phases = VALIDATION_PHASES,
  runPhase = runCommandLane,
  now = () => performance.now(),
  write = (value) => process.stdout.write(value),
  writeError = (value) => process.stderr.write(value),
  phaseDeadlineMilliseconds = VALIDATION_PHASE_DEADLINE_MILLISECONDS,
  cancelGraceMilliseconds = VALIDATION_CANCEL_GRACE_MILLISECONDS,
} = {}) {
  if (!Number.isSafeInteger(phaseDeadlineMilliseconds) || phaseDeadlineMilliseconds <= 0) {
    throw new Error('validation phase deadline must be a positive safe integer')
  }
  const records = []
  const suiteStarted = now()
  let exitCode = 0

  for (const phase of phases) {
    if (exitCode !== 0) {
      records.push({
        ...phase,
        deadlineMilliseconds: null,
        exitCode: null,
        signal: null,
        timedOut: null,
        closureConfirmed: null,
        error: null,
        result: 'skipped',
        durationMilliseconds: 0,
      })
      continue
    }
    const deadlineMilliseconds = phase.timeoutMilliseconds ?? phaseDeadlineMilliseconds
    if (!Number.isSafeInteger(deadlineMilliseconds) || deadlineMilliseconds <= 0) {
      throw new Error(`validation phase deadline must be a positive safe integer: ${phase.name}`)
    }
    write(`\n==> ${phase.name}\n`)
    const started = now()
    const controller = new AbortController()
    const deadline = setTimeout(
      () => controller.abort({ type: 'timeout' }),
      deadlineMilliseconds
    )
    let completed
    try {
      completed = await runPhase({
        name: phase.name,
        command: process.execPath,
        arguments_: [phase.script, ...(phase.arguments ?? [])],
        cwd: repositoryRoot,
        now,
        write,
        writeError,
        signal: controller.signal,
        cancelGraceMilliseconds,
      })
    } finally {
      clearTimeout(deadline)
    }
    const durationMilliseconds = Math.ceil(Math.max(0, now() - started))
    const classified = classifyPhaseResult(completed)
    exitCode = classified.exitCode
    if (classified.reason === 'timeout') {
      writeError(
        `validate: ${phase.name} timed out after ${deadlineMilliseconds}ms; ` +
        `process-tree closure ${completed.closureConfirmed === false ? 'unconfirmed' : 'confirmed'}. ` +
        `Recovery: run node ${phase.script}${phase.arguments?.length ? ` ${phase.arguments.join(' ')}` : ''}, correct the stall, then rerun pnpm validate.\n`
      )
    } else if (classified.reason === 'closure') {
      writeError(
        `validate: ${phase.name} failed because process-tree closure could not be confirmed. ` +
        `Recovery: inspect surviving descendants, correct the phase or supervisor failure, then rerun pnpm validate.\n`
      )
    } else if (classified.reason !== 'success') {
      if (completed.error) writeError(`validate: ${phase.name} failed: ${completed.error}\n`)
      else if (classified.reason === 'error') writeError(`validate: ${phase.name} failed without an authoritative process result.\n`)
      if (completed.signal) writeError(`validate: ${phase.name} ended from signal ${completed.signal}.\n`)
    }
    records.push({
      ...phase,
      deadlineMilliseconds,
      result: classified.reason === 'success' ? 'passed' : 'failed',
      durationMilliseconds,
      exitCode,
      signal: completed.signal ?? null,
      timedOut: completed.timedOut === true,
      closureConfirmed: completed.closureConfirmed !== false,
      error: completed.error ?? null,
    })
  }

  const totalMilliseconds = Math.ceil(Math.max(0, now() - suiteStarted))
  write(renderTiming(records, totalMilliseconds))
  return { exitCode, records, totalMilliseconds }
}

export function validationTimingReceipt(result) {
  return {
    schema: 'renovate-config.validation-timing',
    schemaVersion: 1,
    result: result.exitCode === 0 ? 'passed' : 'failed',
    totalMilliseconds: result.totalMilliseconds,
    phases: result.records.map(({
      name,
      script,
      deadlineMilliseconds,
      exitCode,
      signal,
      timedOut,
      closureConfirmed,
      error,
      result: phaseResult,
      durationMilliseconds,
    }) => ({
      name,
      script,
      deadlineMilliseconds,
      exitCode,
      signal,
      timedOut,
      closureConfirmed,
      error,
      result: phaseResult,
      durationMilliseconds,
    })),
  }
}

function writeTimingReceipt(file, result) {
  const output = path.resolve(file)
  const parent = path.dirname(output)
  if (!fs.statSync(parent).isDirectory()) throw new Error(`timing output parent is not a directory: ${parent}`)
  const receipt = validationTimingReceipt(result)
  writeAtomicFile(output, `${JSON.stringify(receipt)}\n`)
}

function usage() {
  return 'usage: node tools/validate.mjs'
}

if (isMainModule(import.meta.url)) {
  const arguments_ = process.argv.slice(2)
  if (arguments_.length === 1 && arguments_[0] === '--help') {
    console.log(usage())
  } else if (arguments_.length > 0) {
    console.error(`validate: unexpected argument: ${arguments_[0]}`)
    console.error(usage())
    process.exitCode = 64
  } else {
    const timingOutput = process.env.RENOVATE_VALIDATION_TIMING_OUTPUT
    if (timingOutput && !path.isAbsolute(timingOutput)) {
      console.error('validate: RENOVATE_VALIDATION_TIMING_OUTPUT must be an absolute path')
      process.exitCode = 64
    } else {
      const result = await runValidation()
      try {
        if (timingOutput) writeTimingReceipt(timingOutput, result)
        process.exitCode = result.exitCode
      } catch (error) {
        console.error(`validate: could not write timing receipt: ${error instanceof Error ? error.message : String(error)}`)
        process.exitCode = 1
      }
    }
  }
}
