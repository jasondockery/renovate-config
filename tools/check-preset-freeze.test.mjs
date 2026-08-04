import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { collectPresetFreezeProblems } from './check-preset-freeze.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CHECKER = path.join(repositoryRoot, 'tools/check-preset-freeze.mjs')

function fixture(context, { preset = '{"a":1}\n', marker } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preset-freeze-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'default.json'), preset)
  if (marker !== undefined) fs.writeFileSync(path.join(root, '.preset-bootstrap-freeze'), marker)
  return root
}

function digestOf(text) {
  return createHash('sha256').update(Buffer.from(text)).digest('hex')
}

test('the live repository preset matches its frozen digest', () => {
  assert.deepEqual(collectPresetFreezeProblems().problems, [])
})

test('a matching digest passes and a changed preset fails closed', (context) => {
  const preset = '{"minimumReleaseAge":"5 days"}\n'
  const root = fixture(context, {
    preset,
    marker: `# comment\n\n${digestOf(preset)}\n`,
  })
  assert.deepEqual(collectPresetFreezeProblems(root), { lifted: false, problems: [] })

  fs.writeFileSync(path.join(root, 'default.json'), '{"minimumReleaseAge":"3 days"}\n')
  const changed = collectPresetFreezeProblems(root)
  assert.equal(changed.lifted, false)
  assert.match(changed.problems.join('\n'), /changed while the preset bootstrap freeze is in effect/)
})

test('a malformed or unreadable input fails instead of reporting lifted', (context) => {
  const noDigest = fixture(context, { marker: '# only comments\n' })
  assert.match(
    collectPresetFreezeProblems(noDigest).problems.join('\n'),
    /does not contain a sha256 digest line/
  )

  const shortDigest = fixture(context, { marker: 'abc123\n' })
  assert.match(
    collectPresetFreezeProblems(shortDigest).problems.join('\n'),
    /does not contain a sha256 digest line/
  )

  const missingPreset = fs.mkdtempSync(path.join(os.tmpdir(), 'preset-freeze-'))
  context.after(() => fs.rmSync(missingPreset, { recursive: true, force: true }))
  fs.writeFileSync(path.join(missingPreset, '.preset-bootstrap-freeze'), `${digestOf('x')}\n`)
  assert.match(
    collectPresetFreezeProblems(missingPreset).problems.join('\n'),
    /must be readable while the preset freeze is in effect/
  )
})

test('an absent marker reports the freeze lifted only for that exact tree', (context) => {
  const root = fixture(context)
  assert.deepEqual(collectPresetFreezeProblems(root), { lifted: true, problems: [] })
  assert.equal(collectPresetFreezeProblems().lifted, false)
})

// The field failure this guards: the checker used to resolve `.preset-bootstrap-freeze`
// from process.cwd(), so running it from anywhere but the repository root printed
// "preset freeze is lifted" and exited 0 while the freeze was fully in effect.
test('the CLI binds to the repository root, not the caller cwd', (context) => {
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'preset-freeze-cwd-'))
  context.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }))
  const output = execFileSync(process.execPath, [CHECKER], { cwd: elsewhere, encoding: 'utf8' })
  assert.match(output, /matches the frozen digest/)
  assert.doesNotMatch(output, /freeze is lifted/)
})
