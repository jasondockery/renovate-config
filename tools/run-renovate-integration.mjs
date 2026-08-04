#!/usr/bin/env node
import process from 'node:process'
import { spawnSync } from 'node:child_process'

// Every phase runs inside the one Renovate runtime that
// validate-renovate-integration.mjs already acquired, so adding a phase costs
// a process, never another network acquisition.
//
// The effective-policy phase is required, not optional: byte equality between
// default.json and the reviewed fixture proves the source is unchanged, but it
// cannot prove the pinned runtime still RESOLVES that source to a five-day
// floor. config:best-practices contributing a later three-day npm rule is the
// field failure that motivated the whole exception, and only resolving the
// preset against the real runtime catches its recurrence.
const phases = [
  ['Synthetic dependency extraction', 'tools/check-renovate-extraction.mjs'],
  ['Renovate configuration validation', 'tools/validate-renovate.mjs'],
  ['Effective Renovate policy', 'tools/check-renovate-effective-policy.mjs'],
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
