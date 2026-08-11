import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { validateJsonSchema } from '../.compass/validate-json-schema.mjs'
import {
  buildCompassHostedAdoptionReceipt,
  writeCompassHostedAdoptionReceipt,
} from './compass-hosted-adoption-receipt.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tool = path.join(repositoryRoot, 'tools/compass-hosted-adoption-receipt.mjs')
const schema = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, '.compass/consumer-hosted-adoption-receipt.schema.json'), 'utf8')
)
const input = Object.freeze({
  repository: 'jasondockery/renovate-config',
  commit: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  reconciliationPath: 'tools/compass-consumer-reconciliation.json',
  workflow: '.github/workflows/ci.yml',
  requiredGate: 'ci-gate',
  runId: '123',
  attempt: '2',
  headSha: 'a'.repeat(40),
  artifactName: 'renovate-config-ci-receipt-123-2',
  artifactPath: 'compass-hosted-adoption-receipt.json',
})

test('hosted Compass receipt is exact, schema-valid, and provider-addressable', () => {
  const receipt = buildCompassHostedAdoptionReceipt(input)
  assert.deepEqual(validateJsonSchema(receipt, schema), [])
  assert.equal(receipt.schema, 'compass.consumer-hosted-adoption-receipt')
  assert.equal(receipt.consumer.commit, receipt.hostedRun.headSha)
  assert.equal(receipt.hostedRun.runId, 123)
  assert.equal(receipt.hostedRun.attempt, 2)
  assert.equal(receipt.artifact.name, 'renovate-config-ci-receipt-123-2')
})

test('hosted Compass receipt rejects malformed identity, paths, and run values', () => {
  for (const [label, mutation] of [
    ['repository', { repository: 'local' }],
    ['commit', { commit: 'short', headSha: 'short' }],
    ['tree', { tree: 'short' }],
    ['reconciliation path', { reconciliationPath: '../record.json' }],
    ['run ID zero', { runId: '0' }],
    ['run ID negative', { runId: '-1' }],
    ['attempt zero', { attempt: '0' }],
    ['artifact path', { artifactPath: '/receipt.json' }],
    ['head mismatch', { headSha: 'c'.repeat(40) }],
  ]) {
    assert.throws(() => buildCompassHostedAdoptionReceipt({ ...input, ...mutation }), undefined, label)
  }
})

test('hosted Compass receipt writer is authoritative and the CLI fails closed', () => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'compass-hosted-receipt-'))
  const output = path.join(directory, 'receipt.json')
  const receipt = writeCompassHostedAdoptionReceipt({ ...input, output })
  assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), receipt)

  const rejected = path.join(directory, 'rejected.json')
  const result = spawnSync(process.execPath, [tool, '--output', rejected, '--unknown', 'value'])
  assert.equal(result.status, 64)
  assert.equal(fs.existsSync(rejected), false)
})
