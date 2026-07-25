#!/usr/bin/env node
// CI calls this from a clean checkout immediately after each verification
// command. Ignored install artifacts need explicit checks because git status
// does not report them.
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const FORBIDDEN_ARTIFACTS = ['pnpm-lock.yaml', 'node_modules', '.pnpm-store']

function repositoryStatus(repoRoot) {
  return execFileSync(
    'git',
    ['-C', repoRoot, 'status', '--porcelain=v1', '--untracked-files=all'],
    { encoding: 'utf8' }
  ).trim()
}

export function collectVerificationCleanProblems({
  repoRoot = process.cwd(),
  status = repositoryStatus(repoRoot),
} = {}) {
  const problems = []
  if (status) {
    problems.push(`repository files changed:\n${status}`)
  }
  for (const artifact of FORBIDDEN_ARTIFACTS) {
    if (fs.existsSync(path.join(repoRoot, artifact))) {
      problems.push(`verification created forbidden artifact ${artifact}`)
    }
  }
  return problems
}

export function checkVerificationClean(options) {
  const problems = collectVerificationCleanProblems(options)
  if (problems.length === 0) {
    console.log('ok: verification left the dependency-free checkout unchanged')
    return true
  }
  console.error('verification read-only check failed:')
  for (const problem of problems) console.error(`  - ${problem}`)
  return false
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url) && !checkVerificationClean()) {
  process.exitCode = 1
}
