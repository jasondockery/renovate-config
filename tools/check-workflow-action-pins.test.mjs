import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { collectWorkflowActionPinProblems } from './check-workflow-action-pins.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-action-pins-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(repoRoot, '.github/workflows')
  const target = path.join(root, '.github/workflows')
  fs.mkdirSync(target, { recursive: true })
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.isFile() && /\.ya?ml$/u.test(entry.name)) {
      fs.copyFileSync(path.join(source, entry.name), path.join(target, entry.name))
    }
  }
  return root
}

function writeWorkflow(root, name, source) {
  fs.writeFileSync(path.join(root, '.github/workflows', name), source)
}

test('accepts every checked-in workflow action pin offline', () => {
  assert.deepEqual(collectWorkflowActionPinProblems(repoRoot), [])
})

test('new workflow files cannot bypass full-SHA and semver-comment validation', async (context) => {
  await context.test('moving action ref', (subcontext) => {
    const root = fixture(subcontext)
    writeWorkflow(root, 'new.yml', 'jobs:\n  test:\n    steps:\n      - uses: example/action@main # v1.2.3\n')
    assert.match(collectWorkflowActionPinProblems(root).join('\n'), /full lowercase 40-character SHA/)
  })
  await context.test('missing comment', (subcontext) => {
    const root = fixture(subcontext)
    writeWorkflow(root, 'new.yaml', `jobs:\n  test:\n    steps:\n      - uses: example/action@${'1'.repeat(40)}\n`)
    assert.match(collectWorkflowActionPinProblems(root).join('\n'), /exact semver comment/)
  })
  await context.test('malformed comment', (subcontext) => {
    const root = fixture(subcontext)
    writeWorkflow(root, 'new.yml', `jobs:\n  test:\n    steps:\n      - uses: example/action@${'1'.repeat(40)} # v1\n`)
    assert.match(collectWorkflowActionPinProblems(root).join('\n'), /exact semver comment/)
  })
})

test('rejects conflicting repository identities for the same action', (context) => {
  const root = fixture(context)
  writeWorkflow(root, 'one.yml', `jobs:\n  one:\n    steps:\n      - uses: example/action@${'1'.repeat(40)} # v1.2.3\n`)
  writeWorkflow(root, 'two.yaml', `jobs:\n  two:\n    steps:\n      - uses: example/action@${'2'.repeat(40)} # v1.2.3\n      - uses: example/action@${'1'.repeat(40)} # v2.0.0\n`)
  const problems = collectWorkflowActionPinProblems(root).join('\n')
  assert.match(problems, /v1\.2\.3 is paired with conflicting SHAs/)
  assert.match(problems, /is labeled with conflicting versions/)
})

test('rejects the exact old upload-artifact pin copied into a new workflow', (context) => {
  const root = fixture(context)
  fs.copyFileSync(
    path.join(repoRoot, 'tools/fixtures/workflows/upload-artifact-old-sha.yml.fixture'),
    path.join(root, '.github/workflows/hostile.yml'),
  )
  assert.match(
    collectWorkflowActionPinProblems(root).join('\n'),
    /actions\/upload-artifact differs from the canonical 043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7\.0\.1/,
  )
})
