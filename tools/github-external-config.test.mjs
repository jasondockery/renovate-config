import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { collectGithubExternalConfigViolations } from './github-external-config.mjs'

const root = path.resolve(import.meta.dirname, '..')

test('the App variable and secret resolve through every structured delivery', () => {
  assert.deepEqual(collectGithubExternalConfigViolations(root), [])
})

test('an environment delivery fails when its consuming job loses the environment', () => {
  const fixture = fixtureRoot()
  try {
    workflow(
      fixture,
      'renovate.yml',
      'jobs:\n  renovate:\n    env:\n      APP: ${{ vars.RENOVATE_APP_CLIENT_ID }}\n'
    )
    registry(fixture, {
      RENOVATE_APP_CLIENT_ID: credential([
        directDelivery('vars.RENOVATE_APP_CLIENT_ID', 'variable', ['.github/workflows/renovate.yml']),
      ]),
    })
    assert.deepEqual(collectGithubExternalConfigViolations(fixture), [
      '.github/workflows/renovate.yml: vars.RENOVATE_APP_CLIENT_ID must be used by a job in environment renovate; found none.',
    ])
  } finally {
    fs.rmSync(fixture, { force: true, recursive: true })
  }
})

test('workflow_call variable input and secret are distinct, fully checked deliveries', () => {
  const fixture = fixtureRoot()
  try {
    workflow(
      fixture,
      'security.yml',
      [
        'on:',
        '  workflow_call:',
        '    inputs:',
        '      RENOVATE_APP_CLIENT_ID:',
        '        required: true',
        '        type: string',
        '    secrets:',
        '      RENOVATE_APP_PRIVATE_KEY:',
        '        required: true',
        'jobs:',
        '  report:',
        '    env:',
        '      APP: ${{ inputs.RENOVATE_APP_CLIENT_ID }}',
        '      KEY: ${{ secrets.RENOVATE_APP_PRIVATE_KEY }}',
      ].join('\n')
    )
    registry(fixture, {
      RENOVATE_APP_CLIENT_ID: credential([
        callerDelivery('workflow_call_input', 'RENOVATE_APP_CLIENT_ID', 'variable'),
      ]),
      RENOVATE_APP_PRIVATE_KEY: credential([
        callerDelivery('workflow_call_secret', 'RENOVATE_APP_PRIVATE_KEY', 'secret'),
      ]),
    })
    assert.deepEqual(collectGithubExternalConfigViolations(fixture), [])
  } finally {
    fs.rmSync(fixture, { force: true, recursive: true })
  }
})

test('undeclared caller secrets and unused required caller inputs fail closed', () => {
  const fixture = fixtureRoot()
  try {
    workflow(
      fixture,
      'security.yml',
      [
        'on:',
        '  workflow_call:',
        '    inputs:',
        '      RENOVATE_APP_CLIENT_ID:',
        '        required: true',
        '        type: string',
        '    secrets:',
        '      UNREGISTERED_KEY:',
        '        required: true',
        'jobs:',
        '  report:',
        '    env:',
        "      LABEL: ${{ 'inputs.RENOVATE_APP_CLIENT_ID is no longer used' }}",
        '      KEY: ${{ secrets.UNREGISTERED_KEY }}',
      ].join('\n')
    )
    registry(fixture, {
      RENOVATE_APP_CLIENT_ID: credential([
        callerDelivery('workflow_call_input', 'RENOVATE_APP_CLIENT_ID', 'variable'),
      ]),
    })
    const violations = collectGithubExternalConfigViolations(fixture)
    assert.ok(
      violations.includes(
        '.github/workflows/security.yml: workflow_call secret UNREGISTERED_KEY has no registered caller delivery.'
      )
    )
    assert.ok(
      violations.includes(
        '.github/workflows/security.yml: required workflow_call input RENOVATE_APP_CLIENT_ID is not used.'
      )
    )
  } finally {
    fs.rmSync(fixture, { force: true, recursive: true })
  }
})

test('a job environment cannot shadow a caller-delivered secret', () => {
  const fixture = fixtureRoot()
  try {
    workflow(
      fixture,
      'security.yml',
      [
        'on:',
        '  workflow_call:',
        '    secrets:',
        '      RENOVATE_APP_PRIVATE_KEY:',
        '        required: true',
        'jobs:',
        '  report:',
        '    environment: renovate',
        '    env:',
        '      KEY: ${{ secrets.RENOVATE_APP_PRIVATE_KEY }}',
      ].join('\n')
    )
    registry(fixture, {
      RENOVATE_APP_PRIVATE_KEY: credential([
        callerDelivery('workflow_call_secret', 'RENOVATE_APP_PRIVATE_KEY', 'secret'),
      ]),
    })

    assert.deepEqual(collectGithubExternalConfigViolations(fixture), [
      '.github/workflows/security.yml: secrets.RENOVATE_APP_PRIVATE_KEY is a workflow_call secret consumed by a job with environment renovate; environment secret shadowing is forbidden.',
    ])
  } finally {
    fs.rmSync(fixture, { force: true, recursive: true })
  }
})

test('delivery types reject fields that belong to another delivery mechanism', () => {
  const fixture = fixtureRoot()
  try {
    workflow(
      fixture,
      'renovate.yml',
      'jobs:\n  renovate:\n    environment: renovate\n    env:\n      APP: ${{ vars.RENOVATE_APP_CLIENT_ID }}\n'
    )
    const delivery = directDelivery('vars.RENOVATE_APP_CLIENT_ID', 'variable', [
      '.github/workflows/renovate.yml',
    ])
    delivery.sourceScopes = ['repository']
    registry(fixture, { RENOVATE_APP_CLIENT_ID: credential([delivery]) })

    assert.ok(
      collectGithubExternalConfigViolations(fixture).includes(
        'Delivery RENOVATE_APP_CLIENT_ID/central-runner field sourceScopes is not valid for direct delivery.'
      )
    )
  } finally {
    fs.rmSync(fixture, { force: true, recursive: true })
  }
})

function fixtureRoot() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-github-config-'))
  fs.mkdirSync(path.join(fixture, '.github/workflows'), { recursive: true })
  fs.mkdirSync(path.join(fixture, 'tools'), { recursive: true })
  return fixture
}

function workflow(fixture, name, source) {
  fs.writeFileSync(path.join(fixture, '.github/workflows', name), `${source}\n`)
}

function registry(fixture, credentials) {
  fs.writeFileSync(
    path.join(fixture, 'tools/github-external-config.json'),
    JSON.stringify({
      capabilities: { app: { description: 'GitHub App.', owner: 'automation' } },
      credentials,
    })
  )
}

function credential(deliveries) {
  return {
    capability: 'app',
    owner: 'automation',
    purpose: 'App identity.',
    deliveries,
  }
}

function directDelivery(reference, kind, workflows) {
  return {
    consumer: 'central-runner',
    delivery: 'direct',
    environment: 'renovate',
    kind,
    reference,
    required: true,
    scope: 'environment',
    sensitive: kind === 'secret',
    workflows,
  }
}

function callerDelivery(delivery, input, kind) {
  return {
    consumer: 'security-hygiene-caller',
    delivery,
    input,
    kind,
    required: true,
    sensitive: kind === 'secret',
    sourceScopes: ['repository', 'organization'],
    workflows: ['.github/workflows/security.yml'],
  }
}
