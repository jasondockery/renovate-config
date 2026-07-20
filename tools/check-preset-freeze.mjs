#!/usr/bin/env node
// Enforce the preset bootstrap freeze while consumers are still unpinned.
//
// See .preset-bootstrap-freeze. When that marker is absent this check is a
// no-op, so lifting the freeze is a single deliberate deletion.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'

const MARKER = '.preset-bootstrap-freeze'
const PRESET = 'default.json'

if (!existsSync(MARKER)) {
  console.log(`ok: no ${MARKER}; preset freeze is lifted`)
  process.exit(0)
}

const expected = readFileSync(MARKER, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith('#'))
  .at(-1)

if (expected === undefined || !/^[0-9a-f]{64}$/.test(expected)) {
  console.error(`${MARKER} does not contain a sha256 digest line`)
  process.exit(1)
}

const actual = createHash('sha256').update(readFileSync(PRESET)).digest('hex')
if (actual !== expected) {
  console.error(
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
    ].join('\n')
  )
  process.exit(1)
}
console.log(`ok: ${PRESET} matches the frozen digest`)
