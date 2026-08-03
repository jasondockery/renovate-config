import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const inventory = JSON.parse(fs.readFileSync(path.join(repoRoot, 'dependency-coverage.json'), 'utf8'))
const classifications = new Set(['built-in', 'custom-manager', 'derived', 'intentional-manual'])
const agePolicies = new Set([
  'renovate-minimum-release-age',
  'unsupported-by-renovate',
  'external-tool-policy',
  'not-applicable',
])
const scanPatterns = new Set([
  'digest',
  'version-assignment',
  'release-download',
  'container-reference',
  'workflow-reference',
  'runtime-literal',
  'plugin-reference',
])

function assertScanMatcher(matcher, label, { suppression = false } = {}) {
  assert.equal(typeof matcher.pathPattern, 'string', `${label}: pathPattern`)
  assert.doesNotThrow(() => new RegExp(matcher.pathPattern, 'u'), `${label}: pathPattern`)
  assert.equal(scanPatterns.has(matcher.pattern), true, `${label}: pattern`)
  if (matcher.linePattern !== undefined) {
    assert.equal(typeof matcher.linePattern, 'string', `${label}: linePattern`)
    assert.doesNotThrow(() => new RegExp(matcher.linePattern, 'u'), `${label}: linePattern`)
  }
  if (suppression) {
    assert.equal(typeof matcher.linePattern, 'string', `${label}: linePattern required`)
    assert.ok(matcher.linePattern.length > 0, `${label}: linePattern required`)
    assert.equal(Number.isInteger(matcher.expectedMatches), true, `${label}: expectedMatches`)
    assert.ok(matcher.expectedMatches > 0, `${label}: expectedMatches`)
    assert.ok(matcher.reason?.trim(), `${label}: reason`)
  }
  else if (matcher.optional !== undefined) assert.equal(typeof matcher.optional, 'boolean', `${label}: optional`)
}

test('dependency inventory is complete, unique, and points only at real repository surfaces', () => {
  assert.equal(inventory.schemaVersion, 2)
  assert.equal(inventory.repository, 'jasondockery/renovate-config')
  assert.ok(Array.isArray(inventory.surfaces) && inventory.surfaces.length > 0)
  assert.equal(new Set(inventory.surfaces.map(({ id }) => id)).size, inventory.surfaces.length)
  assert.equal(inventory.surfaces.some(({ classification }) => classification === 'missing'), false)
  for (const surface of inventory.surfaces) {
    assert.match(surface.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    assert.ok(classifications.has(surface.classification), surface.id)
    assert.ok(surface.manager.length > 0 && surface.canonical.length > 0 && surface.note.length > 0, surface.id)
    assert.ok(agePolicies.has(surface.agePolicy), surface.id)
    assert.ok(surface.compensatingControl.length > 0, surface.id)
    if (surface.classification === 'built-in' || surface.classification === 'custom-manager') {
      assert.ok(Array.isArray(surface.extractionMatchers) && surface.extractionMatchers.length > 0, surface.id)
    }
    for (const [index, matcher] of (surface.scanMatchers ?? []).entries()) {
      assertScanMatcher(matcher, `${surface.id}.scanMatchers[${String(index)}]`)
    }
    assert.ok(Array.isArray(surface.paths) && surface.paths.length > 0, surface.id)
    for (const relativePath of surface.paths) {
      assert.equal(path.isAbsolute(relativePath), false, `${surface.id}: ${relativePath}`)
      assert.equal(relativePath.split('/').includes('..'), false, `${surface.id}: ${relativePath}`)
      assert.equal(fs.existsSync(path.join(repoRoot, relativePath)), true, `${surface.id}: ${relativePath}`)
    }
  }
  for (const [index, suppression] of (inventory.scanSuppressions ?? []).entries()) {
    assertScanMatcher(suppression, `scanSuppressions[${String(index)}]`, { suppression: true })
  }
})

test('the inventory covers every active extraction-manager family and truthful preset ownership', () => {
  const managers = new Set(inventory.surfaces.flatMap(({ extractionMatchers = [] }) =>
    extractionMatchers.map(({ manager }) => manager)
  ))
  for (const expected of ['npm', 'nodenv', 'github-actions', 'renovate-config', 'custom.regex']) {
    assert.equal(managers.has(expected), true, expected)
  }
  const sharedPreset = inventory.surfaces.find(({ id }) => id === 'shared-preset-reference')
  assert.equal(sharedPreset.classification, 'intentional-manual')
  assert.equal(sharedPreset.manager, 'versioned-distribution-owner-gate')
  const config = JSON.parse(fs.readFileSync(path.join(repoRoot, 'renovate.json'), 'utf8'))
  assert.deepEqual(config.ignorePaths, ['tools/fixtures/**'])
  assert.deepEqual(config.customManagers[0].managerFilePatterns, ['/^\\.renovate-version$/'])
  assert.equal(config.customManagers[0].datasourceTemplate, 'npm')
})
