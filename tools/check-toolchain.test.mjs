import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  collectRuntimeParityProblems,
  collectToolchainProblems,
  PROBE_TIMEOUT_MS,
  probeInvocation,
} from './check-toolchain.mjs'

const SCRIPT = fileURLToPath(new URL('./check-toolchain.mjs', import.meta.url))

function fixture(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-toolchain-'))
  const defaults = {
    '.node-version': '24.18.0\n',
    '.nvmrc': '24.18.0\n',
    'mise.toml': '[tools]\nnode = "24.18.0"\npnpm = "11.9.0"\n',
    'pnpm-workspace.yaml': 'verifyDepsBeforeRun: false\nenableModulesDir: false\n',
    'package.json': JSON.stringify({
      packageManager: 'pnpm@11.9.0',
      engines: { node: '24.18.0', pnpm: '11.9.0' },
    }),
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

test('accepts synchronized declarations and exact running versions', (context) => {
  const repoRoot = fixture()
  context.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }))
  assert.deepEqual(
    collectToolchainProblems({
      repoRoot,
      nodeVersion: 'v24.18.0',
      userAgent: 'pnpm/11.9.0 npm/? node/v24.18.0 darwin arm64',
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
  assert.match(problems, /mise\.toml pnpm \(11\.8\.0\)/)
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
      nodeVersion: 'v24.18.0',
      userAgent: 'pnpm/11.9.0 npm/? node/v24.18.0 darwin arm64',
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
      nodeVersion: 'v24.18.0',
      userAgent: 'pnpm/11.9.0 npm/? node/v24.18.0 darwin arm64',
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
      nodeVersion: 'v24.18.0',
      userAgent: 'pnpm/11.9.0 npm/? node/v24.18.0 darwin arm64',
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
      runProbe: probeReturning({ node: 'v24.18.0', pnpm: '11.9.0' }),
    }),
    []
  )
})

test('nested parity strips the corepack integrity suffix before comparing', () => {
  const repoRoot = fixture({
    'package.json': JSON.stringify({
      packageManager: 'pnpm@11.9.0+sha512.abc123',
      engines: { node: '24.18.0', pnpm: '11.9.0' },
    }),
  })
  assert.deepEqual(
    collectRuntimeParityProblems({
      repoRoot,
      runProbe: probeReturning({ node: 'v24.18.0', pnpm: '11.9.0' }),
    }),
    []
  )
})

test('nested parity reports a drifted child pnpm while the invoker looks correct', () => {
  const repoRoot = fixture()
  const problems = collectRuntimeParityProblems({
    repoRoot,
    runProbe: probeReturning({ node: 'v24.18.0', pnpm: '9.12.0' }),
  })
  assert.match(problems.join('\n'), /bare `pnpm` resolves 9\.12\.0 for child processes/)
})

test('nested parity reports a drifted child node', () => {
  const repoRoot = fixture()
  const problems = collectRuntimeParityProblems({
    repoRoot,
    runProbe: probeReturning({ node: 'v22.4.0', pnpm: '11.9.0' }),
  })
  assert.match(problems.join('\n'), /bare `node` resolves 22\.4\.0 for child processes/)
})

test('nested parity reports a pnpm child processes cannot resolve', () => {
  const repoRoot = fixture()
  const problems = collectRuntimeParityProblems({
    repoRoot,
    runProbe: probeReturning({ node: 'v24.18.0' }),
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
          ? { status: 0, stdout: 'v24.18.0', stderr: '' }
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
          stdout: candidate === 'node' ? 'v24.18.0' : '11.9.0',
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
      return { status: 0, stdout: command === 'node' ? 'v24.18.0' : '11.9.0', stderr: '' }
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
  assert.match(invoked.stderr, /\.node-version must contain one exact Node version/)

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
