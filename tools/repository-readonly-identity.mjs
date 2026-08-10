import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024
const GIT_TIMEOUT_MILLISECONDS = 15_000
const MAX_TRACKED_PATHS = 50_000
const MAX_RELEVANT_IGNORED_PATHS = 20_000
const MAX_HASHED_BYTES = 1024 * 1024 * 1024
const HASH_CHUNK_BYTES = 64 * 1024

export function runBoundedGit(root, args, {
  command = 'git',
  runner = execFileSync,
  timeoutMilliseconds = GIT_TIMEOUT_MILLISECONDS,
  maxBuffer = MAX_GIT_OUTPUT_BYTES,
} = {}) {
  try {
    return runner(command, ['-C', root, ...args], {
      encoding: 'utf8',
      maxBuffer,
      timeout: timeoutMilliseconds,
      killSignal: 'SIGKILL',
    })
  } catch (error) {
    const timedOut = error?.code === 'ETIMEDOUT' || error?.signal === 'SIGKILL'
    const detail = timedOut
      ? `timed out after ${timeoutMilliseconds}ms`
      : error instanceof Error ? error.message : String(error)
    throw new Error(`bounded Git ${args.join(' ')} failed: ${detail}`, { cause: error })
  }
}

function hashFile(digest, file, budget) {
  const descriptor = fs.openSync(file, 'r')
  const chunk = Buffer.allocUnsafe(HASH_CHUNK_BYTES)
  try {
    while (true) {
      const read = fs.readSync(descriptor, chunk, 0, chunk.length, null)
      if (read === 0) break
      budget.bytes += read
      if (budget.bytes > MAX_HASHED_BYTES) throw new Error('repository identity exceeds the aggregate byte bound')
      digest.update(chunk.subarray(0, read))
    }
  } finally {
    fs.closeSync(descriptor)
  }
}

function hashPath(digest, root, relative, budget) {
  const absolute = path.join(root, relative)
  let status
  try {
    status = fs.lstatSync(absolute)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      digest.update(`missing\0${relative}\0`)
      return
    }
    throw error
  }
  digest.update(`path\0${relative}\0mode\0${status.mode.toString(8)}\0`)
  if (status.isSymbolicLink()) {
    digest.update(`symlink\0${fs.readlinkSync(absolute)}\0`)
  } else if (status.isFile()) {
    digest.update(`file\0${status.size}\0`)
    hashFile(digest, absolute, budget)
  } else if (status.isDirectory()) {
    digest.update('directory\0')
    for (const entry of fs.readdirSync(absolute).sort()) {
      budget.paths += 1
      if (budget.paths > MAX_RELEVANT_IGNORED_PATHS) {
        throw new Error('relevant ignored identity exceeds the path bound')
      }
      hashPath(digest, root, path.posix.join(relative.split(path.sep).join('/'), entry), budget)
    }
  } else {
    throw new Error(`repository identity does not accept special file ${relative}`)
  }
}

function fingerprintPaths(root, paths, pathLimit) {
  if (paths.length > pathLimit) throw new Error(`repository identity exceeds the ${pathLimit}-path bound`)
  const digest = createHash('sha256')
  const budget = { bytes: 0, paths: paths.length }
  for (const relative of [...paths].sort()) hashPath(digest, root, relative, budget)
  return `sha256:${digest.digest('hex')}`
}

export function snapshotRepository(root, relevantIgnored = []) {
  const absoluteRoot = fs.realpathSync(root)
  const headSha = runBoundedGit(absoluteRoot, ['rev-parse', 'HEAD']).trim()
  if (!/^[0-9a-f]{40}$/u.test(headSha)) throw new Error(`${absoluteRoot} has no exact 40-character HEAD SHA`)
  const status = runBoundedGit(absoluteRoot, ['status', '--porcelain=v1', '--untracked-files=all']).trim()
  const tracked = runBoundedGit(absoluteRoot, ['ls-files', '-z']).split('\0').filter(Boolean)
  const ignoredState = Object.fromEntries(relevantIgnored.map((relative) => {
    if (path.isAbsolute(relative) || relative.split('/').includes('..')) {
      throw new Error(`relevant ignored path escapes repository: ${relative}`)
    }
    const exists = fs.existsSync(path.join(absoluteRoot, relative))
    return [relative, {
      exists,
      fingerprint: exists ? fingerprintPaths(absoluteRoot, [relative], MAX_RELEVANT_IGNORED_PATHS) : null,
    }]
  }))
  return {
    headSha,
    status,
    trackedPaths: tracked.length,
    trackedFingerprint: fingerprintPaths(absoluteRoot, tracked, MAX_TRACKED_PATHS),
    relevantIgnored: ignoredState,
  }
}

export function summarizeRelevantIgnored(snapshot) {
  const digest = createHash('sha256')
  for (const [relative, state] of Object.entries(snapshot.relevantIgnored).sort(([left], [right]) => left.localeCompare(right))) {
    digest.update(`${relative}\0${state.exists ? 'present' : 'absent'}\0${state.fingerprint ?? ''}\0`)
  }
  return `sha256:${digest.digest('hex')}`
}

export function compareRepositorySnapshots(repository, before, after, { requireClean = true } = {}) {
  const problems = []
  if (requireClean && before.status) problems.push(`${repository} started dirty: ${before.status}`)
  if (requireClean && after.status) problems.push(`${repository} ended dirty: ${after.status}`)
  if (before.status !== after.status) problems.push(`${repository} complete Git status changed`)
  if (before.headSha !== after.headSha) problems.push(`${repository} HEAD changed`)
  if (before.trackedFingerprint !== after.trackedFingerprint) problems.push(`${repository} tracked-file fingerprint changed`)
  if (JSON.stringify(before.relevantIgnored) !== JSON.stringify(after.relevantIgnored)) {
    problems.push(`${repository} relevant ignored outputs changed`)
  }
  return problems
}
