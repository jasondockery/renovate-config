#!/usr/bin/env node
import process from 'node:process'
import { spawnSync } from 'node:child_process'

const phases = [
  ['Synthetic dependency extraction', 'tools/check-renovate-extraction.mjs'],
  ['Renovate configuration validation', 'tools/validate-renovate.mjs'],
]

let result = 0
for (const [name, script] of phases) {
  console.log(`\n==> ${name}`)
  const completed = spawnSync(process.execPath, [script], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
    timeout: 180_000,
  })
  if (completed.error) {
    console.error(`renovate integration: ${name} could not start: ${completed.error.message}`)
    result = 1
    break
  }
  if (completed.status !== 0) {
    result = Number.isInteger(completed.status) ? completed.status : 1
    break
  }
}

process.exitCode = result
