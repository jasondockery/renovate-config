import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { extractionArguments } from './check-renovate-extraction.mjs'
import {
  assertExtractionNeutralPreset,
  assertSharedPresetExtractionNeutral,
  collectDeclaredDependencies,
  collectCoverageProblems,
  extractRepository,
  findSharedPresetReferences,
  scanVersionConventions,
  tupleMatches,
} from './check-renovate-repository-coverage.mjs'

const tuple = { manager: 'npm', packageFile: 'packages/app/package.json', depName: 'react', currentValue: '19.1.0' }
const matcher = { manager: 'npm', packageFilePattern: '^packages/.+/package\\.json$', depNamePattern: '^react$' }

test('extraction ownership binds manager, package file, and dependency name', () => {
  assert.equal(tupleMatches(tuple, matcher), true)
  assert.equal(tupleMatches({ ...tuple, manager: 'mise' }, matcher), false)
  assert.equal(tupleMatches({ ...tuple, depName: 'next' }, matcher), false)
})

test('coverage fails for unowned tuples, evidence-free automated rows, and scanner hits', () => {
  const inventory = {
    schemaVersion: 2,
    surfaces: [{
      id: 'npm',
      classification: 'built-in',
      extractionMatchers: [matcher],
      scanMatchers: [{ pathPattern: '^packages/app/version\\.ts$', pattern: 'version-assignment' }],
    }],
  }
  assert.deepEqual(collectCoverageProblems(inventory, [tuple], [{
    path: 'packages/app/version.ts', line: 1, pattern: 'version-assignment',
  }]), [])
  const problems = collectCoverageProblems(inventory, [{ ...tuple, depName: 'next' }], [{
    path: 'scripts/download.sh', line: 4, pattern: 'release-download',
  }])
  assert.match(problems.join('\n'), /extraction must have exactly one owner \(none\)/)
  assert.match(problems.join('\n'), /has no actual Renovate extraction evidence/)
  assert.match(problems.join('\n'), /release-download convention must have exactly one owner \(none\)/)
})

test('coverage rejects overlapping extraction and scanner ownership', () => {
  const inventory = {
    schemaVersion: 2,
    surfaces: ['first', 'second'].map((id) => ({
      id,
      classification: 'built-in',
      extractionMatchers: [matcher],
      scanMatchers: [{ pathPattern: '^packages/app/version\\.ts$', pattern: 'version-assignment' }],
    })),
  }
  const problems = collectCoverageProblems(inventory, [tuple], [{
    path: 'packages/app/version.ts', line: 1, pattern: 'version-assignment', text: "const runtimeVersion = '1.2.3'",
  }])
  assert.match(problems.join('\n'), /exactly one owner \(first, second\)/)
  assert.match(problems.join('\n'), /version-assignment convention must have exactly one owner \(first, second\)/)
})

test('file-aware discovery finds lowercase source, TOML, and plugin pins while excluding docs', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-discovery-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'scripts'))
  fs.mkdirSync(path.join(root, 'config'))
  fs.mkdirSync(path.join(root, 'docs'))
  fs.mkdirSync(path.join(root, 'tools', 'github'), { recursive: true })
  fs.writeFileSync(path.join(root, 'scripts', 'install.sh'), 'aider_python="3.12.4"\n')
  fs.writeFileSync(path.join(root, 'config', 'mise.toml'), '[tools]\nnode = "lts"\npython = ["3.13", "3.12"]\n')
  fs.writeFileSync(path.join(root, 'config', 'tmux.conf'), "set -g @plugin 'catppuccin/tmux#v2.3.0'\n")
  fs.writeFileSync(path.join(root, 'config', 'settings.json'), '{\n  // JSONC is accepted\n  "runtimeVersion": "1.2.3",\n}\n')
  fs.writeFileSync(path.join(root, 'docs', 'example.md'), 'aider_python="9.9.9"\n')
  fs.writeFileSync(path.join(root, 'tools', 'github', 'README.md'), "export const HIDDEN_VERSION = '8.8.8'\n")
  execFileSync('git', ['init', '-q', root])
  execFileSync('git', [
    '-C', root, 'add', 'scripts/install.sh', 'config/mise.toml', 'config/settings.json',
    'config/tmux.conf', 'docs/example.md', 'tools/github/README.md',
  ])
  const inventory = {
    schemaVersion: 2,
    surfaces: [
      {
        id: 'aider',
        classification: 'intentional-manual',
        scanMatchers: [{
          pathPattern: '^scripts/install\\.sh$',
          pattern: 'version-assignment',
          linePattern: 'aider_python=',
        }],
      },
      {
        id: 'mise',
        classification: 'intentional-manual',
        scanMatchers: [{ pathPattern: '^config/mise\\.toml$', pattern: 'version-assignment' }],
      },
      {
        id: 'tmux',
        classification: 'intentional-manual',
        scanMatchers: [{ pathPattern: '^config/tmux\\.conf$', pattern: 'plugin-reference' }],
      },
      {
        id: 'json',
        classification: 'derived',
        scanMatchers: [{ pathPattern: '^config/settings\\.json$', pattern: 'version-assignment' }],
      },
    ],
  }
  const hits = scanVersionConventions(root, inventory)
  assert.deepEqual(hits.map(({ path, pattern }) => ({ path, pattern })), [
    { path: 'config/mise.toml', pattern: 'version-assignment' },
    { path: 'config/mise.toml', pattern: 'version-assignment' },
    { path: 'config/settings.json', pattern: 'version-assignment' },
    { path: 'config/tmux.conf', pattern: 'plugin-reference' },
    { path: 'scripts/install.sh', pattern: 'version-assignment' },
  ])
  assert.deepEqual(collectCoverageProblems(inventory, [], hits), [])
  inventory.surfaces[0].scanMatchers.push({ pathPattern: '^scripts/missing\\.sh$', pattern: 'version-assignment' })
  assert.match(collectCoverageProblems(inventory, [], hits).join('\n'), /scan matcher has no discovery evidence/)
})

test('global discovery reports new source, JSON, and YAML versions without pre-existing matchers', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-discovery-unowned-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'new-tool.ts'), "export const NEW_TOOL_VERSION = '1.2.3'\n")
  fs.writeFileSync(path.join(root, 'settings.json'), '{\n  "NEW_JSON_TOOL_VERSION": "2.3.4"\n}\n')
  fs.writeFileSync(path.join(root, 'settings.yml'), 'NEW_YAML_TOOL_VERSION: 3.4.5\n')
  execFileSync('git', ['init', '-q', root])
  execFileSync('git', ['-C', root, 'add', 'src/new-tool.ts', 'settings.json', 'settings.yml'])

  const inventory = { schemaVersion: 2, surfaces: [] }
  const hits = scanVersionConventions(root, inventory)
  assert.deepEqual(hits.map(({ path: hitPath, pattern }) => ({ path: hitPath, pattern })), [
    { path: 'settings.json', pattern: 'version-assignment' },
    { path: 'settings.yml', pattern: 'version-assignment' },
    { path: 'src/new-tool.ts', pattern: 'version-assignment' },
  ])
  assert.match(collectCoverageProblems(inventory, [], hits).join('\n'), /exactly one owner \(none\)/)
})

test('scan suppressions are line-bound and exact-counted', () => {
  const hits = [
    { path: 'src/schema.ts', line: 1, pattern: 'version-assignment', text: "const SCHEMA_VERSION = '1.0.0'" },
    { path: 'src/schema.ts', line: 2, pattern: 'version-assignment', text: "const TOOL_VERSION = '2.0.0'" },
  ]
  const inventory = {
    schemaVersion: 2,
    surfaces: [],
    scanSuppressions: [{
      pathPattern: '^src/schema\\.ts$',
      pattern: 'version-assignment',
      linePattern: '^const SCHEMA_VERSION =',
      expectedMatches: 1,
      reason: 'Internal schema revision.',
    }],
  }
  const problems = collectCoverageProblems(inventory, [], hits)
  assert.equal(problems.some((problem) => /SCHEMA_VERSION/u.test(problem)), false)
  assert.match(problems.join('\n'), /src\/schema\.ts:2/)

  delete inventory.scanSuppressions[0].linePattern
  assert.match(collectCoverageProblems(inventory, [], hits).join('\n'), /must have linePattern/)
})

test('shared-preset ignores follow actual extends values and the preset stays extraction-neutral', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-preset-reference-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'renovate.json'), JSON.stringify({
    extends: ['github>jasondockery/renovate-config#1.0.7', 'config:recommended'],
  }))
  fs.writeFileSync(path.join(root, 'default.json'), JSON.stringify({ extends: ['config:best-practices'] }))
  assert.deepEqual(findSharedPresetReferences(root), ['github>jasondockery/renovate-config#1.0.7'])
  assert.doesNotThrow(() => assertSharedPresetExtractionNeutral(root))
  assert.doesNotThrow(() => assertExtractionNeutralPreset(JSON.parse(fs.readFileSync(
    path.join(path.resolve(import.meta.dirname, '..'), 'tools/fixtures/preset/default-five-day-policy.json'),
    'utf8'
  ))))
  for (const hostile of [
    { includePaths: ['src/**'] },
    { npm: { enabled: false } },
    { packageRules: [{ matchDatasources: ['npm'], enabled: false }] },
    { extends: ['local>unreviewed-preset'] },
  ]) {
    assert.throws(() => assertExtractionNeutralPreset(hostile), /not approved as extraction-neutral/)
  }
})

test('actual extraction injects the fully resolved shared preset while ignoring only its remote reference', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-resolved-preset-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'renovate.json'), JSON.stringify({
    extends: ['github>jasondockery/renovate-config#1.0.7'],
  }))
  const resolved = { extends: [], labels: ['dependencies'], npm: { enabled: true } }
  const tuples = extractRepository(root, resolved, { PATH: '/bin' }, (command, commandArguments, options) => {
    assert.equal(command, 'renovate')
    assert.deepEqual(commandArguments, extractionArguments())
    assert.deepEqual(JSON.parse(options.env.RENOVATE_IGNORE_PRESETS), [
      'github>jasondockery/renovate-config#1.0.7',
    ])
    assert.deepEqual(JSON.parse(fs.readFileSync(options.env.RENOVATE_CONFIG_FILE, 'utf8')), resolved)
    return {
      status: 0,
      stdout: JSON.stringify({
        msg: 'Extracted dependencies',
        packageFiles: {
          npm: [{ packageFile: 'package.json', deps: [{ depName: 'react', currentValue: '19.1.0' }] }],
        },
      }),
      stderr: '',
    }
  })
  assert.deepEqual(tuples, [{
    manager: 'npm',
    packageFile: 'package.json',
    depName: 'react',
    currentValue: '19.1.0',
    currentDigest: '',
  }])
})

test('independent declarations must each have a matching Renovate extraction tuple', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-declarations-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    packageManager: 'pnpm@11.9.0',
    engines: { node: '24.18.0' },
    dependencies: { react: '19.1.0' },
  }))
  fs.writeFileSync(
    path.join(root, 'pnpm-workspace.yaml'),
    "catalog:\n  react: 19.1.0\nonlyBuiltDependencies:\n  - esbuild\n"
  )
  fs.writeFileSync(path.join(root, '.node-version'), '24.18.0\n')
  fs.writeFileSync(path.join(root, 'Dockerfile'), 'FROM ubuntu:24.04@sha256:abc\n')
  fs.writeFileSync(
    path.join(root, '.github', 'workflows', 'ci.yml'),
    'jobs:\n  test:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/checkout@abc123\n'
  )
  execFileSync('git', ['init', '-q', root])
  execFileSync('git', ['-C', root, 'add', '.'])
  const inventory = {
    schemaVersion: 2,
    surfaces: [{
      id: 'all',
      classification: 'built-in',
      extractionMatchers: [
        { manager: 'npm', packageFilePattern: '^(?:package.json|pnpm-workspace\\.yaml)$', depNamePattern: '.+' },
        { manager: 'nodenv', packageFilePattern: '^\\.node-version$', depNamePattern: '^node$' },
        { manager: 'dockerfile', packageFilePattern: '^Dockerfile$', depNamePattern: '^ubuntu$' },
        { manager: 'github-actions', packageFilePattern: '^\\.github/workflows/', depNamePattern: '.+' },
      ],
    }],
  }
  const declarations = collectDeclaredDependencies(root, inventory)
  assert.ok(declarations.length >= 7)
  assert.match(collectCoverageProblems(inventory, [], [], declarations).join('\n'), /missed declared dependency/)
  const tuples = declarations.map((declaration) => ({ ...declaration, currentValue: declaration.currentValue ?? 'resolved', currentDigest: '' }))
  assert.deepEqual(collectCoverageProblems(inventory, tuples, [], declarations), [])
})

test('file-aware discovery rejects malformed JSON before making ownership claims', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-discovery-json-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'config.json'), '{"runtimeVersion": "1.2.3"')
  execFileSync('git', ['init', '-q', root])
  execFileSync('git', ['-C', root, 'add', 'config.json'])
  assert.throws(
    () => scanVersionConventions(root, { schemaVersion: 2, surfaces: [] }),
    /not structurally valid JSON\/JSONC/
  )
})
