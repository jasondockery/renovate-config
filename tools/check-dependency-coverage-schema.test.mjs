import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { collectDependencyCoverageSchemaProblems } from './check-dependency-coverage-schema.mjs'
import { validateAgainstSchema } from './json-schema-subset.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function tree(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-schema-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'specs'))
  fs.copyFileSync(
    path.join(repositoryRoot, 'specs/dependency-coverage.schema.json'),
    path.join(root, 'specs/dependency-coverage.schema.json')
  )
  return root
}

function writeInventory(root, mutate = () => {}) {
  const inventory = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, 'dependency-coverage.json'), 'utf8')
  )
  mutate(inventory)
  fs.writeFileSync(path.join(root, 'dependency-coverage.json'), `${JSON.stringify(inventory, null, 2)}\n`)
}

test('the live inventory satisfies its declared schema', () => {
  assert.deepEqual(collectDependencyCoverageSchemaProblems(), [])
})

test('an unknown key, wrong enum, or missing required field is rejected', (context) => {
  const root = tree(context)

  writeInventory(root, (inventory) => { inventory.surfaces[0].unexpected = true })
  assert.match(collectDependencyCoverageSchemaProblems(root).join('\n'), /has unknown key "unexpected"/)

  writeInventory(root, (inventory) => { inventory.surfaces[0].classification = 'invented' })
  assert.match(collectDependencyCoverageSchemaProblems(root).join('\n'), /must be one of/)

  writeInventory(root, (inventory) => { delete inventory.surfaces[0].compensatingControl })
  assert.match(
    collectDependencyCoverageSchemaProblems(root).join('\n'),
    /missing required key "compensatingControl"/
  )

  writeInventory(root, (inventory) => { inventory.schemaVersion = 3 })
  assert.match(collectDependencyCoverageSchemaProblems(root).join('\n'), /must equal 2/)

  writeInventory(root, (inventory) => { inventory.surfaces = [] })
  assert.match(collectDependencyCoverageSchemaProblems(root).join('\n'), /at least 1 item/)

  writeInventory(root, (inventory) => { inventory.surfaces[0].id = 'Not Kebab' })
  assert.match(collectDependencyCoverageSchemaProblems(root).join('\n'), /must match/)
})

test('a drifted or absent $schema pointer is rejected', (context) => {
  const root = tree(context)
  writeInventory(root, (inventory) => { delete inventory.$schema })
  assert.match(collectDependencyCoverageSchemaProblems(root).join('\n'), /must declare "\$schema"/)

  writeInventory(root, (inventory) => { inventory.$schema = 'https://example.invalid/other.json' })
  assert.match(collectDependencyCoverageSchemaProblems(root).join('\n'), /must declare "\$schema"/)
})

test('the subset validator refuses a schema keyword it does not implement', () => {
  assert.throws(
    () => validateAgainstSchema({ a: 1 }, { type: 'object', oneOf: [] }),
    /unsupported schema keyword "oneOf"/
  )
  assert.throws(
    () => validateAgainstSchema({}, { type: 'object', additionalProperties: { type: 'string' } }),
    /only additionalProperties:false is supported/
  )
})

test('the subset validator enforces each supported keyword', () => {
  assert.deepEqual(validateAgainstSchema('abc', { type: 'string', minLength: 3 }), [])
  assert.match(validateAgainstSchema('ab', { type: 'string', minLength: 3 }).join(), /at least 3 characters/)
  assert.match(validateAgainstSchema(1.5, { type: 'integer' }).join(), /must be of type integer/)
  assert.match(validateAgainstSchema(0, { type: 'integer', minimum: 1 }).join(), /must be at least 1/)
  assert.match(validateAgainstSchema([1, 1], { type: 'array', uniqueItems: true }).join(), /unique items/)
  assert.deepEqual(validateAgainstSchema([1, 2], { type: 'array', uniqueItems: true }), [])
  assert.match(
    validateAgainstSchema({ a: [{ b: 1 }] }, {
      type: 'object',
      properties: { a: { type: 'array', items: { type: 'object', properties: { b: { type: 'string' } } } } },
    }).join(),
    /a\[0\]\.b must be of type string/
  )
})
