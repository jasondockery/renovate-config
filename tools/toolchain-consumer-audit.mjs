#!/usr/bin/env node
// Audits ONE consumer repository's toolchain contract by importing its own
// sync, checker, and reporter modules — source strings are not behavioral proof.
//
// This runs as its own process on purpose. Importing another repository's code
// executes that repository's top-level statements, so an in-process audit lets
// any audited repository patch globals, prototypes, or `fs` and silently
// corrupt the verdict for every repository audited after it. A child process
// per repository bounds that blast radius to one verdict, and gives the caller
// a deadline it can actually enforce.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { isMainModule } from './is-main.mjs'

// Accepts exactly what sync-toolchain.mjs accepts, including a trailing
// comment, so this audit never reports drift the writer considers synchronized.
function miseTool(source, tool) {
  if (typeof source !== 'string') return undefined
  let inTools = false
  for (const line of source.split('\n')) {
    const section = /^\s*\[([^\]]+)]\s*(?:#.*)?$/.exec(line)
    if (section) { inTools = section[1] === 'tools'; continue }
    if (!inTools) continue
    const match = new RegExp(`^\\s*${tool}\\s*=\\s*["']([^"']+)["']`).exec(line)
    if (match) return match[1]
  }
  return undefined
}

function safeRead(root, relative, problems) {
  try { return fs.readFileSync(path.join(root, relative), 'utf8') }
  catch (error) { problems.push(`${relative} is missing or unreadable (${error.code ?? 'read failure'})`); return undefined }
}

function safeJson(root, relative, problems) {
  const source = safeRead(root, relative, problems)
  if (source === undefined) return undefined
  try { return JSON.parse(source) }
  catch { problems.push(`${relative} is not valid JSON`); return undefined }
}

async function importConsumerModule(root, relative, problems) {
  if (!safeRead(root, relative, problems)) return undefined
  try { return await import(pathToFileURL(path.join(root, relative)).href) }
  catch (error) { problems.push(`${relative} could not be imported (${error instanceof Error ? error.message : String(error)})`); return undefined }
}

function proveMirrorPlanning(root, sync, problems) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-mirror-planning-'))
  const mirrors = ['.nvmrc', 'mise.toml', 'package.json']
  if (fs.existsSync(path.join(root, 'packages/cli/templates/init'))) mirrors.push(
    'packages/cli/templates/init/.node-version',
    'packages/cli/templates/init/.nvmrc',
    'packages/cli/templates/init/mise.toml',
    'packages/cli/templates/init/package.json',
  )
  const required = ['.node-version', 'package.json', ...mirrors]
  try {
    for (const relative of new Set(required)) {
      const target = path.join(temporary, relative)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(path.join(root, relative), target)
    }
    if (sync.plannedToolchainUpdates(temporary).length !== 0) problems.push('plannedToolchainUpdates is not a no-op for a synchronized fixture')
    for (const relative of mirrors) {
      const target = path.join(temporary, relative)
      const original = fs.readFileSync(target, 'utf8')
      if (relative.endsWith('package.json')) {
        const manifest = JSON.parse(original)
        manifest.engines = { ...(manifest.engines ?? {}), node: '0.0.0', pnpm: '0.0.0' }
        if (relative.startsWith('packages/')) manifest.packageManager = 'pnpm@0.0.0'
        fs.writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`)
      } else if (relative.endsWith('mise.toml')) fs.writeFileSync(target, original.replace(/node\s*=\s*["'][^"']+["']/, 'node = "0.0.0"'))
      else fs.writeFileSync(target, '0.0.0\n')
      let planned
      try { planned = sync.plannedToolchainUpdates(temporary).map(({ file }) => file) }
      catch (error) { problems.push(`plannedToolchainUpdates could not inspect mutated ${relative} (${error instanceof Error ? error.message : String(error)})`); planned = [] }
      if (!planned.includes(relative)) problems.push(`plannedToolchainUpdates did not identify mutated ${relative}`)
      fs.writeFileSync(target, original)
    }
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
}

export async function auditToolchainConsumer(root) {
  const problems = []
  const node = safeRead(root, '.node-version', problems)?.trim()
  const manifest = safeJson(root, 'package.json', problems)
  const pnpm = /^pnpm@(\d+\.\d+\.\d+)(?:\+.+)?$/.exec(manifest?.packageManager ?? '')?.[1]
  const mise = safeRead(root, 'mise.toml', problems)
  if (!/^\d+\.\d+\.\d+$/.test(node)) problems.push('.node-version is not an exact authority')
  if (!pnpm) problems.push('packageManager is not an exact pnpm authority')
  if (safeRead(root, '.nvmrc', problems)?.trim() !== node) problems.push('.nvmrc is stale')
  if (miseTool(mise, 'node') !== node) problems.push('mise Node adapter is stale')
  if (miseTool(mise, 'pnpm') !== undefined) problems.push('mise.toml declares forbidden pnpm ownership')
  if (manifest?.engines?.node !== node || (pnpm && manifest?.engines?.pnpm !== pnpm)) problems.push('package engines are stale')
  for (const script of ['toolchain:sync', 'check:toolchain', 'check:outdated']) if (typeof manifest?.scripts?.[script] !== 'string') problems.push(`package.json is missing ${script}`)
  const sync = await importConsumerModule(root, 'tools/sync-toolchain.mjs', problems)
  if (sync?.plannedToolchainUpdates) {
    try {
      for (const update of sync.plannedToolchainUpdates(root)) problems.push(`${update.file} is stale according to plannedToolchainUpdates`)
      proveMirrorPlanning(root, sync, problems)
    } catch (error) { problems.push(`plannedToolchainUpdates failed (${error instanceof Error ? error.message : String(error)})`) }
  }
  const reporter = await importConsumerModule(root, 'tools/show-outdated.mjs', problems)
  if (reporter?.formatOutdated) {
    try {
      const output = reporter.formatOutdated(
        { demo: { current: '1.0.0', wanted: '1.0.0', latest: '1.0.0' } },
        { demo: { current: '1.0.0', wanted: '1.0.0', latest: '1.1.0' } },
        { demo: { 'dist-tags': { latest: '2.0.0' } } },
        { demo: '^1.0.0' },
      ).join('\n')
      for (const field of ['Current:', 'Lockfile Wanted:', 'Compatible Latest:', 'pnpm-mature Latest:', 'Registry Newest:', 'Declared Specification:', 'Compatible update available: yes', 'pnpm age status:', 'Renovate Eligibility:']) if (!output.includes(field)) problems.push(`check:outdated behavior is missing ${field}`)
      let rejected = false
      try { reporter.runJsonCommand('pnpm', ['outdated'], { acceptedStatuses: [0, 1], runner: () => ({ status: 2, stdout: '{}', stderr: 'controlled failure' }) }) } catch { rejected = true }
      if (!rejected) problems.push('check:outdated accepts an unexpected pnpm failure')
      // A per-command timeout is not a cumulative deadline: the report runs one
      // registry lookup per outdated package, so the whole run needs its own bound.
      if (typeof reporter.evidenceBudget !== 'function') problems.push('check:outdated does not declare a cumulative evidence deadline')
      else {
        let expired = false
        try { reporter.evidenceBudget(0).slice() } catch { expired = true }
        if (!expired) problems.push('check:outdated cumulative deadline does not fail closed when exhausted')
      }
    } catch (error) { problems.push(`check:outdated behavior failed (${error instanceof Error ? error.message : String(error)})`) }
  }
  const checker = await importConsumerModule(root, 'tools/check-toolchain.mjs', problems)
  if (checker?.collectUnclassifiedToolchainLiterals) {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-consumer-audit-'))
    try {
      fs.writeFileSync(path.join(temporary, 'README.md'), 'Requires Node 20.10.0.\n')
      const found = checker.collectUnclassifiedToolchainLiterals(temporary, 'README.md\0')
      if (!found.some((problem) => /README\.md:1/.test(problem))) problems.push('toolchain checker accepts a former production Node version in live documentation')
      // The same surface with no inventory argument and no Git metadata must
      // still observe the tree; a guard that reports ok while observing nothing
      // is worse than no guard.
      const walked = checker.collectUnclassifiedToolchainLiterals(temporary)
      if (!walked.some((problem) => /README\.md:1/.test(problem))) problems.push('toolchain checker reports a silent pass when Git metadata is absent')
    } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
  }
  const renovate = safeJson(root, 'renovate.json', problems)
  if (!renovate?.postUpgradeTasks?.commands?.includes('node tools/sync-toolchain.mjs')) problems.push('Renovate does not run exact toolchain sync')
  if (fs.existsSync(path.join(root, 'packages/cli/templates/init'))) {
    const template = path.join(root, 'packages/cli/templates/init')
    const templateManifest = safeJson(template, 'package.json', problems)
    if (safeRead(template, '.node-version', problems)?.trim() !== node || safeRead(template, '.nvmrc', problems)?.trim() !== node) problems.push('generated Node authority/mirror is stale')
    if (miseTool(safeRead(template, 'mise.toml', problems), 'pnpm') !== undefined) problems.push('generated mise.toml declares forbidden pnpm ownership')
    if (templateManifest?.packageManager !== manifest?.packageManager || templateManifest?.engines?.node !== node || templateManifest?.engines?.pnpm !== pnpm) problems.push('generated package toolchain is stale')
    const portable = safeJson(template, 'renovate.json', problems)
    if (portable?.postUpgradeTasks) problems.push('generated Renovate config must not require repository post-upgrade commands')
    for (const [groupName, dependency] of [['Node toolchain', 'node'], ['pnpm toolchain', 'pnpm']]) {
      if (!portable?.packageRules?.some((rule) => rule.groupName === groupName && rule.matchPackageNames?.includes(dependency))) problems.push(`generated Renovate config is missing portable ${groupName} correlation`)
    }
  }
  return problems
}

if (isMainModule(import.meta.url)) {
  const root = process.argv[2]
  if (!root) {
    process.stderr.write('usage: node tools/toolchain-consumer-audit.mjs <repository-root>\n')
    process.exitCode = 1
  } else {
    const problems = await auditToolchainConsumer(root)
    process.stdout.write(JSON.stringify({ problems }))
  }
}
