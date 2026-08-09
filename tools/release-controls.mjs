#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { isMainModule } from './is-main.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DESIRED_PATH = 'tools/release-controls.json'
const RELEASE_PATTERN = 'refs/tags/[0-9]*.[0-9]*.[0-9]*'
const RELEASE_SCRIPTS = Object.freeze({
  'release:controls:check': 'node tools/release-controls.mjs check',
  'release:controls:apply': 'node tools/release-controls.mjs apply',
  'release:preflight': 'node tools/release-preflight.mjs',
  'release:verify': 'node tools/release-verify.mjs',
})

export function readDesiredReleaseControls(root = repositoryRoot) {
  return JSON.parse(fs.readFileSync(path.join(root, DESIRED_PATH), 'utf8'))
}

export function collectDesiredReleaseControlProblems(desired) {
  const problems = []
  if (desired?.schema !== 'renovate-config.release-controls' || desired?.schemaVersion !== 1) {
    problems.push('release controls must use schema renovate-config.release-controls version 1')
  }
  if (desired?.repository !== 'jasondockery/renovate-config') {
    problems.push('release controls must target jasondockery/renovate-config')
  }
  if (desired?.apiVersion !== '2026-03-10') {
    problems.push('release controls must pin GitHub API version 2026-03-10')
  }
  if (desired?.immutableReleases?.enabled !== true) {
    problems.push('immutable GitHub Releases must be enabled')
  }

  const ruleset = desired?.tagRuleset
  if (ruleset?.name !== 'immutable-release-tags') {
    problems.push('release tag ruleset must use the canonical immutable-release-tags name')
  }
  if (ruleset?.target !== 'tag' || ruleset?.enforcement !== 'active') {
    problems.push('release tag ruleset must be active and target tags')
  }
  if (!Array.isArray(ruleset?.bypassActors) || ruleset.bypassActors.length !== 0) {
    problems.push('release tag ruleset must not declare bypass actors')
  }
  if (
    JSON.stringify(ruleset?.conditions?.refName?.include) !== JSON.stringify([RELEASE_PATTERN]) ||
    JSON.stringify(ruleset?.conditions?.refName?.exclude) !== JSON.stringify([])
  ) {
    problems.push(`release tag ruleset must target only ${RELEASE_PATTERN}`)
  }
  const ruleTypes = ruleset?.rules?.map(({ type }) => type)
  if (JSON.stringify(ruleTypes) !== JSON.stringify(['update', 'deletion'])) {
    problems.push('release tag ruleset must restrict updates and deletions without restricting creation')
  }
  if (ruleset?.rules?.some((rule) => Object.keys(rule).length !== 1)) {
    problems.push('release tag rules must contain only their canonical type')
  }
  return problems
}

export function collectReleaseDocumentationProblems({ charter, contributing, roadmap }) {
  const problems = []
  if (!charter.includes('immutable GitHub Release') || !charter.includes('defense in depth')) {
    problems.push('CHARTER.md must define immutable GitHub Releases and the tag ruleset defense in depth')
  }
  for (const command of [
    'release:controls:check',
    'release:controls:apply -- --confirm-owner-admin',
    'release:preflight -- --version <version> --expected-sha <40-char-sha>',
    'release:verify -- --version <version> --expected-sha <40-char-sha>',
  ]) {
    if (!contributing.includes(command)) {
      problems.push(`CONTRIBUTING.md must document ${command}`)
    }
  }
  if (
    !roadmap.includes('- [ ] 2b. Owner action:') ||
    !roadmap.includes('- [ ] 2c. Record a passing') ||
    !roadmap.includes('No release tag is created')
  ) {
    problems.push('ROADMAP.md must keep live control application open and prohibit a bootstrap tag')
  }
  return problems
}

export function collectReleaseControlContractProblems(root = repositoryRoot) {
  let desired
  let manifest
  const problems = []
  try {
    desired = readDesiredReleaseControls(root)
  } catch (error) {
    return [`cannot read ${DESIRED_PATH}: ${error instanceof Error ? error.message : String(error)}`]
  }
  problems.push(...collectDesiredReleaseControlProblems(desired))
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  } catch (error) {
    problems.push(`cannot read package.json: ${error instanceof Error ? error.message : String(error)}`)
    return problems
  }
  for (const [name, command] of Object.entries(RELEASE_SCRIPTS)) {
    if (manifest?.scripts?.[name] !== command) {
      problems.push(`package.json#scripts.${name} must be ${JSON.stringify(command)}`)
    }
  }
  try {
    problems.push(...collectReleaseDocumentationProblems({
      charter: fs.readFileSync(path.join(root, 'CHARTER.md'), 'utf8'),
      contributing: fs.readFileSync(path.join(root, 'CONTRIBUTING.md'), 'utf8'),
      roadmap: fs.readFileSync(path.join(root, 'ROADMAP.md'), 'utf8'),
    }))
  } catch (error) {
    problems.push(`cannot read release documentation: ${error instanceof Error ? error.message : String(error)}`)
  }
  return problems
}

function rulesetRequest(desired) {
  const ruleset = desired.tagRuleset
  return {
    name: ruleset.name,
    target: ruleset.target,
    enforcement: ruleset.enforcement,
    bypass_actors: ruleset.bypassActors,
    conditions: {
      ref_name: {
        include: ruleset.conditions.refName.include,
        exclude: ruleset.conditions.refName.exclude,
      },
    },
    rules: ruleset.rules,
  }
}

function normalizedObservedRuleset(ruleset) {
  return {
    name: ruleset?.name,
    target: ruleset?.target,
    enforcement: ruleset?.enforcement,
    bypass_actors: ruleset?.bypass_actors ?? [],
    conditions: {
      ref_name: {
        include: ruleset?.conditions?.ref_name?.include ?? [],
        exclude: ruleset?.conditions?.ref_name?.exclude ?? [],
      },
    },
    rules: (ruleset?.rules ?? []).map(({ type }) => ({ type })),
  }
}

export function collectReleaseControlDrift(desired, observed) {
  const problems = collectDesiredReleaseControlProblems(desired)
  if (observed?.immutableReleases?.enabled !== true) {
    problems.push('GitHub immutable releases are disabled')
  }
  if (observed?.rulesets?.length !== 1) {
    problems.push(`expected exactly one ${desired?.tagRuleset?.name} ruleset; found ${observed?.rulesets?.length ?? 0}`)
  } else if (
    JSON.stringify(normalizedObservedRuleset(observed.rulesets[0])) !==
    JSON.stringify(rulesetRequest(desired))
  ) {
    problems.push(`${desired.tagRuleset.name} ruleset differs from checked-in desired state`)
  }
  return problems
}

export function createGithubApiClient(apiVersion, run = spawnSync) {
  function request(method, endpoint, body) {
    const arguments_ = [
      'api',
      '--method',
      method,
      '-H',
      'Accept: application/vnd.github+json',
      '-H',
      `X-GitHub-Api-Version: ${apiVersion}`,
      endpoint,
    ]
    if (body !== undefined) arguments_.push('--input', '-')
    const result = run('gh', arguments_, {
      encoding: 'utf8',
      input: body === undefined ? undefined : JSON.stringify(body),
      maxBuffer: 4 * 1024 * 1024,
      timeout: 30_000,
    })
    if (result.error) throw result.error
    if (result.status !== 0) {
      throw new Error(`gh api ${method} ${endpoint} failed: ${(result.stderr || result.stdout || 'no output').trim()}`)
    }
    if (!result.stdout?.trim()) return undefined
    return JSON.parse(result.stdout)
  }
  return {
    downloadArtifact(runId, name, directory, repository) {
      const result = run(
        'gh',
        ['run', 'download', String(runId), '--repo', repository, '--name', name, '--dir', directory],
        { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 60_000 }
      )
      if (result.error) throw result.error
      if (result.status !== 0) {
        throw new Error(`gh run download ${runId} failed: ${(result.stderr || result.stdout || 'no output').trim()}`)
      }
    },
    get: (endpoint) => request('GET', endpoint),
    post: (endpoint, body) => request('POST', endpoint, body),
    put: (endpoint, body) => request('PUT', endpoint, body),
  }
}

export async function readLiveReleaseControls(
  desired,
  client = createGithubApiClient(desired.apiVersion)
) {
  const repository = `repos/${desired.repository}`
  const immutableReleases = await client.get(`${repository}/immutable-releases`)
  const summaries = await client.get(`${repository}/rulesets?includes_parents=false&targets=tag&per_page=100`)
  const matches = (summaries ?? []).filter(({ name }) => name === desired.tagRuleset.name)
  const rulesets = []
  for (const match of matches) rulesets.push(await client.get(`${repository}/rulesets/${match.id}`))
  return { immutableReleases, rulesets }
}

export function planReleaseControlMutations(desired, observed) {
  const desiredProblems = collectDesiredReleaseControlProblems(desired)
  if (desiredProblems.length > 0) throw new Error(desiredProblems.join('; '))
  if ((observed?.rulesets?.length ?? 0) > 1) {
    throw new Error(`refusing to mutate duplicate ${desired.tagRuleset.name} rulesets`)
  }
  const mutations = []
  if (observed?.immutableReleases?.enabled !== true) {
    mutations.push({ method: 'PUT', endpoint: `repos/${desired.repository}/immutable-releases` })
  }
  const body = rulesetRequest(desired)
  if (observed?.rulesets?.length === 0) {
    mutations.push({ method: 'POST', endpoint: `repos/${desired.repository}/rulesets`, body })
  } else if (collectReleaseControlDrift(desired, { ...observed, immutableReleases: { enabled: true } }).length > 0) {
    mutations.push({
      method: 'PUT',
      endpoint: `repos/${desired.repository}/rulesets/${observed.rulesets[0].id}`,
      body,
    })
  }
  return mutations
}

function receipt(mode, desired, observed, mutations = []) {
  const drift = collectReleaseControlDrift(desired, observed)
  return {
    schema: 'renovate-config.release-controls-receipt',
    schemaVersion: 1,
    mode,
    repository: desired.repository,
    result: drift.length === 0 ? 'passed' : 'failed',
    immutableReleases: observed.immutableReleases,
    ruleset: observed.rulesets[0]
      ? { id: observed.rulesets[0].id, name: observed.rulesets[0].name }
      : null,
    mutations,
    drift,
  }
}

export async function checkReleaseControls({ desired = readDesiredReleaseControls(), client } = {}) {
  const observed = await readLiveReleaseControls(desired, client)
  return receipt('check', desired, observed)
}

export async function applyReleaseControls({ desired = readDesiredReleaseControls(), client } = {}) {
  const activeClient = client ?? createGithubApiClient(desired.apiVersion)
  const before = await readLiveReleaseControls(desired, activeClient)
  const mutations = planReleaseControlMutations(desired, before)
  for (const mutation of mutations) {
    if (mutation.method === 'POST') await activeClient.post(mutation.endpoint, mutation.body)
    else await activeClient.put(mutation.endpoint, mutation.body)
  }
  const after = await readLiveReleaseControls(desired, activeClient)
  return receipt('apply', desired, after, mutations.map(({ method, endpoint }) => ({ method, endpoint })))
}

function usage() {
  return [
    'usage: node tools/release-controls.mjs validate',
    'usage: node tools/release-controls.mjs check',
    '       node tools/release-controls.mjs apply --confirm-owner-admin',
  ].join('\n')
}

export function parseReleaseControlsArguments(arguments_) {
  if (arguments_.length === 1 && ['validate', 'check'].includes(arguments_[0])) {
    return { mode: arguments_[0] }
  }
  if (
    arguments_.length === 2 &&
    arguments_[0] === 'apply' &&
    arguments_[1] === '--confirm-owner-admin'
  ) {
    return { mode: 'apply' }
  }
  throw new Error(usage())
}

if (isMainModule(import.meta.url)) {
  try {
    const { mode } = parseReleaseControlsArguments(process.argv.slice(2))
    let result
    if (mode === 'validate') {
      const problems = collectReleaseControlContractProblems()
      result = {
        schema: 'renovate-config.release-controls-validation',
        schemaVersion: 1,
        result: problems.length === 0 ? 'passed' : 'failed',
        problems,
      }
    } else if (mode === 'check') {
      result = await checkReleaseControls()
    } else if (mode === 'apply') {
      result = await applyReleaseControls()
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    if (result.result !== 'passed') process.exitCode = 1
  } catch (error) {
    process.stderr.write(`release controls: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
