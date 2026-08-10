import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { checkCompassProjection } from './check-compass-projection.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-compass-'))
  for (const relativePath of ['.compass', 'skills/dependency-change', 'skills/field-failure-backpressure', 'skills/performance-sensitive-change', 'skills/verification-selection']) {
    fs.cpSync(path.join(repositoryRoot, relativePath), path.join(root, relativePath), { recursive: true })
  }
  fs.copyFileSync(path.join(repositoryRoot, 'AGENTS.md'), path.join(root, 'AGENTS.md'))
  return root
}

test('Compass projection matches its exact artifact receipt', () => {
  assert.deepEqual(checkCompassProjection(repositoryRoot), [])
})

test('Compass projection fails on projected-byte drift', () => {
  const root = fixture()
  fs.appendFileSync(path.join(root, '.compass/COMPASS.md'), '\nindependent policy\n')
  assert.match(checkCompassProjection(root).join('\n'), /COMPASS\.md/u)
})

test('Compass projection fails on a dirty or stale provenance receipt', () => {
  const root = fixture()
  const file = path.join(root, '.compass/receipt.json')
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8'))
  receipt.source.dirty = true
  receipt.source.commit = 'not-a-sha'
  fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`)
  const problems = checkCompassProjection(root).join('\n')
  assert.match(problems, /40-character SHA/u)
  assert.match(problems, /dirty=false/u)
})

test('Compass projection fails closed on missing or extra managed files', () => {
  const missing = fixture()
  fs.rmSync(path.join(missing, 'skills/dependency-change/agents/openai.yaml'))
  assert.match(checkCompassProjection(missing).join('\n'), /missing|unexpected/u)

  const extra = fixture()
  fs.writeFileSync(path.join(extra, '.compass/independent.md'), 'drift\n')
  assert.match(checkCompassProjection(extra).join('\n'), /must contain only/u)
})

test('Compass projection requires root routing to the local generated authority', () => {
  const root = fixture()
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Local only\n')
  assert.match(checkCompassProjection(root).join('\n'), /does not route/u)
})
