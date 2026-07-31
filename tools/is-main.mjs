import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Lexical path equality silently skips CLIs invoked through symlinks. Resolve
// both paths to their filesystem identity; any missing/broken path is not main.
export function isMainModule(moduleUrl, argvPath = process.argv[1]) {
  if (!argvPath) return false
  try {
    return (
      fs.realpathSync.native(path.resolve(argvPath)) ===
      fs.realpathSync.native(fileURLToPath(moduleUrl))
    )
  } catch {
    return false
  }
}
