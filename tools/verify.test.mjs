import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import test from 'node:test'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  fingerprintRepository,
  renderVerificationReceipt,
  runCommandLane,
  runVerification,
  runVerificationWatchdog,
  validateReportPath,
  writeVerificationReport,
} from './verify.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const verifyTool = fileURLToPath(new URL('./verify.mjs', import.meta.url))
const verifyModuleUrl = new URL('./verify.mjs', import.meta.url).href
const processSupervisor = fileURLToPath(new URL('./process-supervisor.mjs', import.meta.url))

function registerSupervisorCleanup(context, supervisor) {
  context.after(() => {
    if (supervisor.exitCode !== null || supervisor.signalCode !== null) return
    try {
      process.kill(-supervisor.pid, 'SIGKILL')
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error
    }
  })
}

function waitForSupervisorExit(supervisor, label) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`timed out waiting for ${label} supervisor exit`)),
      1000
    )
    supervisor.once('exit', (exitCode, signalCode) => {
      clearTimeout(timeout)
      resolve({ exitCode, signalCode })
    })
  })
}

async function waitForProcessGroupGone(processGroup, label) {
  const deadline = Date.now() + 1000
  while (Date.now() < deadline) {
    const snapshot = spawnSync('ps', ['-eo', 'pgid=,stat='], {
      encoding: 'utf8',
      timeout: 1000,
      maxBuffer: 1024 * 1024,
    })
    assert.equal(snapshot.error, undefined, `${label} process snapshot failed`)
    assert.equal(snapshot.status, 0, `${label} process snapshot returned ${snapshot.status}`)
    const liveMember = snapshot.stdout.split('\n').some((line) => {
      const [groupText, state] = line.trim().split(/\s+/u)
      return Number(groupText) === processGroup && state && !state.startsWith('Z')
    })
    if (!liveMember) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail(`${label} process group survived owner-loss cleanup`)
}

function fixture(context) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-verify-'))
  context.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }))
  execFileSync('git', ['-C', repoRoot, 'init', '-q'])
  execFileSync('git', ['-C', repoRoot, 'config', 'user.email', 'test@example.com'])
  execFileSync('git', ['-C', repoRoot, 'config', 'user.name', 'Test'])
  fs.writeFileSync(path.join(repoRoot, 'package.json'), '{"packageManager":"pnpm@1.0.0"}\n')
  fs.writeFileSync(path.join(repoRoot, 'tracked.txt'), 'one\n')
  execFileSync('git', ['-C', repoRoot, 'add', '.'])
  execFileSync('git', ['-C', repoRoot, 'commit', '-qm', 'fixture'])
  return repoRoot
}

test('tree fingerprint splits exact Git-visible identity from bounded relevant ignored state', (context) => {
  const repoRoot = fixture(context)
  const initial = fingerprintRepository(repoRoot)
  fs.writeFileSync(path.join(repoRoot, 'tracked.txt'), 'two\n')
  assert.notEqual(fingerprintRepository(repoRoot).fingerprint, initial.fingerprint)
  execFileSync('git', ['-C', repoRoot, 'checkout', '--', 'tracked.txt'])
  fs.writeFileSync(path.join(repoRoot, 'tracked.txt'), 'staged\n')
  execFileSync('git', ['-C', repoRoot, 'add', 'tracked.txt'])
  assert.notEqual(fingerprintRepository(repoRoot).fingerprint, initial.fingerprint)
  execFileSync('git', ['-C', repoRoot, 'reset', '-q', 'HEAD', '--', 'tracked.txt'])
  execFileSync('git', ['-C', repoRoot, 'checkout', '--', 'tracked.txt'])
  fs.writeFileSync(path.join(repoRoot, 'untracked.txt'), 'new\n')
  const untracked = fingerprintRepository(repoRoot)
  assert.notEqual(untracked.fingerprint, initial.fingerprint)
  fs.unlinkSync(path.join(repoRoot, 'untracked.txt'))
  fs.symlinkSync('tracked.txt', path.join(repoRoot, 'link'))
  assert.notEqual(fingerprintRepository(repoRoot).fingerprint, initial.fingerprint)
  fs.unlinkSync(path.join(repoRoot, 'link'))
  fs.writeFileSync(
    path.join(repoRoot, '.gitignore'),
    '.ignored\nsecurity-hygiene-report.md\n'
  )
  execFileSync('git', ['-C', repoRoot, 'add', '.gitignore'])
  execFileSync('git', ['-C', repoRoot, 'commit', '-qm', 'ignore fixture'])
  const beforeIgnored = fingerprintRepository(repoRoot)
  fs.writeFileSync(path.join(repoRoot, '.ignored'), 'ignored output\n')
  assert.equal(fingerprintRepository(repoRoot).fingerprint, beforeIgnored.fingerprint)
  fs.writeFileSync(path.join(repoRoot, 'security-hygiene-report.md'), 'bounded output\n')
  const relevantIgnored = fingerprintRepository(repoRoot)
  assert.equal(relevantIgnored.gitVisibleFingerprint, beforeIgnored.gitVisibleFingerprint)
  assert.notEqual(relevantIgnored.ignoredState.fingerprint, beforeIgnored.ignoredState.fingerprint)
  assert.notEqual(relevantIgnored.fingerprint, beforeIgnored.fingerprint)
  assert.deepEqual(relevantIgnored.ignoredState.presentPaths, ['security-hygiene-report.md'])
  fs.unlinkSync(path.join(repoRoot, '.ignored'))
  fs.unlinkSync(path.join(repoRoot, 'security-hygiene-report.md'))
  const beforeDelete = fingerprintRepository(repoRoot)
  fs.unlinkSync(path.join(repoRoot, 'tracked.txt'))
  assert.notEqual(fingerprintRepository(repoRoot).fingerprint, beforeDelete.fingerprint)
  execFileSync('git', ['-C', repoRoot, 'checkout', '--', 'tracked.txt'])
  execFileSync('git', ['-C', repoRoot, 'commit', '--allow-empty', '-qm', 'new head'])
  assert.notEqual(fingerprintRepository(repoRoot).fingerprint, initial.fingerprint)
})

test('fingerprint input is chunked, bounded, and requires a resolved HEAD', (context) => {
  const repoRoot = fixture(context)
  fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'security-hygiene-report.md\n')
  execFileSync('git', ['-C', repoRoot, 'add', '.gitignore'])
  execFileSync('git', ['-C', repoRoot, 'commit', '-qm', 'ignore fixture'])
  fs.writeFileSync(
    path.join(repoRoot, 'security-hygiene-report.md'),
    Buffer.alloc(2 * 1024 * 1024, 1)
  )
  const chunked = fingerprintRepository(repoRoot, { ignoredContentByteLimit: 3 * 1024 * 1024 })
  assert.equal(chunked.ignoredState.input.contentBytes, 2 * 1024 * 1024)
  assert.throws(
    () => fingerprintRepository(repoRoot, { ignoredContentByteLimit: 1024 * 1024 }),
    /ignored state exceeded the 1048576-byte content budget/
  )
  fs.unlinkSync(path.join(repoRoot, 'security-hygiene-report.md'))
  fs.writeFileSync(path.join(repoRoot, 'untracked.txt'), 'one\n')
  fs.writeFileSync(path.join(repoRoot, 'second-untracked.txt'), 'two\n')
  assert.throws(
    () => fingerprintRepository(repoRoot, { pathLimit: 0 }),
    /positive safe integers/
  )
  assert.throws(
    () => fingerprintRepository(repoRoot, { pathLimit: 1 }),
    /1-path fingerprint budget/
  )
  assert.throws(
    () => fingerprintRepository(repoRoot, { gitOutputByteLimit: 1 }),
    /Git fingerprint output exceeded/
  )

  const unborn = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-verify-unborn-'))
  context.after(() => fs.rmSync(unborn, { recursive: true, force: true }))
  execFileSync('git', ['-C', unborn, 'init', '-q'])
  assert.throws(() => fingerprintRepository(unborn), /Git rev-parse.*failed/)
})

test('modified implementation trees pass when staged, unstaged, and untracked state is unchanged', async (context) => {
  const repoRoot = fixture(context)
  fs.writeFileSync(path.join(repoRoot, 'tracked.txt'), 'staged\n')
  execFileSync('git', ['-C', repoRoot, 'add', 'tracked.txt'])
  fs.writeFileSync(path.join(repoRoot, 'tracked.txt'), 'unstaged after staged\n')
  fs.writeFileSync(path.join(repoRoot, 'untracked.txt'), 'implementation\n')
  const before = fingerprintRepository(repoRoot)
  const receipt = await runVerification({
    repoRoot,
    runLane: async ({ name }) => ({
      name,
      command: `pnpm run ${name}`,
      exitCode: 0,
      durationMilliseconds: 1,
      closureConfirmed: true,
    }),
    write: () => {},
  })
  assert.equal(receipt.result, 'passed')
  assert.equal(receipt.tree.before.fingerprint, before.fingerprint)
  assert.equal(receipt.tree.matches, true)
})

test('forbidden dependency artifacts are rejected before launch and detected when newly created', async (context) => {
  const preexisting = fixture(context)
  fs.mkdirSync(path.join(preexisting, 'node_modules'))
  let starts = 0
  await assert.rejects(
    runVerification({
      repoRoot: preexisting,
      runLane: async () => { starts += 1 },
      write: () => {},
    }),
    /prerequisite failed before launch.*node_modules/
  )
  assert.equal(starts, 0)

  for (const artifact of ['pnpm-lock.yaml', '.pnpm-store']) {
    const repoRoot = fixture(context)
    let created = false
    const receipt = await runVerification({
      repoRoot,
      runLane: async ({ name }) => {
        if (!created) {
          created = true
          if (artifact.endsWith('.yaml')) fs.writeFileSync(path.join(repoRoot, artifact), 'lockfileVersion: 9\n')
          else fs.mkdirSync(path.join(repoRoot, artifact))
        }
        return {
          name,
          command: `pnpm run ${name}`,
          exitCode: 0,
          durationMilliseconds: 1,
          closureConfirmed: true,
        }
      },
      write: () => {},
    })
    assert.equal(receipt.result, 'failed', artifact)
    assert.match(receipt.readOnly.problems.join('\n'), new RegExp(artifact.replace('.', '\\.')))
  }
})

test('relevant ignored output, deletion, and concurrent source edits invalidate the baseline', async (context) => {
  for (const mutation of ['ignored', 'deleted', 'edited']) {
    const repoRoot = fixture(context)
    fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'security-hygiene-report.md\n')
    execFileSync('git', ['-C', repoRoot, 'add', '.gitignore'])
    execFileSync('git', ['-C', repoRoot, 'commit', '-qm', 'ignore fixture'])
    fs.writeFileSync(path.join(repoRoot, 'security-hygiene-report.md'), 'before\n')
    let mutated = false
    const receipt = await runVerification({
      repoRoot,
      runLane: async ({ name }) => {
        if (!mutated) {
          mutated = true
          if (mutation === 'ignored') {
            fs.writeFileSync(path.join(repoRoot, 'security-hygiene-report.md'), 'after\n')
          }
          if (mutation === 'deleted') fs.unlinkSync(path.join(repoRoot, 'tracked.txt'))
          if (mutation === 'edited') fs.writeFileSync(path.join(repoRoot, 'tracked.txt'), 'concurrent edit\n')
        }
        return {
          name,
          command: `pnpm run ${name}`,
          exitCode: 0,
          durationMilliseconds: 1,
          closureConfirmed: true,
        }
      },
      write: () => {},
    })
    assert.equal(receipt.result, 'failed', mutation)
    assert.equal(receipt.tree.matches, false, mutation)
  }
})

test('final verification starts complementary lanes concurrently and reports critical path', async () => {
  const started = []
  const resolvers = new Map()
  let clock = 0
  let output = ''
  const run = runVerification({
    repoRoot: repositoryRoot,
    fingerprint: () => ({ head: 'a'.repeat(40), fingerprint: 'sha256:same' }),
    artifactCheck: () => [],
    now: () => clock,
    runLane: ({ name }) => {
      started.push(name)
      return new Promise((resolve) => resolvers.set(name, resolve))
    },
    write: (value) => { output += value },
  })

  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(started, ['tests', 'validate'])
  clock = 2000
  resolvers.get('tests')({ name: 'tests', command: 'pnpm run test', exitCode: 0, durationMilliseconds: 2000 })
  clock = 4000
  resolvers.get('validate')({ name: 'validate', command: 'pnpm run validate', exitCode: 0, durationMilliseconds: 4000 })
  const receipt = await run

  assert.equal(receipt.result, 'passed')
  assert.equal(receipt.timings.wallMilliseconds, 4000)
  assert.equal(receipt.timings.criticalPathMilliseconds, 4000)
  assert.equal(receipt.timings.aggregateComputeMilliseconds, 6000)
  assert.equal(receipt.performance.budgetSeconds, 240)
  assert.equal(receipt.performance.state, 'within')
  assert.match(output, /Verification receipt · passed/)
})

test('verify rejects unknown arguments before starting either lane', () => {
  for (const arguments_ of [['--unexpected'], ['--', '--unexpected']]) {
    const result = spawnSync(process.execPath, [verifyTool, ...arguments_], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    })
    assert.equal(result.status, 64)
    assert.match(result.stderr, /unexpected argument/)
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /\[tests\]|\[validate\]/)
  }
})

test('verify accepts pnpm argument separation before report validation', () => {
  const result = spawnSync(process.execPath, [verifyTool, '--', '--report', 'relative.json'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })
  assert.equal(result.status, 64)
  assert.match(result.stderr, /absolute path/)
  assert.doesNotMatch(result.stderr, /unexpected argument/)
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /\[tests\]|\[validate\]/)
})

test('local JSON reports must be outside the repository and are written atomically', (context) => {
  assert.throws(() => validateReportPath('relative.json'), /absolute path/)
  assert.throws(() => validateReportPath(path.join(repositoryRoot, 'verify.json')), /outside/)
  const symlinkDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-verify-symlink-'))
  context.after(() => fs.rmSync(symlinkDirectory, { recursive: true, force: true }))
  const fakeRepository = path.join(symlinkDirectory, 'repository')
  const outsideSymlink = path.join(symlinkDirectory, 'outside-link')
  fs.mkdirSync(fakeRepository)
  fs.symlinkSync(fakeRepository, outsideSymlink, 'dir')
  assert.throws(
    () => validateReportPath(path.join(outsideSymlink, 'receipt.json'), fakeRepository),
    /outside the tested repository/
  )
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-verify-report-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const output = path.join(directory, 'receipt.json')
  assert.equal(validateReportPath(output), path.join(fs.realpathSync(directory), 'receipt.json'))
  writeVerificationReport(output, { schema: 'fixture', result: 'passed' })
  assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), {
    schema: 'fixture',
    result: 'passed',
  })
  assert.deepEqual(fs.readdirSync(directory), ['receipt.json'])
})

test('external watchdog bounds a synchronously blocked verification core and writes failure evidence', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-verify-watchdog-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const blocked = path.join(directory, 'blocked.mjs')
  const report = path.join(directory, 'receipt.json')
  fs.writeFileSync(blocked, 'while (true) {}\n')
  fs.writeFileSync(report, '{"result":"stale"}\n')
  const started = Date.now()
  const status = await runVerificationWatchdog({
    command: process.execPath,
    arguments_: [blocked],
    cwd: directory,
    report,
    deadlineMilliseconds: 50,
    cancelGraceMilliseconds: 50,
    write: () => {},
    writeError: () => {},
  })
  assert.equal(status, 124)
  assert.ok(Date.now() - started < 1000)
  const receipt = JSON.parse(fs.readFileSync(report, 'utf8'))
  assert.equal(receipt.result, 'failed')
  assert.equal(receipt.termination.timedOut, true)
  assert.equal(receipt.termination.closureConfirmed, true)
  assert.equal(receipt.termination.hardDeadlineSeconds, 0.05)
  assert.equal(receipt.termination.cancelGraceSeconds, 0.05)
  assert.equal(receipt.tree.observation, 'unavailable')
})

test('external watchdog disconnects a completed verification core', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-verify-complete-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const completed = path.join(directory, 'completed.mjs')
  fs.writeFileSync(
    completed,
    `import { completeVerificationCore } from ${JSON.stringify(verifyModuleUrl)}\n` +
      'await completeVerificationCore()\n'
  )
  const started = Date.now()
  const status = await runVerificationWatchdog({
    command: process.execPath,
    arguments_: [completed],
    cwd: directory,
    deadlineMilliseconds: 500,
    cancelGraceMilliseconds: 50,
    write: () => {},
    writeError: () => {},
  })
  assert.equal(status, 0)
  assert.ok(Date.now() - started < 500, 'completed core remained attached until its deadline')
})

test('lane failure, read-only failure, or a changed tree fails the aggregate receipt', async () => {
  let fingerprints = 0
  let artifactChecks = 0
  const receipt = await runVerification({
    repoRoot: repositoryRoot,
    fingerprint: () => ({
      head: 'a'.repeat(40),
      fingerprint: `sha256:${fingerprints++}`,
    }),
    runLane: async ({ name }) => ({
      name,
      command: `pnpm run ${name}`,
      exitCode: name === 'tests' ? 1 : 0,
      durationMilliseconds: 10,
    }),
    artifactCheck: () => artifactChecks++ === 0 ? [] : ['fixture changed'],
    now: () => 0,
    write: () => {},
  })

  assert.equal(receipt.result, 'failed')
  assert.equal(receipt.tree.matches, false)
  assert.equal(receipt.readOnly.result, 'failed')
  assert.equal(receipt.lanes[0].result, 'failed')
})

test('a failed final fingerprint emits an honest failed receipt', async () => {
  let calls = 0
  const receipt = await runVerification({
    repoRoot: repositoryRoot,
    fingerprint: () => {
      calls += 1
      if (calls === 2) throw new Error('final identity unavailable')
      return { head: 'a'.repeat(40), fingerprint: 'sha256:before' }
    },
    artifactCheck: () => [],
    runLane: async ({ name }) => ({
      name,
      command: `pnpm run ${name}`,
      exitCode: 0,
      durationMilliseconds: 1,
      closureConfirmed: true,
    }),
    write: () => {},
  })
  assert.equal(receipt.result, 'failed')
  assert.equal(receipt.tree.after, null)
  assert.equal(receipt.tree.matches, null)
  assert.equal(receipt.tree.observation, 'unavailable')
  assert.match(receipt.tree.error, /final identity unavailable/)
})

test('the hard deadline cancels both lanes and emits a failed timeout receipt', async () => {
  const receipt = await runVerification({
    repoRoot: repositoryRoot,
    fingerprint: () => ({ head: 'a'.repeat(40), fingerprint: 'sha256:same' }),
    artifactCheck: () => [],
    deadlineMilliseconds: 10,
    runLane: ({ name, signal }) => new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({
        name,
        command: `pnpm run ${name}`,
        exitCode: 124,
        durationMilliseconds: 10,
        timedOut: true,
        closureConfirmed: true,
      }), { once: true })
    }),
    write: () => {},
  })
  assert.equal(receipt.result, 'failed')
  assert.equal(receipt.termination.timedOut, true)
  assert.equal(receipt.termination.closureConfirmed, true)
  assert.equal(receipt.lanes.every(({ result }) => result === 'timed-out'), true)
})

test('a real lane escalates from TERM to KILL and confirms descendant closure', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-lane-timeout-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ready = path.join(directory, 'ready')
  const hostile = path.join(directory, 'hostile.sh')
  fs.writeFileSync(hostile, `#!/usr/bin/env bash
trap '' TERM
(trap '' TERM; while :; do sleep 1; done) &
printf '%s\n' "$RENOVATE_CONFIG_VERIFICATION_SUPERVISOR" >"$1"
wait
`)
  fs.chmodSync(hostile, 0o755)
  const controller = new AbortController()
  const lane = runCommandLane({
    name: 'hostile',
    command: hostile,
    arguments_: [ready],
    cwd: directory,
    signal: controller.signal,
    cancelGraceMilliseconds: 50,
    write: () => {},
    writeError: () => {},
  })
  const launchDeadline = Date.now() + 5000
  while (!fs.existsSync(ready) && Date.now() < launchDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  if (!fs.existsSync(ready)) {
    controller.abort({ type: 'timeout' })
    await lane
    assert.fail('hostile lane did not reach its ready marker')
  }
  const processGroup = Number(fs.readFileSync(ready, 'utf8').trim())
  controller.abort({ type: 'timeout' })
  const result = await lane
  assert.equal(result.exitCode, 124)
  assert.equal(result.timedOut, true)
  assert.equal(result.closureConfirmed, true)
  await waitForProcessGroupGone(processGroup, 'timeout lane')
})

test('supervisor owner loss kills a TERM-ignoring command and grandchild group', async (context) => {
  if (process.platform === 'win32') return
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-supervisor-disconnect-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ready = path.join(directory, 'ready')
  const hostile = path.join(directory, 'hostile.sh')
  fs.writeFileSync(hostile, `#!/usr/bin/env bash
trap '' TERM
(trap '' TERM; while :; do sleep 1; done) &
printf '%s\n' "$RENOVATE_CONFIG_VERIFICATION_SUPERVISOR" >"$1"
wait
`)
  fs.chmodSync(hostile, 0o755)
  const supervisor = spawn(process.execPath, [processSupervisor, '--', hostile, ready], {
    cwd: directory,
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  registerSupervisorCleanup(context, supervisor)
  const launchDeadline = Date.now() + 1000
  while (!fs.existsSync(ready) && Date.now() < launchDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(fs.existsSync(ready), true, 'hostile process did not reach its ready marker')
  const group = Number(fs.readFileSync(ready, 'utf8').trim())
  const exited = waitForSupervisorExit(supervisor, 'running-command owner-loss')
  supervisor.disconnect()
  await exited
  await waitForProcessGroupGone(group, 'running-command owner-loss')
})

test('supervisor owner loss kills an orphan after the direct command exits', async (context) => {
  if (process.platform === 'win32') return
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-supervisor-orphan-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const ready = path.join(directory, 'ready')
  const leaker = path.join(directory, 'leaker.mjs')
  fs.writeFileSync(leaker, `import fs from 'node:fs'
import { spawn } from 'node:child_process'

const orphan = spawn('/bin/bash', ['-c', "trap '' TERM; while :; do sleep 1; done"], {
  stdio: 'ignore',
})
orphan.unref()
fs.writeFileSync(process.argv[2], \`\${process.env.RENOVATE_CONFIG_VERIFICATION_SUPERVISOR}\\n\`)
`)
  const supervisor = spawn(process.execPath, [processSupervisor, '--', process.execPath, leaker, ready], {
    cwd: directory,
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  registerSupervisorCleanup(context, supervisor)
  const commandStatus = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('timed out waiting for supervisor status')),
      1000
    )
    supervisor.on('message', (message) => {
      if (message?.type !== 'command-status') return
      clearTimeout(timeout)
      resolve(message)
    })
  })
  const launchDeadline = Date.now() + 1000
  while (!fs.existsSync(ready) && Date.now() < launchDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(fs.existsSync(ready), true, 'orphan fixture did not reach its ready marker')
  assert.equal((await commandStatus).exitCode, 0, 'direct command did not exit successfully')
  const group = Number(fs.readFileSync(ready, 'utf8').trim())
  const exited = waitForSupervisorExit(supervisor, 'exited-command owner-loss')
  supervisor.disconnect()
  await exited
  await waitForProcessGroupGone(group, 'exited-command owner-loss')
})

test('a successful lane that leaks a descendant fails after bounded cleanup', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-lane-leak-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const groupFile = path.join(directory, 'group')
  const leaker = path.join(directory, 'leaker.sh')
  fs.writeFileSync(leaker, `#!/usr/bin/env bash
(trap '' TERM; while :; do sleep 1; done) &
printf '%s\n' "$RENOVATE_CONFIG_VERIFICATION_SUPERVISOR" >"$1"
exit 0
`)
  fs.chmodSync(leaker, 0o755)
  const result = await runCommandLane({
    name: 'leaker',
    command: leaker,
    arguments_: [groupFile],
    cwd: directory,
    cancelGraceMilliseconds: 50,
    write: () => {},
    writeError: () => {},
  })
  const processGroup = Number(fs.readFileSync(groupFile, 'utf8').trim())
  assert.equal(result.exitCode, 70)
  assert.equal(result.closureConfirmed, true)
  assert.match(result.error, /surviving process-group member/)
  await waitForProcessGroupGone(processGroup, 'leaking lane cleanup')
})

test('a supervisor that refuses release is killed and cannot report a passing lane', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-lane-release-refusal-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const hostileSupervisor = path.join(directory, 'hostile-supervisor.mjs')
  fs.writeFileSync(hostileSupervisor, `
for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) process.on(signal, () => {})
process.on('message', () => {})
process.send({ type: 'command-status', exitCode: 0, signal: null })
setInterval(() => {}, 1000)
`)
  const result = await runCommandLane({
    name: 'release-refusal',
    command: process.execPath,
    arguments_: ['-e', 'process.exit(0)'],
    cwd: directory,
    cancelGraceMilliseconds: 25,
    supervisor: hostileSupervisor,
    write: () => {},
    writeError: () => {},
  })
  assert.equal(result.exitCode, 70)
  assert.equal(result.closureConfirmed, true)
  assert.match(result.error, /supervisor release failed/)
})

test('lane output buffering is bounded for an unterminated line', async () => {
  let output = ''
  const result = await runCommandLane({
    name: 'long-line',
    command: process.execPath,
    arguments_: ['-e', 'process.stdout.write("x".repeat(2 * 1024 * 1024))'],
    cwd: repositoryRoot,
    write: (value) => { output += value },
    writeError: () => {},
  })
  assert.equal(result.exitCode, 0)
  assert.match(output, /unterminated output exceeded 1048576 bytes/)
  assert.ok(output.length < 1_100_000)
})

test('cancellation during initial fingerprinting prevents both lanes from starting', async () => {
  const controller = new AbortController()
  let starts = 0
  let fingerprints = 0
  const receipt = await runVerification({
    repoRoot: repositoryRoot,
    controller,
    fingerprint: () => {
      fingerprints += 1
      if (fingerprints === 1) controller.abort({ type: 'signal', signal: 'SIGTERM' })
      return { head: 'a'.repeat(40), fingerprint: 'sha256:same' }
    },
    artifactCheck: () => [],
    runLane: async () => { starts += 1 },
    write: () => {},
  })
  assert.equal(starts, 0)
  assert.equal(receipt.result, 'cancelled')
  assert.equal(receipt.lanes.every(({ notStarted }) => notStarted), true)
})

test('receipt rendering distinguishes wall time from aggregate compute time', () => {
  const summary = renderVerificationReceipt({
    result: 'passed',
    lanes: [
      { name: 'tests', result: 'passed', durationMilliseconds: 1000 },
      { name: 'validate', result: 'passed', durationMilliseconds: 3000 },
    ],
    readOnly: { result: 'passed', problems: [] },
    tree: { matches: true, after: { fingerprint: 'sha256:fixture' } },
    termination: { timedOut: false, closureConfirmed: true },
    timings: {
      wallMilliseconds: 3100,
      criticalPathMilliseconds: 3000,
      aggregateComputeMilliseconds: 4000,
    },
    performance: { budgetSeconds: 240, state: 'within', enforcement: 'advisory' },
  })
  assert.match(summary, /wall\s+3\.1s/)
  assert.match(summary, /critical\s+3\.0s/)
  assert.match(summary, /compute\s+4\.0s/)
  assert.match(summary, /identity\s+sha256:fixture/)
})
