#!/usr/bin/env node
// CI calls this from a clean checkout immediately after each verification
// command. Ignored install artifacts need explicit checks because git status
// does not report them.
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { isMainModule } from './is-main.mjs'
import { runBoundedGit } from './repository-readonly-identity.mjs'

const FORBIDDEN_ARTIFACTS = ['pnpm-lock.yaml', 'node_modules', '.pnpm-store']
const canonicalRepositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function repositoryStatus(repoRoot = canonicalRepositoryRoot, gitOptions) {
  try {
    return runBoundedGit(
      repoRoot,
      ['status', '--porcelain=v1', '--untracked-files=all'],
      gitOptions
    ).trim()
  } catch (error) {
    throw new Error(
      `verification cleanliness could not inspect ${repoRoot}: ${error instanceof Error ? error.message : String(error)}. ` +
      `Recovery: run git -C ${JSON.stringify(repoRoot)} status --porcelain=v1 --untracked-files=all, correct the Git failure, then rerun this check.`,
      { cause: error }
    )
  }
}

export function collectVerificationCleanProblems({
  repoRoot = canonicalRepositoryRoot,
  status,
  gitOptions,
} = {}) {
  const problems = []
  const observedStatus = status ?? repositoryStatus(repoRoot, gitOptions)
  if (observedStatus) {
    problems.push(`repository files changed:\n${observedStatus}`)
  }
  for (const artifact of FORBIDDEN_ARTIFACTS) {
    if (fs.existsSync(path.join(repoRoot, artifact))) {
      problems.push(`verification created forbidden artifact ${artifact}`)
    }
  }
  return problems
}

export function checkVerificationClean(options) {
  let problems
  try {
    problems = collectVerificationCleanProblems(options)
  } catch (error) {
    console.error('verification read-only check failed:')
    console.error(`  - ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
  if (problems.length === 0) {
    console.log('ok: verification left the dependency-free checkout unchanged')
    return true
  }
  console.error('verification read-only check failed:')
  for (const problem of problems) console.error(`  - ${problem}`)
  return false
}

if (isMainModule(import.meta.url) && !checkVerificationClean()) {
  process.exitCode = 1
}
