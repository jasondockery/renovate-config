#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { readRenovateVersion } from './renovate-runtime.mjs'

const version = readRenovateVersion(process.cwd())
const completed = spawnSync(
  'npx',
  [
    '--yes',
    '--package',
    `renovate@${version}`,
    '--',
    'node',
    'tools/check-renovate-effective-policy.mjs',
  ],
  {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
    timeout: 240_000,
  }
)
if (completed.error) {
  console.error(`Effective Renovate policy could not acquire Renovate ${version}: ${completed.error.message}`)
  process.exitCode = 1
} else {
  process.exitCode = Number.isInteger(completed.status) ? completed.status : 1
}
