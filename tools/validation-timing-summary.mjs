#!/usr/bin/env node
import fs from 'node:fs'
import process from 'node:process'
import { isMainModule } from './is-main.mjs'

const PHASE_RESULTS = new Set(['passed', 'failed', 'skipped'])

function milliseconds(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`)
  return value
}

export function parseValidationTiming(value) {
  if (!value || value.schema !== 'renovate-config.validation-timing' || value.schemaVersion !== 1) {
    throw new Error('unsupported validation timing schema')
  }
  if (!['passed', 'failed'].includes(value.result)) throw new Error('validation timing result is invalid')
  const totalMilliseconds = milliseconds(value.totalMilliseconds, 'totalMilliseconds')
  if (!Array.isArray(value.phases) || value.phases.length === 0 || value.phases.length > 20) {
    throw new Error('validation timing phases must contain 1 to 20 entries')
  }
  const names = new Set()
  const phases = value.phases.map((phase, index) => {
    if (
      !phase || typeof phase.name !== 'string' || !phase.name || phase.name.length > 120 ||
      /[\u0000-\u001f\u007f]/u.test(phase.name)
    ) {
      throw new Error(`validation timing phase ${index + 1} has an invalid name`)
    }
    if (names.has(phase.name)) throw new Error(`duplicate validation timing phase: ${phase.name}`)
    names.add(phase.name)
    if (!PHASE_RESULTS.has(phase.result)) throw new Error(`validation timing phase ${phase.name} has an invalid result`)
    return {
      name: phase.name,
      result: phase.result,
      durationMilliseconds: milliseconds(
        phase.durationMilliseconds,
        `duration for ${phase.name}`
      ),
    }
  })
  if (value.result === 'passed' && phases.some((phase) => phase.result !== 'passed')) {
    throw new Error('a passed validation timing receipt may contain only passed phases')
  }
  if (value.result === 'failed' && !phases.some((phase) => phase.result === 'failed')) {
    throw new Error('a failed validation timing receipt must contain a failed phase')
  }
  const maximumPhase = Math.max(...phases.map((phase) => phase.durationMilliseconds))
  if (totalMilliseconds < maximumPhase) {
    throw new Error('validation timing total must be at least the longest phase')
  }
  const sequentialTotal = phases.reduce((total, phase) => total + phase.durationMilliseconds, 0)
  const roundingTolerance = 100 + phases.length
  if (Math.abs(totalMilliseconds - sequentialTotal) > roundingTolerance) {
    throw new Error('validation timing total disagrees with sequential phase durations')
  }
  return { result: value.result, totalMilliseconds, phases }
}

function seconds(value) {
  return `${(value / 1000).toFixed(1)}s`
}

export function renderValidationTimingSummary(receipt) {
  const lines = [
    '',
    '### Validation phases',
    '',
    '| Phase | Duration | Result |',
    '| --- | ---: | --- |',
  ]
  for (const phase of [...receipt.phases].sort((left, right) => right.durationMilliseconds - left.durationMilliseconds)) {
    lines.push(`| ${phase.name.replaceAll('|', '\\|')} | ${seconds(phase.durationMilliseconds)} | ${phase.result} |`)
  }
  lines.push('', `Validation command total: **${seconds(receipt.totalMilliseconds)}**`, '')
  return lines.join('\n')
}

export function compactValidationTiming(receipt) {
  return [...receipt.phases]
    .sort((left, right) => right.durationMilliseconds - left.durationMilliseconds)
    .map((phase) => `${phase.name} ${seconds(phase.durationMilliseconds)} ${phase.result}`)
    .join('; ')
}

function parseArguments(arguments_) {
  const values = {}
  for (let index = 0; index < arguments_.length; index += 2) {
    const option = arguments_[index]
    const value = arguments_[index + 1]
    if (!['--input', '--summary', '--github-output'].includes(option) || !value) {
      throw new Error('usage: node tools/validation-timing-summary.mjs --input FILE --summary FILE --github-output FILE')
    }
    if (values[option]) throw new Error(`${option} may be provided only once`)
    values[option] = value
  }
  for (const option of ['--input', '--summary', '--github-output']) {
    if (!values[option]) throw new Error(`${option} is required`)
  }
  return values
}

if (isMainModule(import.meta.url)) {
  try {
    const values = parseArguments(process.argv.slice(2))
    const receipt = parseValidationTiming(JSON.parse(fs.readFileSync(values['--input'], 'utf8')))
    fs.appendFileSync(values['--summary'], renderValidationTimingSummary(receipt))
    fs.appendFileSync(values['--github-output'], `validation_timing=${compactValidationTiming(receipt)}\n`)
  } catch (error) {
    console.error(`validation-timing-summary: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 64
  }
}
