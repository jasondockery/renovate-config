import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { applyUpdatesAtomically, plannedToolchainUpdates, syncToolchain, synchronizeMise } from './sync-toolchain.mjs'

function fixture(context, mise = '[tools]\nnode = "18.20.4"\npnpm = "9.15.5"\n') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-toolchain-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, '.node-version'), '20.11.1\n')
  fs.writeFileSync(path.join(root, '.nvmrc'), '18.20.4\n')
  fs.writeFileSync(path.join(root, 'mise.toml'), mise)
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({ packageManager: 'pnpm@9.15.5', engines: {} }, null, 2)}\n`)
  return root
}

test('sync derives mirrors and a second run is byte-for-byte inert', (context) => {
  const root = fixture(context)
  assert.equal(plannedToolchainUpdates(root).length, 3)
  syncToolchain(root)
  const snapshot = ['.nvmrc', 'mise.toml', 'package.json'].map((file) => fs.readFileSync(path.join(root, file), 'utf8'))
  assert.deepEqual(syncToolchain(root), [])
  assert.deepEqual(['.nvmrc', 'mise.toml', 'package.json'].map((file) => fs.readFileSync(path.join(root, file), 'utf8')), snapshot)
})

test('sync rejects unsupported TOML and malformed input before writing', (context) => {
  assert.throws(() => synchronizeMise('[tools]\n"node" = "1.2.3"\n', '2.0.0'), /quoted tool keys/)
  assert.throws(() => synchronizeMise('[tools]\nnode = "1.2.3"\nnot valid toml\n', '2.0.0'), /unsupported \[tools] entry/)
  assert.throws(() => synchronizeMise('[tools]\nnode = "1.2.3"\nnode = "1.2.4"\n', '2.0.0'), /exactly one node/)
  assert.throws(() => synchronizeMise('[tools]\nnode = "1.2.3"\npnpm = "1.0.0"\npnpm = "1.0.1"\n', '2.0.0'), /duplicate pnpm/)
  assert.equal(synchronizeMise('[tools]\r\nnode = "1.2.3"\r\n[settings]\r\nexperimental = true\r\n', '2.0.0'), '[tools]\r\nnode = "2.0.0"\r\n[settings]\r\nexperimental = true\r\n')
  const root = fixture(context); fs.writeFileSync(path.join(root, 'package.json'), '{')
  assert.throws(() => syncToolchain(root))
  assert.equal(fs.readFileSync(path.join(root, '.nvmrc'), 'utf8'), '18.20.4\n')
})

test('atomic application restores earlier targets after a later failure', (context) => {
  const root = fixture(context); const original = fs.readFileSync(path.join(root, '.nvmrc'), 'utf8')
  let renames = 0
  const ops = {
    write(file, contents, mode) { fs.writeFileSync(file, contents, { mode, flag: 'wx' }) },
    rename(from, to) { renames += 1; if (renames === 2) throw new Error('injected failure'); fs.renameSync(from, to) },
    remove(file) { fs.rmSync(file, { force: true }) },
    mode(file) { return fs.statSync(file).mode & 0o777 },
  }
  assert.throws(() => applyUpdatesAtomically(root, plannedToolchainUpdates(root), ops), /injected failure/)
  assert.equal(fs.readFileSync(path.join(root, '.nvmrc'), 'utf8'), original)
})

test('a failed rollback names what stayed modified without hiding the original failure', (context) => {
  const root = fixture(context)
  let renames = 0
  const ops = {
    write(file, contents, mode) { if (file.endsWith('.restore')) throw new Error('injected restore failure'); fs.writeFileSync(file, contents, { mode, flag: 'wx' }) },
    rename(from, to) { renames += 1; if (renames === 2) throw new Error('injected rename failure'); fs.renameSync(from, to) },
    remove(file) { fs.rmSync(file, { force: true }) },
    mode(file) { return fs.statSync(file).mode & 0o777 },
  }
  let thrown
  try { applyUpdatesAtomically(root, plannedToolchainUpdates(root), ops) } catch (error) { thrown = error }
  assert.match(thrown?.message ?? '', /injected rename failure/)
  assert.match(thrown?.message ?? '', /rollback could not restore/)
})
