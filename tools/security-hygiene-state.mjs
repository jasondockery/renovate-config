#!/usr/bin/env node
// Fail-closed bridge from the report's state receipt to GitHub step outputs.
// Keeping schema validation here makes missing/malformed state process-testable
// instead of burying authoritative parsing in workflow shell.
import fs from 'node:fs'
import process from 'node:process'
import { isMainModule } from './is-main.mjs'
import { REPORT_EXIT_CODES } from './security-policy.mjs'

export function parseHygieneState(text) {
  let state
  try {
    state = JSON.parse(text)
  } catch {
    throw new Error('state file must contain valid JSON')
  }
  if (!state || Array.isArray(state) || typeof state !== 'object') {
    throw new Error('state must be a JSON object')
  }
  if (typeof state.monitorBroken !== 'boolean') {
    throw new Error('monitorBroken must be a Boolean')
  }
  if (!Number.isSafeInteger(state.overdueCount) || state.overdueCount < 0) {
    throw new Error('overdueCount must be a non-negative safe integer')
  }
  return {
    monitorBroken: state.monitorBroken,
    overdueCount: state.overdueCount,
  }
}

export function formatGitHubOutputs(state) {
  return [
    `monitor_broken=${state.monitorBroken}`,
    `overdue_count=${state.overdueCount}`,
  ].join('\n')
}

if (isMainModule(import.meta.url)) {
  const statePath = process.argv[2]
  if (!statePath || process.argv.length !== 3) {
    console.error('usage: node tools/security-hygiene-state.mjs <state-file>')
    process.exitCode = REPORT_EXIT_CODES.usage
  } else {
    try {
      const state = parseHygieneState(fs.readFileSync(statePath, 'utf8'))
      process.stdout.write(`${formatGitHubOutputs(state)}\n`)
    } catch (error) {
      console.error(
        `security-hygiene-state: ${error instanceof Error ? error.message : String(error)}`
      )
      process.exitCode = REPORT_EXIT_CODES.runtimeFailure
    }
  }
}
