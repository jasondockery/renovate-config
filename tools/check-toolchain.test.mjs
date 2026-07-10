import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { collectToolchainProblems } from './check-toolchain.mjs'

function fixture(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-toolchain-'))
  const defaults = {
    '.node-version': '24.18.0\n',
    '.nvmrc': '24.18.0\n',
    'mise.toml': '[tools]\nnode = "24.18.0"\npnpm = "11.9.0"\n',
    'package.json': JSON.stringify({
      packageManager: 'pnpm@11.9.0',
      engines: { node: '24.18.0', pnpm: '11.9.0' },
    }),
    '.github/workflows/ci.yml':
      'uses: actions/setup-node@0000000000000000000000000000000000000000\nwith:\n  node-version-file: .node-version\n',
    ...files,
  }
  for (const [relativePath, content] of Object.entries(defaults)) {
    const absolute = path.join(root, relativePath)
    fs.mkdirSync(path.dirname(absolute), { recursive: true })
    fs.writeFileSync(absolute, content)
  }
  return root
}

test('accepts synchronized declarations and exact running versions', (context) => {
  const repoRoot = fixture()
  context.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }))
  assert.deepEqual(
    collectToolchainProblems({
      repoRoot,
      nodeVersion: 'v24.18.0',
      userAgent: 'pnpm/11.9.0 npm/? node/v24.18.0 darwin arm64',
    }),
    []
  )
})

test('reports declaration, runtime, package-manager, and CI drift together', (context) => {
  const repoRoot = fixture({
    '.nvmrc': '24.17.0\n',
    'mise.toml': '[tools]\nnode = "24.17.0"\npnpm = "11.8.0"\n',
    '.github/workflows/ci.yml':
      'uses: actions/setup-node@0000000000000000000000000000000000000000\nwith:\n  node-version-file: .node-version\n---\nuses: actions/setup-node@0000000000000000000000000000000000000000\nwith:\n  node-version-file: .nvmrc\n',
  })
  context.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }))
  const problems = collectToolchainProblems({
    repoRoot,
    nodeVersion: 'v26.5.0',
    userAgent: 'pnpm/11.8.0 npm/? node/v26.5.0 darwin arm64',
  }).join('\n')
  assert.match(problems, /\.nvmrc \(24\.17\.0\)/)
  assert.match(problems, /mise\.toml pnpm \(11\.8\.0\)/)
  assert.match(problems, /running Node 26\.5\.0/)
  assert.match(problems, /running pnpm 11\.8\.0/)
  assert.match(problems, /actions\/setup-node from \.node-version/)
})
