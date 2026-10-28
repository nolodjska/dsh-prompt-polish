/**
 * Run every test harness in this directory and report a single exit code.
 * Each harness is a standalone ESM script that prints its own results and exits
 * non-zero on the first failed assertion.
 */
import { readdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const files = (await readdir(here))
  .filter((name) => name.endsWith('.mjs') && name !== 'run-all.mjs')
  .sort()

/** Run one harness to completion. */
function run(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, file)], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    child.on('close', (code) => resolve({ file, code: code ?? 1, output }))
  })
}

let failed = 0
for (const file of files) {
  const result = await run(file)
  const lines = result.output.trim().split('\n')
  const summary = lines.filter((line) => /checks passed|ALL PASS|exitCode/.test(line)).pop() ?? lines.pop() ?? ''
  const ok = result.code === 0
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${file.padEnd(26)} ${summary.trim()}`)
  if (!ok) console.log(result.output)
}

console.log(failed === 0 ? `\nall ${files.length} harnesses passed` : `\n${failed} of ${files.length} harnesses failed`)
process.exit(failed === 0 ? 0 : 1)
