import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  ACCEPTED_COMPASS_IDENTITY,
  checkAcceptedCompassIdentity,
  checkCompassProjection,
  checkSkillDiscovery,
} from './check-compass-projection.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-compass-'))
  for (const relativePath of ['.compass', 'skills']) {
    fs.cpSync(path.join(repositoryRoot, relativePath), path.join(root, relativePath), { recursive: true })
  }
  fs.copyFileSync(path.join(repositoryRoot, 'AGENTS.md'), path.join(root, 'AGENTS.md'))
  for (const adapterRoot of ['.agents', '.claude']) {
    fs.mkdirSync(path.join(root, adapterRoot))
    fs.symlinkSync('../skills', path.join(root, adapterRoot, 'skills'))
  }
  return root
}

test('Compass projection matches its exact artifact receipt', () => {
  assert.deepEqual(checkCompassProjection(repositoryRoot), [])
})

test('renovate-config binds its accepted Compass identity rather than either historical final claim', () => {
  const receiptBytes = fs.readFileSync(path.join(repositoryRoot, '.compass/receipt.json'))
  const receipt = JSON.parse(receiptBytes)
  const receiptSha256 = createHash('sha256').update(receiptBytes).digest('hex')
  assert.deepEqual(checkAcceptedCompassIdentity(receipt, receiptSha256), [])
  assert.equal(ACCEPTED_COMPASS_IDENTITY.commit, '94c7770e4b7d2e8652763ad16c4dba4eb181c8a4')
  assert.equal(ACCEPTED_COMPASS_IDENTITY.receiptSha256, receiptSha256)

  const cases = [
    ['commit', (candidate) => { candidate.source.commit = 'cd1e684825e06a12cac688c066357d4a34687039' }],
    ['tree', (candidate) => { candidate.source.tree = '0'.repeat(40) }],
    ['fingerprintSha256', (candidate) => { candidate.source.fingerprintSha256 = '0'.repeat(64) }],
    ['artifactSha256', (candidate) => { candidate.artifactSha256 = '0'.repeat(64) }],
    ['artifactBytes', (candidate) => { candidate.artifactBytes = 1 }],
    ['validationReceiptSha256', (candidate) => { candidate.validation.receiptSha256 = '0'.repeat(64) }],
  ]
  for (const [field, mutate] of cases) {
    const candidate = structuredClone(receipt)
    mutate(candidate)
    assert.match(
      checkAcceptedCompassIdentity(candidate, receiptSha256).join('\n'),
      new RegExp(`accepted Compass ${field} differs`, 'u'),
      field
    )
  }
  assert.match(
    checkAcceptedCompassIdentity(receipt, '0'.repeat(64)).join('\n'),
    /accepted Compass receiptSha256 differs/u
  )
})

test('renovate-config does not reimplement generic Compass conformance', () => {
  const source = fs.readFileSync(path.join(repositoryRoot, 'tools/check-compass-projection.mjs'), 'utf8')
  assert.match(source, /from '\.\.\/\.compass\/check-projection\.mjs'/u)
  assert.doesNotMatch(source, /expectedSourcePaths/u)
  assert.doesNotMatch(source, /dependency-change|field-failure-backpressure|performance-sensitive-change|verification-selection/u)
  assert.doesNotMatch(source, /REQUIRED_LOCAL_ROUTES/u)
})

test('renovate-config rejects receipt-byte drift even when parsed identity fields are unchanged', () => {
  const root = fixture()
  fs.appendFileSync(path.join(root, '.compass/receipt.json'), '\n')
  assert.match(checkCompassProjection(root).join('\n'), /accepted Compass receiptSha256 differs/u)
})

test('renovate-config wrapper delegates generic drift semantics to Compass', () => {
  const root = fixture()
  fs.appendFileSync(path.join(root, '.compass/COMPASS.md'), '\nindependent policy\n')
  assert.match(checkCompassProjection(root).join('\n'), /COMPASS\.md/u)
})

test('renovate-config wrapper retains only repository-local AGENTS routing', () => {
  const root = fixture()
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Local only\n')
  assert.match(checkCompassProjection(root).join('\n'), /does not route/u)
})

test('skill discovery is derived from the receipt and accepts a future projected skill', () => {
  const root = fixture()
  const receipt = JSON.parse(fs.readFileSync(path.join(root, '.compass/receipt.json'), 'utf8'))
  const futureName = 'future-shared-skill'
  const futurePath = path.join(root, 'skills', futureName, 'SKILL.md')
  fs.mkdirSync(path.dirname(futurePath), { recursive: true })
  fs.writeFileSync(futurePath, '# Future shared skill\n')
  receipt.includedFiles.push({ path: `skills/${futureName}/SKILL.md` })
  assert.deepEqual(checkSkillDiscovery(root, receipt), [])

  fs.rmSync(path.join(root, '.agents/skills'))
  fs.symlinkSync('../missing-skills', path.join(root, '.agents/skills'))
  assert.match(checkSkillDiscovery(root, receipt).join('\n'), /\.agents\/skills/u)
})
