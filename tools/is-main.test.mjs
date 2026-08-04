import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { isMainModule } from './is-main.mjs'

// Every CLI in tools/ gates its side effects on this. A false positive runs a
// checker during an import; a false negative silently turns a CLI into a no-op.
const here = new URL(import.meta.url)

// Note: passing `undefined` would trigger the default parameter and fall back
// to process.argv[1], so an absent argv path is modelled with null/'' here.
test('an absent argv path is never main', () => {
  assert.equal(isMainModule(here.href, null), false)
  assert.equal(isMainModule(here.href, ''), false)
})

test('the same file is main, a different file is not', (context) => {
  const self = new URL('is-main.test.mjs', import.meta.url)
  assert.equal(isMainModule(self.href, self.pathname), true)
  assert.equal(isMainModule(self.href, new URL('is-main.mjs', import.meta.url).pathname), false)

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'is-main-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const other = path.join(root, 'other.mjs')
  fs.writeFileSync(other, '')
  assert.equal(isMainModule(self.href, other), false)
})

test('a symlinked invocation still resolves to the same module', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'is-main-link-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const target = path.join(root, 'real.mjs')
  fs.writeFileSync(target, '')
  const link = path.join(root, 'link.mjs')
  fs.symlinkSync(target, link)
  assert.equal(isMainModule(pathToFileURL(target).href, link), true)
})

test('a missing or broken path is not main rather than throwing', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'is-main-missing-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const broken = path.join(root, 'broken.mjs')
  fs.symlinkSync(path.join(root, 'absent.mjs'), broken)
  assert.equal(isMainModule(here.href, path.join(root, 'absent.mjs')), false)
  assert.equal(isMainModule(here.href, broken), false)
})
