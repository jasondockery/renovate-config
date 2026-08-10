import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import {
  compareRepositorySnapshots,
  runBoundedGit,
  snapshotRepository,
  summarizeRelevantIgnored,
} from './repository-readonly-identity.mjs'

test('bounded Git applies timeout, output, and kill semantics', () => {
  let observed
  const output = runBoundedGit('/fixture', ['status'], {
    runner(command, arguments_, options) {
      observed = { command, arguments_, options }
      return 'clean\n'
    },
  })
  assert.equal(output, 'clean\n')
  assert.equal(observed.command, 'git')
  assert.deepEqual(observed.arguments_, ['-C', '/fixture', 'status'])
  assert.equal(observed.options.timeout, 15_000)
  assert.equal(observed.options.maxBuffer, 8 * 1024 * 1024)
  assert.equal(observed.options.killSignal, 'SIGKILL')
})

function repository(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-readonly-identity-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q', root])
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Fixture'])
  execFileSync('git', ['-C', root, 'config', 'user.email', 'fixture@example.invalid'])
  fs.writeFileSync(path.join(root, '.gitignore'), 'ignored-output\n')
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'before\n')
  execFileSync('git', ['-C', root, 'add', '.gitignore', 'tracked.txt'])
  execFileSync('git', ['-C', root, 'commit', '-qm', 'fixture'])
  return root
}

test('binds exact SHA, complete status, tracked contents, and relevant ignored outputs', (context) => {
  const root = repository(context)
  const before = snapshotRepository(root, ['ignored-output'])
  const same = snapshotRepository(root, ['ignored-output'])
  assert.deepEqual(compareRepositorySnapshots('o/r', before, same), [])
  assert.match(before.trackedFingerprint, /^sha256:[0-9a-f]{64}$/u)
  assert.match(summarizeRelevantIgnored(before), /^sha256:[0-9a-f]{64}$/u)

  fs.writeFileSync(path.join(root, 'tracked.txt'), 'after\n')
  fs.mkdirSync(path.join(root, 'ignored-output'))
  fs.writeFileSync(path.join(root, 'ignored-output', 'generated.txt'), 'generated\n')
  const after = snapshotRepository(root, ['ignored-output'])
  assert.notEqual(summarizeRelevantIgnored(before), summarizeRelevantIgnored(after))
  assert.match(compareRepositorySnapshots('o/r', before, after).join('\n'), /ended dirty/)
  assert.match(compareRepositorySnapshots('o/r', before, after).join('\n'), /complete Git status changed/)
  assert.match(compareRepositorySnapshots('o/r', before, after).join('\n'), /tracked-file fingerprint changed/)
  assert.match(compareRepositorySnapshots('o/r', before, after).join('\n'), /relevant ignored outputs changed/)
})

// The refusal paths matter more than the happy path: this snapshot is what
// proves a compatibility run did not mutate a consumer checkout, so it must
// never quietly hash something outside the repository or a special file.
test('refuses a relevant ignored path that escapes the repository', (context) => {
  const root = repository(context)
  for (const escape of ['../outside', 'a/../../outside', '/etc/passwd']) {
    assert.throws(() => snapshotRepository(root, [escape]), /escapes repository/)
  }
})

test('refuses a special file and accepts a symlink as its target text', (context) => {
  const root = repository(context)
  execFileSync('mkfifo', [path.join(root, 'ignored-output')])
  assert.throws(() => snapshotRepository(root, ['ignored-output']), /does not accept special file/)

  fs.rmSync(path.join(root, 'ignored-output'))
  fs.symlinkSync('tracked.txt', path.join(root, 'ignored-output'))
  const linked = snapshotRepository(root, ['ignored-output'])
  assert.equal(linked.relevantIgnored['ignored-output'].exists, true)
  assert.match(linked.relevantIgnored['ignored-output'].fingerprint, /^sha256:[0-9a-f]{64}$/u)

  fs.rmSync(path.join(root, 'ignored-output'))
  fs.symlinkSync('other.txt', path.join(root, 'ignored-output'))
  const retargeted = snapshotRepository(root, ['ignored-output'])
  assert.notEqual(
    linked.relevantIgnored['ignored-output'].fingerprint,
    retargeted.relevantIgnored['ignored-output'].fingerprint
  )
})

test('an absent relevant ignored path is recorded as absent, not skipped', (context) => {
  const root = repository(context)
  const snapshot = snapshotRepository(root, ['ignored-output'])
  assert.deepEqual(snapshot.relevantIgnored['ignored-output'], { exists: false, fingerprint: null })
  assert.match(summarizeRelevantIgnored(snapshot), /^sha256:[0-9a-f]{64}$/u)

  fs.writeFileSync(path.join(root, 'ignored-output'), 'now here\n')
  assert.notEqual(
    summarizeRelevantIgnored(snapshot),
    summarizeRelevantIgnored(snapshotRepository(root, ['ignored-output']))
  )
})

test('a repository without a commit is refused rather than fingerprinted', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-readonly-identity-empty-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q', root])
  assert.throws(() => snapshotRepository(root, []))
})
