import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { validateReportPath } from './validate-renovate-compatibility.mjs'

test('compatibility report cannot be written into any tested repository', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renovate-report-boundary-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const repositories = ['renovate-config', 'roost', 'groundwork'].map((name) => {
    const directory = path.join(root, name)
    fs.mkdirSync(directory)
    return directory
  })
  const reportRoot = path.join(root, 'receipts')
  fs.mkdirSync(reportRoot)

  for (const repository of repositories) {
    assert.throws(
      () => validateReportPath(path.join(repository, 'compatibility.json'), repositories),
      /outside every tested repository/
    )
  }
  assert.equal(
    validateReportPath(path.join(reportRoot, 'compatibility.json'), repositories),
    path.join(fs.realpathSync(reportRoot), 'compatibility.json')
  )

  const redirected = path.join(root, 'redirected')
  fs.symlinkSync(repositories[1], redirected)
  assert.throws(
    () => validateReportPath(path.join(redirected, 'compatibility.json'), repositories),
    /outside every tested repository/
  )
})
