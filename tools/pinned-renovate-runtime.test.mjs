import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { findPinnedRenovateRoot, importRenovateModule } from './pinned-renovate-runtime.mjs'

// This module decides which Renovate installation every network-backed proof
// runs against. Resolving the wrong one silently validates against a runtime
// the repository never pinned.
function runtime(context, { name = 'renovate', nested = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pinned-runtime-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const bin = path.join(root, 'bin')
  const packageRoot = nested ? path.join(root, 'lib', 'node_modules', 'renovate') : path.join(root, 'pkg')
  fs.mkdirSync(bin, { recursive: true })
  fs.mkdirSync(path.join(packageRoot, 'dist'), { recursive: true })
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name, version: '1.2.3' }))
  const real = path.join(packageRoot, 'renovate.js')
  fs.writeFileSync(real, '#!/usr/bin/env node\n')
  fs.symlinkSync(real, path.join(bin, 'renovate'))
  return { root, bin, packageRoot }
}

test('requires a usable PATH', () => {
  assert.throws(() => findPinnedRenovateRoot({}), /PATH is unavailable/)
  assert.throws(() => findPinnedRenovateRoot({ PATH: '' }), /PATH is unavailable/)
})

test('resolves the package root through the bin symlink', (context) => {
  const { bin, packageRoot } = runtime(context)
  assert.equal(findPinnedRenovateRoot({ PATH: bin }), fs.realpathSync(packageRoot))
})

test('walks up an npx-style nested layout and skips empty PATH entries', (context) => {
  const { bin, packageRoot } = runtime(context, { nested: true })
  assert.equal(
    findPinnedRenovateRoot({ PATH: `${path.delimiter}${bin}${path.delimiter}` }),
    fs.realpathSync(packageRoot)
  )
})

test('refuses a PATH with no renovate, or a package that is not renovate', (context) => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'pinned-runtime-empty-'))
  context.after(() => fs.rmSync(empty, { recursive: true, force: true }))
  assert.throws(() => findPinnedRenovateRoot({ PATH: empty }), /not present on PATH/)

  const { bin } = runtime(context, { name: 'not-renovate' })
  assert.throws(() => findPinnedRenovateRoot({ PATH: bin }), /not present on PATH/)
})

test('refuses a module path that escapes the runtime dist directory', async (context) => {
  const { packageRoot } = runtime(context)
  await assert.rejects(
    () => importRenovateModule(packageRoot, '../../../etc/passwd'),
    /escaped the runtime/
  )
  await assert.rejects(
    () => importRenovateModule(packageRoot, '/etc/passwd'),
    /escaped the runtime/
  )
})
