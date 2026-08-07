import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  collectRuntimeParityProblems,
  collectPnpmOwnerProblems,
  collectToolchainProblems,
  collectUnclassifiedToolchainLiterals,
  PROBE_TIMEOUT_MS,
  probeInvocation,
} from './check-toolchain.mjs'

const SCRIPT = fileURLToPath(new URL('./check-toolchain.mjs', import.meta.url))
const FIXTURE_NODE_VERSION = '20.11.1'
const FIXTURE_PNPM_VERSION = '9.15.5'

test('rejects a former production version in an unregistered live surface', (context) => {
  const repoRoot = fixture({ 'README.md': 'Requires Node 20.10.0.\n' })
  context.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }))
  assert.match(collectUnclassifiedToolchainLiterals(repoRoot, 'README.md\0').join('\n'), /README\.md:1/)
})

function fixture(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-toolchain-'))
  const defaults = {
    '.node-version': `${FIXTURE_NODE_VERSION}\n`,
    '.nvmrc': `${FIXTURE_NODE_VERSION}\n`,
    'mise.toml': `[tools]\nnode = "${FIXTURE_NODE_VERSION}"\n`,
    'pnpm-workspace.yaml': 'verifyDepsBeforeRun: false\nenableModulesDir: false\n',
    'package.json': `${JSON.stringify({
      packageManager: `pnpm@${FIXTURE_PNPM_VERSION}`,
      engines: { node: FIXTURE_NODE_VERSION, pnpm: FIXTURE_PNPM_VERSION },
    }, null, 2)}\n`,
    '.github/workflows/ci.yml':
      'uses: actions/setup-node@0000000000000000000000000000000000000000\nwith:\n  node-version-file: .node-version\n',
    ...files,
  }
  for (const [relativePath, content] of Object.entries(defaults)) {
    const absolute = path.join(root, relativePath)
    fs.mkdirSync(path.dirname(absolute), { recursive: true })
    fs.writeFileSync(absolute, content)
  }
  return root
}

test('reports an unplannable mirror instead of discarding every diagnostic', (context) => {
  const repoRoot = fixture()
  context.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }))
  fs.rmSync(path.join(repoRoot, 'mise.toml'))
  const problems = collectToolchainProblems({
    repoRoot,
    nodeVersion: `v${FIXTURE_NODE_VERSION}`,
    userAgent: `pnpm/${FIXTURE_PNPM_VERSION}`,
  }).join('\n')
  assert.match(problems, /mise\.toml node \(missing\)/)
  assert.match(problems, /toolchain mirrors could not be planned/)
})

test('reads a [tools] header with a trailing comment exactly as the writer does', (context) => {
  const repoRoot = fixture({
    'mise.toml': `[tools] # pinned by policy\nnode = "${FIXTURE_NODE_VERSION}"\n`,
  })
  context.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }))
  // A stricter reader here would report a missing node key for a file the
  // writer already considers synchronized: a failure sync can never clear.
  assert.deepEqual(
    collectToolchainProblems({
      repoRoot,
      nodeVersion: `v${FIXTURE_NODE_VERSION}`,
      userAgent: `pnpm/${FIXTURE_PNPM_VERSION}`,
    }),
    []
  )
})

test('classifies literals from the filesystem when Git metadata is absent', (context) => {
  const repoRoot = fixture({ 'docs/install.md': 'Requires Node 20.10.0.\n' })
  context.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }))
  assert.match(collectUnclassifiedToolchainLiterals(repoRoot).join('\n'), /docs\/install\.md:1/)
})

test('accepts synchronized declarations and exact running versions', (context) => {
  const repoRoot = fixture()
  context.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }))
  assert.deepEqual(
    collectToolchainProblems({
      repoRoot,
      nodeVersion: `v${FIXTURE_NODE_VERSION}`,
      userAgent: `pnpm/${FIXTURE_PNPM_VERSION} npm/? node/v${FIXTURE_NODE_VERSION} darwin arm64`,
    }),
    []
  )
})

test('reports declaration, runtime, package-manager, and CI drift together', (context) => {
  const repoRoot = fixture({
    '.nvmrc': '24.17.0\n',
    'mise.toml': '[tools]\nnode = "24.17.0"\npnpm = "11.8.0"\n',
    '.github/workflows/ci.yml':
      'uses: actions/setup-node@0000000000000000000000000000000000000000\nwith:\n  node-version-file: .node-version\n---\nuses: actions/setup-node@0000000000000000000000000000000000000000\nwith:\n  node-version-file: .nvmrc\n',
  })
  context.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }))
  const problems = collectToolchainProblems({
    repoRoot,
    nodeVersion: 'v26.5.0',
    userAgent: 'pnpm/11.8.0 npm/? node/v26.5.0 darwin arm64',
  }).join('\n')
  assert.match(problems, /\.nvmrc \(24\.17\.0\)/)
  assert.match(problems, /mise\.toml must not declare pnpm/)
  assert.match(problems, /running Node 26\.5\.0/)
  assert.match(problems, /running pnpm 11\.8\.0/)
  assert.match(problems, /actions\/setup-node from the repository \.node-version/)
})

test('accepts a repository node pin below an explicit checkout path', (context) => {
  const repoRoot = fixture({
    '.github/workflows/ci.yml':
      'uses: actions/setup-node@0000000000000000000000000000000000000000\nwith:\n  node-version-file: renovate-config/.node-version\n',
  })
  context.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }))
  assert.deepEqual(
    collectToolchainProblems({
      repoRoot,
      nodeVersion: 'v20.11.1',
      userAgent: 'pnpm/9.15.5 npm/? node/v20.11.1 darwin arm64',
    }),
    []
  )
})

test('rejects pnpm script execution that can perform an implicit install', (context) => {
  const repoRoot = fixture({
    'pnpm-workspace.yaml': 'verifyDepsBeforeRun: install\nenableModulesDir: false\n',
  })
  context.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }))
  assert.match(
    collectToolchainProblems({
      repoRoot,
      nodeVersion: 'v20.11.1',
      userAgent: 'pnpm/9.15.5 npm/? node/v20.11.1 darwin arm64',
    }).join('\n'),
    /must disable verifyDepsBeforeRun/
  )
})

test('rejects dependency-free pnpm scripts that can write node_modules metadata', (context) => {
  const repoRoot = fixture({
    'pnpm-workspace.yaml': 'verifyDepsBeforeRun: false\nenableModulesDir: true\n',
  })
  context.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }))
  assert.match(
    collectToolchainProblems({
      repoRoot,
      nodeVersion: 'v20.11.1',
      userAgent: 'pnpm/9.15.5 npm/? node/v20.11.1 darwin arm64',
    }).join('\n'),
    /must disable enableModulesDir/
  )
})

function probeReturning(versions) {
  return (command) => {
    const answer = versions[command]
    if (answer === undefined) return { status: 1, stdout: '', stderr: 'not found' }
    return { status: 0, stdout: answer, stderr: '' }
  }
}

test('nested parity accepts child processes resolving the pinned node and pnpm', () => {
  const repoRoot = fixture()
  assert.deepEqual(
    collectRuntimeParityProblems({
      repoRoot,
      runProbe: probeReturning({ node: 'v20.11.1', pnpm: '9.15.5' }),
    }),
    []
  )
})

test('pnpm ownership accepts Corepack and rejects a standalone manager', () => {
  assert.deepEqual(collectPnpmOwnerProblems({ resolvePnpm: () => '/node/lib/node_modules/corepack/dist/pnpm.js' }), [])
  assert.match(collectPnpmOwnerProblems({ resolvePnpm: () => '/opt/homebrew/bin/pnpm' }).join('\n'), /known standalone manager/)
  assert.deepEqual(collectPnpmOwnerProblems({ resolvePnpm: () => '/custom/shim/pnpm' }), [])
})

test('nested parity strips the corepack integrity suffix before comparing', () => {
  const repoRoot = fixture({
    'package.json': JSON.stringify({
      packageManager: 'pnpm@9.15.5+sha512.abc123',
      engines: { node: '20.11.1', pnpm: '9.15.5' },
    }),
  })
  assert.deepEqual(
    collectRuntimeParityProblems({
      repoRoot,
      runProbe: probeReturning({ node: 'v20.11.1', pnpm: '9.15.5' }),
    }),
    []
  )
})

test('nested parity reports a drifted child pnpm while the invoker looks correct', () => {
  const repoRoot = fixture()
  const problems = collectRuntimeParityProblems({
    repoRoot,
    runProbe: probeReturning({ node: 'v20.11.1', pnpm: '9.12.0' }),
  })
  assert.match(problems.join('\n'), /bare `pnpm` resolves 9\.12\.0 for child processes/)
})

test('nested parity reports a drifted child node', () => {
  const repoRoot = fixture()
  const problems = collectRuntimeParityProblems({
    repoRoot,
    runProbe: probeReturning({ node: 'v22.4.0', pnpm: '9.15.5' }),
  })
  assert.match(problems.join('\n'), /bare `node` resolves 22\.4\.0 for child processes/)
})

test('nested parity reports a pnpm child processes cannot resolve', () => {
  const repoRoot = fixture()
  const problems = collectRuntimeParityProblems({
    repoRoot,
    runProbe: probeReturning({ node: 'v20.11.1' }),
  })
  assert.match(problems.join('\n'), /bare `pnpm` probe exited with status 1/)
})

test('nested parity distinguishes missing, offline Corepack, and timed-out pnpm probes', () => {
  const repoRoot = fixture()
  const run = (pnpmResult) =>
    collectRuntimeParityProblems({
      repoRoot,
      runProbe: (command) =>
        command === 'node'
          ? { status: 0, stdout: 'v20.11.1', stderr: '' }
          : pnpmResult,
    }).join('\n')
  assert.match(
    run({ status: 1, stdout: '', stderr: 'spawn pnpm ENOENT', errorCode: 'ENOENT' }),
    /bare `pnpm` is not available/
  )
  assert.match(
    run({
      status: 1,
      stdout: '',
      stderr: 'Corepack cannot download pnpm because network access is disabled',
    }),
    /not cached or installed.*intentionally disables Corepack networking/
  )
  assert.match(
    run({ status: 1, stdout: '', stderr: '', errorCode: 'ETIMEDOUT', timedOut: true }),
    new RegExp(`timed out after ${PROBE_TIMEOUT_MS / 1000} seconds`)
  )
})

test('node and pnpm probes share missing, timeout, signal, nonzero, and mismatch diagnostics', () => {
  const repoRoot = fixture()
  const run = (commandResult, command = 'node') =>
    collectRuntimeParityProblems({
      repoRoot,
      runProbe: (candidate) => {
        if (candidate === command) return commandResult
        return {
          status: 0,
          stdout: candidate === 'node' ? 'v20.11.1' : '9.15.5',
          stderr: '',
        }
      },
    }).join('\n')

  for (const command of ['node', 'pnpm']) {
    assert.match(
      run({ status: 1, stdout: '', stderr: 'ENOENT', errorCode: 'ENOENT' }, command),
      new RegExp(`bare \\\`${command}\\\` is not available`)
    )
    assert.match(
      run({ status: 1, stdout: '', stderr: '', timedOut: true }, command),
      new RegExp(`bare \\\`${command}\\\` probe timed out`)
    )
    assert.match(
      run({ status: 1, stdout: '', stderr: '', signal: 'SIGTERM' }, command),
      new RegExp(`bare \\\`${command}\\\` probe was terminated by signal SIGTERM`)
    )
    assert.match(
      run({ status: 7, stdout: '', stderr: 'bad launch' }, command),
      new RegExp(`bare \\\`${command}\\\` probe exited with status 7 \\(bad launch\\)`)
    )
    assert.match(
      run(
        {
          status: 0,
          stdout: command === 'node' ? 'v1.2.3' : '1.2.3',
          stderr: '',
        },
        command
      ),
      new RegExp(`bare \\\`${command}\\\` resolves 1\\.2\\.3`)
    )
  }
})

test('probes launch directly on posix and via the command interpreter on win32', () => {
  assert.deepEqual(probeInvocation('pnpm', ['--version'], 'linux'), {
    file: 'pnpm',
    args: ['--version'],
  })
  const win = probeInvocation('pnpm', ['--version'], 'win32')
  assert.deepEqual(win.args, ['/d', '/s', '/c', 'pnpm --version'])
})

test('nested parity probes run at repoRoot with Corepack networking disabled', () => {
  const repoRoot = fixture()
  const optionsSeen = []
  collectRuntimeParityProblems({
    repoRoot,
    runProbe: (command, args, options) => {
      optionsSeen.push(options)
      return { status: 0, stdout: command === 'node' ? 'v20.11.1' : '9.15.5', stderr: '' }
    },
  })
  assert.deepEqual(
    optionsSeen.map(({ cwd, env }) => ({ cwd, corepackNetwork: env.COREPACK_ENABLE_NETWORK })),
    [
      { cwd: repoRoot, corepackNetwork: '0' },
      { cwd: repoRoot, corepackNetwork: '0' },
    ]
  )
})

test('a PATH-shadowing pnpm is caught by the real default probe, launched from repoRoot', (t) => {
  if (process.platform === 'win32') return t.skip('posix shell fixture')
  const repoRoot = fixture()
  fs.writeFileSync(path.join(repoRoot, 'probe-marker.txt'), '9.9.9\n')
  const shadow = path.join(repoRoot, 'shadow bin')
  fs.mkdirSync(shadow)
  const fake = path.join(shadow, 'pnpm')
  fs.writeFileSync(fake, '#!/bin/sh\ncat probe-marker.txt 2>/dev/null || echo no-marker\n')
  fs.chmodSync(fake, 0o755)
  const originalPath = process.env.PATH
  process.env.PATH = `${shadow}${path.delimiter}${originalPath}`
  try {
    const problems = collectRuntimeParityProblems({ repoRoot })
    assert.match(problems.join('\n'), /bare `pnpm` resolves 9\.9\.9 for child processes/)
  } finally {
    process.env.PATH = originalPath
  }
})

test('the CLI entrypoint is realpath-aware and importing it stays silent', (t) => {
  if (process.platform === 'win32') return t.skip('symlink fixture')
  const repoRoot = fixture({ '.node-version': 'not-exact\n' })
  const links = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain links with spaces-'))
  t.after(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true })
    fs.rmSync(links, { recursive: true, force: true })
  })
  const link = path.join(links, 'check toolchain.mjs')
  fs.symlinkSync(SCRIPT, link)
  const invoked = spawnSync(process.execPath, [link], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  assert.equal(invoked.status, 1)
  assert.match(invoked.stderr, /\.node-version must contain one exact semantic version in x\.y\.z form/)

  const imported = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', `await import(${JSON.stringify(pathToFileURL(SCRIPT).href)})`],
    { encoding: 'utf8' }
  )
  assert.equal(imported.status, 0)
  assert.equal(imported.stdout, '')
  assert.equal(imported.stderr, '')

  const broken = path.join(links, 'broken.mjs')
  fs.symlinkSync(path.join(links, 'missing-target.mjs'), broken)
  const brokenResult = spawnSync(process.execPath, [broken], { encoding: 'utf8' })
  assert.notEqual(brokenResult.status, 0)
})
