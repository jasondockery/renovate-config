#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const EXACT_VERSION_FILE = /^\d+\.\d+\.\d+\n?$/

export function parseRenovateVersion(raw) {
  if (!EXACT_VERSION_FILE.test(raw)) {
    throw new Error('.renovate-version must contain one exact version such as 1.2.3.')
  }
  return raw.trim()
}

export function readRenovateVersion(repoRoot = process.cwd()) {
  const file = path.join(repoRoot, '.renovate-version')
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    throw new Error(`cannot read ${file}`)
  }
  return parseRenovateVersion(raw)
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== '--print-version' || process.argv.length !== 3) {
    console.error('usage: node tools/renovate-runtime.mjs --print-version')
    process.exit(2)
  }
  try {
    console.log(readRenovateVersion())
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
