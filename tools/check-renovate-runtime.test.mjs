import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { collectRenovateRuntimeProblems } from './check-renovate-runtime.mjs'
import { readRenovateVersion } from './renovate-runtime.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RENOVATE_VERSION = readRenovateVersion(REPO_ROOT)
const RUNTIME_FIXTURES = [
  `tools/fixtures/renovate-${RENOVATE_VERSION}-structured-log.jsonl`,
  `tools/fixtures/renovate-${RENOVATE_VERSION}-structured-log.md`,
]
const CONTRACT_FILES = [
  '.renovate-version',
  '.github/workflows/ci.yml',
  '.github/workflows/renovate.yml',
  'tools/verify.mjs',
  'package.json',
  'renovate.json',
  'runner.json',
  ...RUNTIME_FIXTURES,
]

function fixture(context) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-runtime-'))
  context.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }))
  for (const relativePath of CONTRACT_FILES) {
    const source = path.join(REPO_ROOT, relativePath)
    const target = path.join(repoRoot, relativePath)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(source, target)
  }
  return repoRoot
}

function read(repoRoot, relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function write(repoRoot, relativePath, content) {
  fs.writeFileSync(path.join(repoRoot, relativePath), content)
}

function mutateJson(repoRoot, relativePath, mutate) {
  const value = JSON.parse(read(repoRoot, relativePath))
  mutate(value)
  write(repoRoot, relativePath, `${JSON.stringify(value, null, 2)}\n`)
}

function problems(repoRoot, extraFiles = []) {
  return collectRenovateRuntimeProblems(repoRoot, {
    candidateFiles: [...CONTRACT_FILES, ...extraFiles],
  }).join('\n')
}

test('accepts the repository runtime and formatter contracts', () => {
  assert.deepEqual(collectRenovateRuntimeProblems(REPO_ROOT), [])
})

test('rejects commented-out CI and runner steps even when decoy text remains', (context) => {
  const repoRoot = fixture(context)
  write(
    repoRoot,
    '.github/workflows/ci.yml',
    read(repoRoot, '.github/workflows/ci.yml').replace(
      '        run: pnpm validate',
      '        # run: pnpm validate'
    )
  )
  write(
    repoRoot,
    '.github/workflows/renovate.yml',
    read(repoRoot, '.github/workflows/renovate.yml').replace(
      '        run: echo "version=$(node tools/renovate-runtime.mjs --print-version)" >> "$GITHUB_OUTPUT"',
      '        # run: echo "version=$(node tools/renovate-runtime.mjs --print-version)" >> "$GITHUB_OUTPUT"'
    )
  )

  const result = problems(repoRoot)
  assert.match(result, /validation job must execute pnpm validate once/)
  assert.match(result, /resolve the runtime from \.renovate-version/)
})

test('rejects removal or widening of the Renovate structured-log environment allowlist', (context) => {
  const repoRoot = fixture(context)
  write(
    repoRoot,
    '.github/workflows/renovate.yml',
    read(repoRoot, '.github/workflows/renovate.yml').replace(
      "          env-regex: '^(?:RENOVATE_\\w+|LOG_(?:LEVEL|FILE|FILE_FORMAT|FILE_LEVEL)|GITHUB_COM_TOKEN|NODE_OPTIONS|NO_COLOR|(?:HTTPS?|NO)_PROXY|(?:https?|no)_proxy)$'",
      "          env-regex: '.*'"
    )
  )
  assert.match(problems(repoRoot), /exact structured-log environment allowlist/)
})

test('rejects a missing or displaced verification cleanliness check', async (context) => {
  await context.test('commented-out check', (subcontext) => {
    const repoRoot = fixture(subcontext)
    write(
      repoRoot,
      '.github/workflows/ci.yml',
      read(repoRoot, '.github/workflows/ci.yml').replace(
        '        run: node tools/check-verification-clean.mjs',
        '        # run: node tools/check-verification-clean.mjs'
      )
    )
    const result = problems(repoRoot)
    assert.match(result, /cleanliness immediately after pnpm test/)
    assert.match(result, /exactly two cleanliness checks/)
  })

  await context.test('check moved away from validation', (subcontext) => {
    const repoRoot = fixture(subcontext)
    write(
      repoRoot,
      '.github/workflows/ci.yml',
      read(repoRoot, '.github/workflows/ci.yml').replace(
        '      - name: Check validation is read-only',
        `      - name: Intervening step
        run: echo displaced

      - name: Check validation is read-only`
      )
    )
    assert.match(problems(repoRoot), /cleanliness immediately after pnpm validate/)
  })
})

test('rejects weakened workflow permissions, artifact retention, or local deadline bounds', async (context) => {
  await context.test('workflow permissions', (subcontext) => {
    const repoRoot = fixture(subcontext)
    write(repoRoot, '.github/workflows/ci.yml', read(repoRoot, '.github/workflows/ci.yml').replace(
      'permissions:\n  contents: read',
      'permissions:\n  contents: write'
    ))
    assert.match(problems(repoRoot), /default the workflow token to contents: read/)
  })
  await context.test('missing receipt accepted', (subcontext) => {
    const repoRoot = fixture(subcontext)
    write(repoRoot, '.github/workflows/renovate.yml', read(repoRoot, '.github/workflows/renovate.yml').replace(
      'if-no-files-found: error',
      'if-no-files-found: ignore'
    ))
    assert.match(problems(repoRoot), /receipt upload must fail/)
  })
  await context.test('local command mislabeled as full reproduction', (subcontext) => {
    const repoRoot = fixture(subcontext)
    write(repoRoot, '.github/workflows/ci.yml', read(repoRoot, '.github/workflows/ci.yml').replace(
      "--reproduce-label 'Local tests/validation equivalent'",
      "--reproduce-label 'Reproduce'"
    ))
    assert.match(problems(repoRoot), /local tests\/validation equivalent/)
  })
  await context.test('deadline removed', (subcontext) => {
    const repoRoot = fixture(subcontext)
    write(repoRoot, 'tools/verify.mjs', read(repoRoot, 'tools/verify.mjs').replace(
      'const HARD_DEADLINE_MILLISECONDS = 300_000',
      'const HARD_DEADLINE_MILLISECONDS = 0'
    ))
    assert.match(problems(repoRoot), /300-second total deadline/)
  })
})

test('rejects every formatter-permission broadening', async (context) => {
  await context.test('shell execution', (subcontext) => {
    const repoRoot = fixture(subcontext)
    mutateJson(repoRoot, 'runner.json', (runner) => {
      runner.allowShellExecutorForPostUpgradeCommands = true
    })
    assert.match(problems(repoRoot), /explicitly disable/)
  })
  await context.test('a second command', (subcontext) => {
    const repoRoot = fixture(subcontext)
    mutateJson(repoRoot, 'runner.json', (runner) => {
      runner.allowedCommands.push('^node other\\.mjs$')
    })
    assert.match(problems(repoRoot), /allowedCommands must contain only/)
  })
  await context.test('a broader regex', (subcontext) => {
    const repoRoot = fixture(subcontext)
    mutateJson(repoRoot, 'runner.json', (runner) => {
      runner.allowedCommands = ['^node tools/.*$']
    })
    assert.match(problems(repoRoot), /allowedCommands must contain only/)
  })
})

test('rejects broken canonical runtime manager fields', async (context) => {
  await context.test('match expression', (subcontext) => {
    const repoRoot = fixture(subcontext)
    mutateJson(repoRoot, 'renovate.json', (renovate) => {
      renovate.customManagers[0].matchStrings = ['version=(?<currentValue>.*)']
    })
    assert.match(problems(repoRoot), /exact canonical runtime custom manager/)
  })
  await context.test('datasource', (subcontext) => {
    const repoRoot = fixture(subcontext)
    mutateJson(repoRoot, 'renovate.json', (renovate) => {
      delete renovate.customManagers[0].datasourceTemplate
    })
    assert.match(problems(repoRoot), /exact canonical runtime custom manager/)
  })
})

test('rejects malformed versions, duplicate pins, and ambient global config', async (context) => {
  await context.test('prerelease version', (subcontext) => {
    const repoRoot = fixture(subcontext)
    write(repoRoot, '.renovate-version', '1.2.3-beta.1\n')
    assert.match(problems(repoRoot), /one exact version/)
  })
  await context.test('duplicate canonical value in a new file', (subcontext) => {
    const repoRoot = fixture(subcontext)
    write(repoRoot, 'new-runtime.txt', `${read(repoRoot, '.renovate-version')}`)
    assert.match(problems(repoRoot, ['new-runtime.txt']), /duplicates the canonical Renovate runtime/)
  })
  await context.test('runtime bump without an accepted matching log fixture', (subcontext) => {
    const repoRoot = fixture(subcontext)
    write(repoRoot, '.renovate-version', '43.272.7\n')
    assert.match(
      problems(repoRoot),
      /renovate-43\.272\.7-structured-log\.jsonl must preserve pinned-runtime structured-log provenance/
    )
  })
  await context.test('ambient config.js', (subcontext) => {
    const repoRoot = fixture(subcontext)
    write(repoRoot, 'config.js', 'module.exports = {}\n')
    assert.match(problems(repoRoot, ['config.js']), /ambient global Renovate configuration/)
  })
})
