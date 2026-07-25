import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { collectVerificationCleanProblems } from './check-verification-clean.mjs'

function fixture(context) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-clean-'))
  context.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }))
  return repoRoot
}

test('accepts a clean dependency-free checkout', (context) => {
  const repoRoot = fixture(context)
  assert.deepEqual(collectVerificationCleanProblems({ repoRoot, status: '' }), [])
})

test('reports repository changes and ignored install artifacts together', (context) => {
  const repoRoot = fixture(context)
  fs.writeFileSync(path.join(repoRoot, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
  for (const artifact of ['node_modules', '.pnpm-store']) {
    fs.mkdirSync(path.join(repoRoot, artifact), { recursive: true })
  }

  const problems = collectVerificationCleanProblems({
    repoRoot,
    status: ' M package.json\n?? generated.txt',
  }).join('\n')
  assert.match(problems, /repository files changed/)
  assert.match(problems, /M package\.json/)
  assert.match(problems, /pnpm-lock\.yaml/)
  assert.match(problems, /node_modules/)
  assert.match(problems, /\.pnpm-store/)
})
