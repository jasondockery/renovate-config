import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

export function findPinnedRenovateRoot(environment = process.env) {
  const pathValue = environment.PATH
  if (typeof pathValue !== 'string' || pathValue.length === 0) {
    throw new Error('PATH is unavailable; invoke this check through the pinned Renovate integration command')
  }
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue
    const candidate = path.join(directory, 'renovate')
    let resolved
    try {
      resolved = fs.realpathSync(candidate)
    } catch {
      continue
    }
    let current = path.dirname(resolved)
    while (current !== path.dirname(current)) {
      const manifest = path.join(current, 'package.json')
      try {
        const value = JSON.parse(fs.readFileSync(manifest, 'utf8'))
        if (value.name === 'renovate') return current
      } catch {
        // Continue walking through the npx package layout.
      }
      current = path.dirname(current)
    }
  }
  throw new Error('the pinned Renovate package is not present on PATH')
}

export async function importRenovateModule(runtimeRoot, relativePath) {
  const target = path.resolve(runtimeRoot, 'dist', relativePath)
  const relative = path.relative(path.resolve(runtimeRoot, 'dist'), target)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Renovate module path escaped the runtime: ${relativePath}`)
  }
  return import(pathToFileURL(target).href)
}
