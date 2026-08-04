// One implementation of the receipt write used by every authoritative
// producer in this repository. Receipts are evidence: a partially written
// receipt must never be readable, so the payload lands on a private temporary
// name and is renamed into place only once it is complete.
//
// `wx` refuses an existing temporary file rather than reusing it, and the
// temporary is removed on every path so a failed write leaves no debris that a
// later run could mistake for output.
import fs from 'node:fs'
import process from 'node:process'

export function writeAtomicFile(file, contents) {
  const temporary = `${file}.tmp-${process.pid}`
  try {
    fs.writeFileSync(temporary, contents, { flag: 'wx' })
    fs.renameSync(temporary, file)
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
  }
}

export function writeAtomicJson(file, value) {
  writeAtomicFile(file, `${JSON.stringify(value, null, 2)}\n`)
}
