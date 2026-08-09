#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { writeAtomicFile } from './atomic-write.mjs'
import { isMainModule } from './is-main.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const VALIDATION_PHASES = Object.freeze([
  { name: 'Toolchain contract', script: 'tools/check-toolchain.mjs' },
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

export function runValidation({
  phases = VALIDATION_PHASES,
  run = spawnSync,
  now = () => performance.now(),
  write = (value) => process.stdout.write(value),
  writeError = (value) => process.stderr.write(value),
} = {}) {
  const records = []
  const suiteStarted = now()
  let exitCode = 0

  for (const phase of phases) {
    if (exitCode !== 0) {
      records.push({ ...phase, result: 'skipped', durationMilliseconds: 0 })
      continue
    }
    write(`\n==> ${phase.name}\n`)
    const started = now()
    const completed = run(process.execPath, [phase.script, ...(phase.arguments ?? [])], {
      cwd: repositoryRoot,
      env: process.env,
      stdio: 'inherit',
    })
    const durationMilliseconds = Math.ceil(Math.max(0, now() - started))
    if (completed.error) {
      writeError(`validate: ${phase.name} could not start: ${completed.error.message}\n`)
      exitCode = 1
    } else if (completed.status !== 0) {
      exitCode = Number.isInteger(completed.status) ? completed.status : 1
    }
    records.push({
      ...phase,
      result: exitCode === 0 ? 'passed' : 'failed',
      durationMilliseconds,
    })
  }

  const totalMilliseconds = Math.ceil(Math.max(0, now() - suiteStarted))
  write(renderTiming(records, totalMilliseconds))
  return { exitCode, records, totalMilliseconds }
}

function writeTimingReceipt(file, result) {
  const output = path.resolve(file)
  const parent = path.dirname(output)
  if (!fs.statSync(parent).isDirectory()) throw new Error(`timing output parent is not a directory: ${parent}`)
  const receipt = {
    schema: 'renovate-config.validation-timing',
    schemaVersion: 1,
    result: result.exitCode === 0 ? 'passed' : 'failed',
    totalMilliseconds: result.totalMilliseconds,
    phases: result.records.map(({ name, script, result: phaseResult, durationMilliseconds }) => ({
      name,
      script,
      result: phaseResult,
      durationMilliseconds,
    })),
  }
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
      const result = runValidation()
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
