import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { collectVerificationCleanProblems, repositoryStatus } from './check-verification-clean.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

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

function cliRepository(context) {
  const root = fixture(context)
  fs.mkdirSync(path.join(root, 'tools'))
  fs.mkdirSync(path.join(root, 'nested/deeper'), { recursive: true })
  for (const file of ['check-verification-clean.mjs', 'is-main.mjs', 'repository-readonly-identity.mjs']) {
    fs.copyFileSync(path.join(repositoryRoot, 'tools', file), path.join(root, 'tools', file))
  }
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n')
  const git = (...arguments_) => {
    const result = spawnSync('git', arguments_, { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  git('init', '-q')
  git('add', '.')
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture')
  fs.mkdirSync(path.join(root, 'node_modules'))
  const link = path.join(root, 'check-clean-link.mjs')
  fs.symlinkSync(path.join(root, 'tools/check-verification-clean.mjs'), link)
  return { root, script: path.join(root, 'tools/check-verification-clean.mjs'), link }
}

test('CLI finds a root ignored artifact from every supported caller location', (context) => {
  const { root, script, link } = cliRepository(context)
  const invocations = [
    { cwd: root, script: 'tools/check-verification-clean.mjs' },
    { cwd: path.join(root, 'tools'), script: 'check-verification-clean.mjs' },
    { cwd: path.join(root, 'nested/deeper'), script: '../../tools/check-verification-clean.mjs' },
    { cwd: root, script },
    { cwd: path.join(root, 'nested'), script: link },
  ]
  for (const invocation of invocations) {
    const result = spawnSync(process.execPath, [invocation.script], {
      cwd: invocation.cwd,
      encoding: 'utf8',
      timeout: 5_000,
    })
    assert.equal(result.status, 1, `${invocation.cwd}: ${result.stderr}`)
    assert.match(result.stderr, /forbidden artifact node_modules/u)
    assert.doesNotMatch(result.stdout, /checkout unchanged/u)
  }
})

test('repository status times out a hung Git process without claiming clean', (context) => {
  const root = fixture(context)
  const fakeGit = path.join(root, 'fake-git')
  fs.writeFileSync(fakeGit, '#!/usr/bin/env node\nsetInterval(() => {}, 1000)\n')
  fs.chmodSync(fakeGit, 0o755)
  const started = Date.now()
  assert.throws(
    () => repositoryStatus(root, { command: fakeGit, timeoutMilliseconds: 75 }),
    /timed out after 75ms[\s\S]*Recovery:/u
  )
  assert.ok(Date.now() - started < 1_000)
})
