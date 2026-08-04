#!/usr/bin/env node
// Enforce the preset bootstrap freeze while consumers are still unpinned.
//
// See .preset-bootstrap-freeze. When that marker is absent this check is a
// no-op, so lifting the freeze is a single deliberate deletion.
//
// Paths resolve from the module location, never the caller's cwd: the only
// dangerous direction for this gate is reporting "freeze lifted" because it
// was looking at the wrong directory.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { isMainModule } from './is-main.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MARKER = '.preset-bootstrap-freeze'
const PRESET = 'default.json'
const DIGEST = /^[0-9a-f]{64}$/

export function collectPresetFreezeProblems(root = repositoryRoot) {
  const marker = path.join(root, MARKER)
  if (!fs.existsSync(marker)) return { lifted: true, problems: [] }

  const expected = fs.readFileSync(marker, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .at(-1)

  if (expected === undefined || !DIGEST.test(expected)) {
    return { lifted: false, problems: [`${MARKER} does not contain a sha256 digest line`] }
  }

  let preset
  try {
    preset = fs.readFileSync(path.join(root, PRESET))
  } catch {
    return { lifted: false, problems: [`${PRESET} must be readable while the preset freeze is in effect`] }
  }

  const actual = createHash('sha256').update(preset).digest('hex')
  if (actual !== expected) {
    return {
      lifted: false,
      problems: [
        [
          `${PRESET} changed while the preset bootstrap freeze is in effect.`,
          `  expected: ${expected}`,
          `  actual:   ${actual}`,
          '',
          'Every consumer still resolves this repository\'s default branch, so this',
          'change would alter their dependency policy immediately and silently.',
          '',
          'Recovery:',
          '  - revert the default.json change, or',
          '  - finish the bootstrap in ROADMAP.md (tag, verify, pin all consumers),',
          `    then delete ${MARKER} and its CI step in the commit that lifts it.`,
        ].join('\n'),
      ],
    }
  }

  return { lifted: false, problems: [] }
}

export function checkPresetFreeze(root = repositoryRoot) {
  const { lifted, problems } = collectPresetFreezeProblems(root)
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem)
    return false
  }
  console.log(lifted ? `ok: no ${MARKER}; preset freeze is lifted` : `ok: ${PRESET} matches the frozen digest`)
  return true
}

if (isMainModule(import.meta.url) && !checkPresetFreeze()) process.exitCode = 1
