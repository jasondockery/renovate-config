import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import {
  compareRepositorySnapshots,
  snapshotRepository,
  summarizeRelevantIgnored,
} from './repository-readonly-identity.mjs'

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
