#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { extractionArguments, extractionEnvironment, parseExtractedDependencies } from './check-renovate-extraction.mjs'
import { isMainModule } from './is-main.mjs'
import { findPinnedRenovateRoot, importRenovateModule } from './pinned-renovate-runtime.mjs'
import { readRenovateVersion } from './renovate-runtime.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const MAX_PATHS = 20_000
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_TOTAL_BYTES = 512 * 1024 * 1024
const targetManifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'compatibility-targets.json'), 'utf8'))
if (targetManifest.schemaVersion !== 1 || targetManifest.targets?.length !== 3) {
  throw new Error('compatibility-targets.json must declare exactly three schema-v1 targets')
}
const TARGETS = Object.freeze(targetManifest.targets.map(({ repository, directory }) => [
  repository,
  path.resolve(repositoryRoot, directory),
]))

const DISCOVERY_EXCLUDED_PATH = /^(?:docs|specs|playbooks|tests\/fixtures|tools\/fixtures)\//u
const DISCOVERY_EXCLUDED_FILE = /^(?:README|ROADMAP|PLAYBOOK|AI_THESIS|CHARTER)(?:\.[^/]*)?$/u
const DISCOVERY_EXCLUDED_EXTENSION = /\.(?:adoc|htm|html|md|mdx|rst|txt)$/iu
const VERSION_VALUE = String.raw`(?:v?\d+(?:\.\d+){0,3}|lts|latest|stable|system)`
const VERSION_KEY = String.raw`[A-Za-z_][A-Za-z0-9_]*(?:version|runtime|python|node|pnpm|sha256|checksum)[A-Za-z0-9_]*`
const GLOBAL_VERSION_KEY = String.raw`[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:VERSION|RUNTIME|PYTHON|NODE|PNPM|SHA256|CHECKSUM)`
const sourceVersionAssignment = new RegExp(
  String.raw`(?:^|\s)(?:(?:export|readonly|local|const|let|var)\s+)?${VERSION_KEY}\s*(?:=|:)\s*["']?${VERSION_VALUE}\b`,
  'iu'
)
const structuredVersionAssignment = new RegExp(
  String.raw`^[\s"']*${VERSION_KEY}["']?\s*(?:=|:)\s*["']?${VERSION_VALUE}\b`,
  'iu'
)
const globalSourceVersionAssignment = new RegExp(
  String.raw`(?:^|\s)(?:(?:export|readonly|local|const|let|var)\s+)?${GLOBAL_VERSION_KEY}\s*(?:=|:)\s*["']?${VERSION_VALUE}\b`,
  'u'
)
const globalStructuredVersionAssignment = new RegExp(
  String.raw`^[\s"']*${GLOBAL_VERSION_KEY}["']?\s*(?:=|:)\s*["']?${VERSION_VALUE}\b`,
  'u'
)

function regex(pattern, label) {
  try {
    return new RegExp(pattern, 'u')
  } catch (error) {
    throw new Error(`${label} is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function normalizePath(value) {
  return value.replace(/^\.\//u, '').split(path.sep).join('/')
}

export function tupleMatches(tuple, matcher) {
  return tuple.manager === matcher.manager &&
    regex(matcher.packageFilePattern, 'packageFilePattern').test(tuple.packageFile) &&
    regex(matcher.depNamePattern, 'depNamePattern').test(tuple.depName)
}

function declarationKey(declaration) {
  return `${declaration.manager}\0${declaration.packageFile}\0${declaration.depName}\0${declaration.currentValue ?? ''}`
}

function declarationMatches(tuple, declaration) {
  if (
    tuple.manager !== declaration.manager ||
    tuple.packageFile !== declaration.packageFile ||
    tuple.depName !== declaration.depName
  ) return false
  if (declaration.currentValue === null) return true
  return tuple.currentValue === declaration.currentValue || tuple.currentDigest === declaration.currentValue
}

function addDeclaration(found, declaration, inventory) {
  const owned = inventory.surfaces.some((surface) =>
    (surface.extractionMatchers ?? []).some((matcher) => tupleMatches(declaration, matcher))
  )
  if (owned) found.set(declarationKey(declaration), declaration)
}

function stripYamlValue(value) {
  const withoutComment = value.replace(/\s+#.*$/u, '').trim()
  if (
    (withoutComment.startsWith("'") && withoutComment.endsWith("'")) ||
    (withoutComment.startsWith('"') && withoutComment.endsWith('"'))
  ) return withoutComment.slice(1, -1)
  return withoutComment
}

function imageDeclaration(manager, packageFile, reference) {
  const withoutScheme = reference.replace(/^docker:\/\//u, '')
  const [nameAndTag, digest = ''] = withoutScheme.split('@', 2)
  const slash = nameAndTag.lastIndexOf('/')
  const colon = nameAndTag.lastIndexOf(':')
  const hasTag = colon > slash
  return {
    manager,
    packageFile,
    depName: hasTag ? nameAndTag.slice(0, colon) : nameAndTag,
    currentValue: hasTag ? nameAndTag.slice(colon + 1) : (digest || null),
  }
}

function packageJsonDeclarations(relative, document) {
  const declarations = []
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const dependencies = document[section]
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) continue
    for (const [depName, value] of Object.entries(dependencies)) {
      if (typeof value !== 'string') continue
      declarations.push({
        manager: 'npm',
        packageFile: relative,
        depName,
        currentValue: /^(?:catalog|workspace|file|link):/u.test(value) ? null : value,
      })
    }
  }
  if (typeof document.packageManager === 'string') {
    const match = /^([^@]+)@(.+)$/u.exec(document.packageManager)
    if (match) declarations.push({ manager: 'npm', packageFile: relative, depName: match[1], currentValue: match[2] })
  }
  if (document.engines && typeof document.engines === 'object' && !Array.isArray(document.engines)) {
    for (const tool of ['node', 'pnpm']) {
      if (typeof document.engines[tool] === 'string') {
        declarations.push({ manager: 'npm', packageFile: relative, depName: tool, currentValue: document.engines[tool] })
      }
    }
  }
  return declarations
}

function catalogDeclarations(relative, text) {
  const declarations = []
  let section = ''
  for (const line of text.split(/\r?\n/u)) {
    if (/^catalog:\s*$/u.test(line)) {
      section = 'catalog'
      continue
    }
    if (/^catalogs:\s*$/u.test(line)) {
      section = 'catalogs'
      continue
    }
    if (/^[^\s#]/u.test(line)) section = ''
    if (section !== 'catalog' && section !== 'catalogs') continue
    const indentation = /^\s*/u.exec(line)?.[0].length ?? 0
    if ((section === 'catalog' && indentation !== 2) || (section === 'catalogs' && indentation !== 4)) continue
    const match = /^\s+(?:'([^']+)'|"([^"]+)"|([^\s:#][^:]*)):\s+(.+?)\s*$/u.exec(line)
    if (!match) continue
    const depName = (match[1] ?? match[2] ?? match[3]).trim()
    const currentValue = stripYamlValue(match[4])
    if (depName && currentValue) declarations.push({ manager: 'npm', packageFile: relative, depName, currentValue })
  }
  return declarations
}

function workflowDeclarations(relative, text) {
  const declarations = []
  for (const line of text.split(/\r?\n/u)) {
    const uses = /^\s*(?:-\s+)?uses:\s*([^\s#]+)(?:\s+#.*)?$/u.exec(line)?.[1]
    if (uses && !uses.startsWith('./')) {
      if (uses.startsWith('docker://')) declarations.push(imageDeclaration('github-actions', relative, uses))
      else {
        const separator = uses.lastIndexOf('@')
        if (separator > 0) {
          const actionPath = uses.slice(0, separator)
          const parts = actionPath.split('/')
          declarations.push({
            manager: 'github-actions',
            packageFile: relative,
            depName: parts.slice(0, 2).join('/'),
            currentValue: uses.slice(separator + 1),
          })
        }
      }
    }
    const runner = /^\s*runs-on:\s*(?:\[\s*)?([A-Za-z][A-Za-z0-9_-]*?)-(\d+(?:\.\d+)*)(?:\s*\])?(?:\s+#.*)?$/u.exec(line)
    if (runner) declarations.push({
      manager: 'github-actions',
      packageFile: relative,
      depName: runner[1],
      currentValue: runner[2],
    })
  }
  return declarations
}

export function collectDeclaredDependencies(root, inventory) {
  const found = new Map()
  let totalBytes = 0
  for (const relative of repositoryFiles(root)) {
    const absolute = path.join(root, relative)
    let status
    try {
      status = fs.lstatSync(absolute)
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    if (!status.isFile() || status.isSymbolicLink() || status.size > MAX_FILE_BYTES) continue
    totalBytes += status.size
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error(`${root} exceeds the ${MAX_TOTAL_BYTES}-byte declaration scan bound`)
    }
    const text = fs.readFileSync(absolute, 'utf8')
    const basename = path.posix.basename(relative)
    const declarations = []
    if (basename === 'package.json') declarations.push(...packageJsonDeclarations(relative, parseJsonDocument(text, relative)))
    if (basename === 'pnpm-workspace.yaml') declarations.push(...catalogDeclarations(relative, text))
    if (basename === '.node-version') {
      declarations.push({ manager: 'nodenv', packageFile: relative, depName: 'node', currentValue: text.trim() })
    }
    if (basename === '.nvmrc') {
      declarations.push({ manager: 'nvm', packageFile: relative, depName: 'node', currentValue: text.trim() })
    }
    if (/^(?:\.github\/(?:workflows|actions)|packages\/cli\/templates\/init\/\.github\/workflows)\//u.test(relative)) {
      declarations.push(...workflowDeclarations(relative, text))
    }
    if (/^(?:Dockerfile(?:\.[^/]*)?|.*\/Dockerfile(?:\.[^/]*)?)$/u.test(relative)) {
      for (const line of text.split(/\r?\n/u)) {
        const reference = /^\s*FROM\s+(?:--platform=\S+\s+)?([^\s]+)(?:\s+AS\s+\S+)?/iu.exec(line)?.[1]
        if (reference && !/^scratch$/iu.test(reference)) declarations.push(imageDeclaration('dockerfile', relative, reference))
      }
    }
    if (/(?:^|\/)(?:docker-)?compose(?:\.[^.]+)?\.ya?ml$/iu.test(relative)) {
      for (const line of text.split(/\r?\n/u)) {
        const reference = /^\s*image:\s*([^\s#]+)/u.exec(line)?.[1]
        if (reference) declarations.push(imageDeclaration('docker-compose', relative, reference))
      }
    }
    for (const declaration of declarations) addDeclaration(found, declaration, inventory)
  }
  return [...found.values()].sort((left, right) => declarationKey(left).localeCompare(declarationKey(right)))
}

function scanMatches(hit, matcher) {
  return hit.pattern === matcher.pattern &&
    regex(matcher.pathPattern, 'pathPattern').test(hit.path) &&
    (!matcher.linePattern || regex(matcher.linePattern, 'linePattern').test(hit.text))
}

function validSuppression(matcher) {
  return typeof matcher.linePattern === 'string' && matcher.linePattern.length > 0 &&
    Number.isInteger(matcher.expectedMatches) && matcher.expectedMatches > 0
}

export function collectCoverageProblems(inventory, tuples, scanHits, declarations = []) {
  const problems = []
  if (inventory.schemaVersion !== 2) problems.push('inventory schemaVersion must be 2')
  for (const tuple of tuples) {
    const owners = inventory.surfaces.filter((surface) =>
      (surface.extractionMatchers ?? []).some((matcher) => tupleMatches(tuple, matcher))
    )
    if (owners.length !== 1) {
      problems.push(
        `extraction must have exactly one owner (${owners.map(({ id }) => id).join(', ') || 'none'}): ` +
        `${tuple.manager} ${tuple.packageFile} ${tuple.depName} ${tuple.currentValue || '<unversioned>'}`
      )
    }
  }
  for (const declaration of declarations) {
    if (!tuples.some((tuple) => declarationMatches(tuple, declaration))) {
      problems.push(
        `Renovate extraction missed declared dependency: ${declaration.manager} ${declaration.packageFile} ` +
        `${declaration.depName} ${declaration.currentValue ?? '<manager-resolved>'}`
      )
    }
  }
  for (const surface of inventory.surfaces) {
    if (!['built-in', 'custom-manager'].includes(surface.classification)) continue
    const matched = tuples.some((tuple) =>
      (surface.extractionMatchers ?? []).some((matcher) => tupleMatches(tuple, matcher))
    )
    if (!matched) problems.push(`${surface.id} has no actual Renovate extraction evidence`)
  }
  for (const hit of scanHits) {
    const owners = inventory.surfaces.filter((surface) =>
      (surface.scanMatchers ?? []).some((matcher) => scanMatches(hit, matcher))
    )
    const suppressions = (inventory.scanSuppressions ?? []).filter((matcher) =>
      validSuppression(matcher) && scanMatches(hit, matcher)
    )
    if (owners.length + suppressions.length !== 1) {
      const matches = [
        ...owners.map(({ id }) => id),
        ...suppressions.map(({ reason }) => `suppression:${reason}`),
      ]
      problems.push(
        `${hit.pattern} convention must have exactly one owner (${matches.join(', ') || 'none'}): ${hit.path}:${hit.line}`
      )
    }
  }
  for (const surface of inventory.surfaces) {
    for (const matcher of surface.scanMatchers ?? []) {
      if (!matcher.optional && !scanHits.some((hit) => scanMatches(hit, matcher))) {
        problems.push(`${surface.id} scan matcher has no discovery evidence: ${matcher.pattern} ${matcher.pathPattern}`)
      }
    }
  }
  for (const suppression of inventory.scanSuppressions ?? []) {
    if (!validSuppression(suppression)) {
      problems.push(`scan suppression must have linePattern and positive expectedMatches: ${suppression.reason}`)
      continue
    }
    const matches = scanHits.filter((hit) => scanMatches(hit, suppression)).length
    if (matches !== suppression.expectedMatches) {
      problems.push(
        `scan suppression expected ${String(suppression.expectedMatches)} match(es), found ${String(matches)}: ${suppression.reason}`
      )
    }
  }
  return problems
}

function repositoryFiles(root) {
  const result = spawnSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    encoding: 'utf8',
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: 15_000,
  })
  if (result.error) throw new Error(`could not enumerate ${root}: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`git ls-files failed for ${root}`)
  const files = result.stdout.split('\0').filter(Boolean).map(normalizePath)
  if (files.length > MAX_PATHS) throw new Error(`${root} exceeds the ${MAX_PATHS}-path scan bound`)
  return files
}

function explicitlyIncluded(relative, inventory) {
  return [
    ...inventory.surfaces.flatMap(({ scanMatchers = [] }) => scanMatchers),
    ...(inventory.scanSuppressions ?? []),
  ].some((matcher) => regex(matcher.pathPattern, 'pathPattern').test(relative))
}

function versionAssignmentSelected(relative, inventory) {
  return [
    ...inventory.surfaces.flatMap(({ scanMatchers = [] }) => scanMatchers),
    ...(inventory.scanSuppressions ?? []),
  ].some((matcher) =>
    matcher.pattern === 'version-assignment' && regex(matcher.pathPattern, 'pathPattern').test(relative)
  )
}

function parseJsonDocument(text, relative) {
  let output = ''
  let inString = false
  let escaped = false
  let lineComment = false
  let blockComment = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    const next = text[index + 1]
    if (lineComment) {
      if (character === '\n') {
        lineComment = false
        output += character
      } else output += ' '
      continue
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false
        output += '  '
        index += 1
      } else output += character === '\n' ? '\n' : ' '
      continue
    }
    if (!inString && character === '/' && next === '/') {
      lineComment = true
      output += '  '
      index += 1
      continue
    }
    if (!inString && character === '/' && next === '*') {
      blockComment = true
      output += '  '
      index += 1
      continue
    }
    output += character
    if (inString && escaped) escaped = false
    else if (inString && character === '\\') escaped = true
    else if (character === '"') inString = !inString
  }
  if (inString || blockComment) throw new Error(`${relative} has an unterminated JSON string or comment`)
  let normalized = ''
  inString = false
  escaped = false
  for (let index = 0; index < output.length; index += 1) {
    const character = output[index]
    if (!inString && character === ',') {
      let lookahead = index + 1
      while (/\s/u.test(output[lookahead] ?? '')) lookahead += 1
      if (output[lookahead] === '}' || output[lookahead] === ']') continue
    }
    normalized += character
    if (inString && escaped) escaped = false
    else if (inString && character === '\\') escaped = true
    else if (character === '"') inString = !inString
  }
  try {
    return JSON.parse(normalized)
  } catch (error) {
    throw new Error(`${relative} is not structurally valid JSON/JSONC: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function fileKinds(relative, content) {
  const kinds = new Set()
  const semanticPath = relative.replace(/\.fixture$/u, '')
  const basename = path.posix.basename(semanticPath)
  if (/\.json$/u.test(semanticPath)) kinds.add('json')
  if (/\.toml(?:\.tmpl)?$/u.test(semanticPath)) kinds.add('toml')
  if (/\.ya?ml$/u.test(semanticPath)) kinds.add('yaml')
  if (/^(?:Dockerfile(?:\.[^/]*)?|.*compose.*\.ya?ml)$/iu.test(basename)) kinds.add('container')
  if (/^(?:\.github\/(?:workflows|actions)|packages\/cli\/templates\/init\/\.github\/workflows)\//u.test(relative)) {
    kinds.add('workflow')
  }
  if (
    /(?:^|\/)(?:scripts|bin)\//u.test(semanticPath) ||
    /(?:^|\/)run_(?:before|after)_/u.test(semanticPath) ||
    /\.(?:sh|bash|zsh)(?:\.tmpl)?$/u.test(semanticPath) ||
    /^#!.*\b(?:ba|z)?sh\b/mu.test(content)
  ) kinds.add('source')
  if (/\.(?:[cm]?[jt]sx?|py|env)$/u.test(semanticPath)) kinds.add('source')
  if (/tmux.*\.conf(?:\.tmpl)?$/iu.test(semanticPath)) kinds.add('plugin')
  if (/^#!/u.test(content)) {
    kinds.delete('json')
    kinds.delete('toml')
    kinds.delete('yaml')
  }
  return kinds
}

function detectedPatterns(relative, line, kinds, tomlSection, selectedVersionAssignment) {
  const patterns = new Set()
  if (/sha256:[0-9a-f]{64}/u.test(line)) patterns.add('digest')
  if (/(?:https?:\/\/\S+)?\/releases\/download\//u.test(line)) patterns.add('release-download')
  if (/\bnodejs\d+\.x\b/u.test(line)) patterns.add('runtime-literal')
  if (
    (kinds.has('container') && /^\s*(?:FROM\s+\S+|image:\s*\S+)/u.test(line)) ||
    ((kinds.has('workflow') || kinds.has('yaml')) && /^\s*(?:-\s+)?uses:\s*docker:\/\/\S+/u.test(line))
  ) {
    patterns.add('container-reference')
  }
  if ((kinds.has('workflow') || kinds.has('yaml')) && /^\s*(?:-\s+)?uses:\s*(?!docker:\/\/)\S+@\S+/u.test(line)) {
    patterns.add('workflow-reference')
  }
  if (
    (kinds.has('source') && (
      globalSourceVersionAssignment.test(line) ||
      (selectedVersionAssignment && sourceVersionAssignment.test(line))
    )) ||
    ((kinds.has('json') || kinds.has('yaml')) && (
      globalStructuredVersionAssignment.test(line) ||
      (selectedVersionAssignment && structuredVersionAssignment.test(line))
    )) ||
    (kinds.has('toml') && (
      structuredVersionAssignment.test(line) ||
      (tomlSection === 'tools' && /^\s*[A-Za-z0-9_.-]+\s*=\s*(?:["'][^"']+["']|\[[^\]]+\])\s*(?:#.*)?$/u.test(line))
    ))
  ) patterns.add('version-assignment')
  if (kinds.has('plugin') && /(?:@plugin|catppuccin\/tmux).*#v?\d+(?:\.\d+){1,3}/iu.test(line)) {
    patterns.add('plugin-reference')
  }
  return patterns
}

export function scanVersionConventions(root, inventory) {
  const hits = []
  const seenHits = new Set()
  let totalBytes = 0
  for (const relative of repositoryFiles(root)) {
    const basename = path.posix.basename(relative)
    if (
      (
        DISCOVERY_EXCLUDED_PATH.test(relative) ||
        DISCOVERY_EXCLUDED_FILE.test(basename) ||
        DISCOVERY_EXCLUDED_EXTENSION.test(relative) ||
        /\.test\.[^/]+$/u.test(relative)
      ) &&
      !explicitlyIncluded(relative, inventory)
    ) continue
    const absolute = path.join(root, relative)
    let status
    try {
      status = fs.lstatSync(absolute)
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    if (status.isSymbolicLink() || !status.isFile()) continue
    if (status.size > MAX_FILE_BYTES) throw new Error(`${relative} exceeds the ${MAX_FILE_BYTES}-byte per-file scan bound`)
    totalBytes += status.size
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`${root} exceeds the ${MAX_TOTAL_BYTES}-byte aggregate scan bound`)
    const content = fs.readFileSync(absolute)
    if (content.includes(0)) continue
    const text = content.toString('utf8')
    const kinds = fileKinds(relative, text)
    if (kinds.has('json')) parseJsonDocument(text, relative)
    const selectedVersionAssignment = versionAssignmentSelected(relative, inventory)
    let tomlSection = ''
    for (const [index, line] of text.split(/\r?\n/u).entries()) {
      if (kinds.has('toml')) {
        const heading = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/u.exec(line)
        if (heading) tomlSection = heading[1]
      }
      const patterns = detectedPatterns(relative, line, kinds, tomlSection, selectedVersionAssignment)
      for (const matcher of [
        ...inventory.surfaces.flatMap(({ scanMatchers = [] }) => scanMatchers),
        ...(inventory.scanSuppressions ?? []),
      ]) {
        if (
          regex(matcher.pathPattern, 'pathPattern').test(relative) &&
          matcher.linePattern && regex(matcher.linePattern, 'linePattern').test(line)
        ) patterns.add(matcher.pattern)
      }
      for (const pattern of patterns) {
        const key = `${relative}\0${String(index + 1)}\0${pattern}`
        if (seenHits.has(key)) continue
        seenHits.add(key)
        hits.push({ path: relative, line: index + 1, pattern, text: line })
      }
    }
  }
  return hits
}

export function findSharedPresetReferences(root) {
  const candidates = ['renovate.json', '.github/renovate.json']
  const references = new Set()
  for (const relative of candidates) {
    const file = path.join(root, relative)
    if (!fs.existsSync(file)) continue
    const config = parseJsonDocument(fs.readFileSync(file, 'utf8'), relative)
    const extensions = Array.isArray(config.extends) ? config.extends : []
    for (const extension of extensions) {
      if (/^github>jasondockery\/renovate-config(?:#[^\s]+)?$/u.test(extension)) references.add(extension)
    }
  }
  return [...references].sort()
}

const PRESET_KEYS = new Set([
  '$schema',
  'description',
  'extends',
  'minimumReleaseAge',
  'internalChecksFilter',
  'packageRules',
  'prConcurrentLimit',
  'prHourlyLimit',
  'rebaseWhen',
  'labels',
  'vulnerabilityAlerts',
])
const PACKAGE_RULE_KEYS = new Set([
  'description',
  'matchDatasources',
  'matchUpdateTypes',
  'minimumReleaseAge',
  'internalChecksFilter',
])
const VULNERABILITY_KEYS = new Set([
  'enabled',
  'addLabels',
  'schedule',
  'minimumReleaseAge',
  'prHourlyLimit',
  'prConcurrentLimit',
  'prCreation',
  'automerge',
  'platformAutomerge',
])
const REVIEWED_EXTENDS = new Set(['config:best-practices', 'schedule:weekly'])

function failPresetShape(pathParts, detail) {
  const location = pathParts.length > 0 ? pathParts.join('.') : '<root>'
  throw new Error(`default.json key ${location} is not approved as extraction-neutral: ${detail}`)
}

function assertObject(value, pathParts) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    failPresetShape(pathParts, 'expected an object')
  }
}

function assertAllowedKeys(value, allowed, pathParts) {
  assertObject(value, pathParts)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) failPresetShape([...pathParts, key], 'unreviewed key')
  }
}

function assertString(value, pathParts, { nullable = false } = {}) {
  if ((nullable && value === null) || (typeof value === 'string' && value.length > 0)) return
  failPresetShape(pathParts, nullable ? 'expected a non-empty string or null' : 'expected a non-empty string')
}

function assertStringArray(value, pathParts) {
  if (!Array.isArray(value)) failPresetShape(pathParts, 'expected an array of strings')
  for (const [index, item] of value.entries()) assertString(item, [...pathParts, String(index)])
}

function assertNonnegativeInteger(value, pathParts) {
  if (!Number.isInteger(value) || value < 0) failPresetShape(pathParts, 'expected a nonnegative integer')
}

export function assertExtractionNeutralPreset(preset) {
  assertAllowedKeys(preset, PRESET_KEYS, [])
  if ('$schema' in preset) assertString(preset.$schema, ['$schema'])
  if ('description' in preset) assertStringArray(preset.description, ['description'])
  if ('extends' in preset) {
    assertStringArray(preset.extends, ['extends'])
    for (const extension of preset.extends) {
      if (!REVIEWED_EXTENDS.has(extension)) failPresetShape(['extends'], `unreviewed preset ${extension}`)
    }
  }
  if ('minimumReleaseAge' in preset) assertString(preset.minimumReleaseAge, ['minimumReleaseAge'])
  if ('internalChecksFilter' in preset) assertString(preset.internalChecksFilter, ['internalChecksFilter'])
  if ('prConcurrentLimit' in preset) assertNonnegativeInteger(preset.prConcurrentLimit, ['prConcurrentLimit'])
  if ('prHourlyLimit' in preset) assertNonnegativeInteger(preset.prHourlyLimit, ['prHourlyLimit'])
  if ('rebaseWhen' in preset) assertString(preset.rebaseWhen, ['rebaseWhen'])
  if ('labels' in preset) assertStringArray(preset.labels, ['labels'])
  if ('packageRules' in preset) {
    if (!Array.isArray(preset.packageRules)) failPresetShape(['packageRules'], 'expected an array')
    for (const [index, rule] of preset.packageRules.entries()) {
      const base = ['packageRules', String(index)]
      assertAllowedKeys(rule, PACKAGE_RULE_KEYS, base)
      if ('description' in rule) assertString(rule.description, [...base, 'description'])
      if ('matchDatasources' in rule) assertStringArray(rule.matchDatasources, [...base, 'matchDatasources'])
      if ('matchUpdateTypes' in rule) assertStringArray(rule.matchUpdateTypes, [...base, 'matchUpdateTypes'])
      if ('minimumReleaseAge' in rule) assertString(rule.minimumReleaseAge, [...base, 'minimumReleaseAge'])
      if ('internalChecksFilter' in rule) assertString(rule.internalChecksFilter, [...base, 'internalChecksFilter'])
    }
  }
  if ('vulnerabilityAlerts' in preset) {
    const alerts = preset.vulnerabilityAlerts
    assertAllowedKeys(alerts, VULNERABILITY_KEYS, ['vulnerabilityAlerts'])
    for (const key of ['enabled', 'automerge', 'platformAutomerge']) {
      if (key in alerts && typeof alerts[key] !== 'boolean') failPresetShape(['vulnerabilityAlerts', key], 'expected a boolean')
    }
    for (const key of ['addLabels', 'schedule']) {
      if (key in alerts) assertStringArray(alerts[key], ['vulnerabilityAlerts', key])
    }
    if ('minimumReleaseAge' in alerts) {
      assertString(alerts.minimumReleaseAge, ['vulnerabilityAlerts', 'minimumReleaseAge'], { nullable: true })
    }
    for (const key of ['prHourlyLimit', 'prConcurrentLimit']) {
      if (key in alerts) assertNonnegativeInteger(alerts[key], ['vulnerabilityAlerts', key])
    }
    if ('prCreation' in alerts) assertString(alerts.prCreation, ['vulnerabilityAlerts', 'prCreation'])
  }
}

export function assertSharedPresetExtractionNeutral(root = repositoryRoot) {
  const preset = parseJsonDocument(fs.readFileSync(path.join(root, 'default.json'), 'utf8'), 'default.json')
  assertExtractionNeutralPreset(preset)
}

export function extractRepository(root, resolvedSharedPreset, environment, run) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-repository-coverage-'))
  fs.chmodSync(temporary, 0o700)
  try {
    const env = extractionEnvironment(environment, temporary)
    const sharedPresetReferences = findSharedPresetReferences(root)
    if (sharedPresetReferences.length > 0) {
      env.RENOVATE_IGNORE_PRESETS = JSON.stringify(sharedPresetReferences)
      const resolvedPresetFile = path.join(temporary, 'resolved-shared-preset.json')
      fs.writeFileSync(resolvedPresetFile, `${JSON.stringify(resolvedSharedPreset, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
      env.RENOVATE_CONFIG_FILE = resolvedPresetFile
    }
    const result = run('renovate', extractionArguments(), {
      cwd: root,
      encoding: 'utf8',
      env,
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: 120_000,
    })
    if (result.error) throw new Error(`Renovate extraction could not start for ${root}: ${result.error.message}`)
    if (result.status !== 0) {
      throw new Error(`Renovate extraction exited ${String(result.status)} for ${root}: ${(result.stderr || result.stdout || '').trim()}`)
    }
    const tuples = parseExtractedDependencies(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)
      .map((tuple) => ({ ...tuple, packageFile: normalizePath(tuple.packageFile) }))
    if (tuples.length === 0) throw new Error(`Renovate returned no extracted dependencies for ${root}`)
    return tuples
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}

export async function checkRepositoryCoverage({
  targets = TARGETS,
  environment = process.env,
  run = spawnSync,
  output = console,
} = {}) {
  const expectedVersion = readRenovateVersion(repositoryRoot)
  const runtimeRoot = findPinnedRenovateRoot(environment)
  const runtimeManifest = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'package.json'), 'utf8'))
  if (runtimeManifest.version !== expectedVersion) throw new Error('PATH Renovate does not match .renovate-version')
  assertSharedPresetExtractionNeutral(repositoryRoot)
  const { resolveConfigPresets } = await importRenovateModule(runtimeRoot, 'config/presets/index.js')
  const sharedPreset = parseJsonDocument(fs.readFileSync(path.join(repositoryRoot, 'default.json'), 'utf8'), 'default.json')
  const { config: resolvedSharedPreset } = await resolveConfigPresets(
    structuredClone(sharedPreset),
    structuredClone(sharedPreset)
  )
  const allProblems = []
  const evidence = []
  for (const [repository, root] of targets) {
    const inventory = JSON.parse(fs.readFileSync(path.join(root, 'dependency-coverage.json'), 'utf8'))
    if (inventory.repository !== repository) allProblems.push(`${repository}: inventory names ${inventory.repository ?? '<missing>'}`)
    const tuples = extractRepository(root, resolvedSharedPreset, environment, run)
    const declarations = collectDeclaredDependencies(root, inventory)
    const scanHits = scanVersionConventions(root, inventory)
    const problems = collectCoverageProblems(inventory, tuples, scanHits, declarations)
    for (const problem of problems) allProblems.push(`${repository}: ${problem}`)
    evidence.push({ repository, tuples: tuples.length, declarations: declarations.length, scanHits: scanHits.length })
  }
  if (allProblems.length > 0) throw new Error(allProblems.join('\n'))
  for (const row of evidence) {
    output.log(
      `ok: ${row.repository} matched ${row.declarations} independent declarations to ` +
      `${row.tuples} extracted dependencies and mapped ${row.scanHits} version conventions`
    )
  }
  output.log(`RENOVATE_COVERAGE_EVIDENCE ${JSON.stringify(evidence)}`)
  return { ok: true, version: expectedVersion, evidence }
}

if (isMainModule(import.meta.url)) {
  try {
    await checkRepositoryCoverage()
  } catch (error) {
    console.error(`repository dependency coverage failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
