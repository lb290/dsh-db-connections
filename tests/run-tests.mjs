/**
 * Run every test-*.mjs in this directory and report one summary.
 *
 * The suites are plain scripts rather than a framework, so this runner is the
 * only thing `npm test` needs: each file is spawned with the environment
 * inherited (so `DSH_RUNTIME_MODULES`, `DB_TEST_*`, and `DSH_PROFILE_DIR` reach
 * it), and a non-zero exit marks the whole run failed.
 *
 * A suite that needs something this machine does not have — the harness runtime
 * modules, a reachable database, an installed profile — prints SKIP and exits 0,
 * so a missing prerequisite is visible instead of being reported as a defect.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = path.dirname(fileURLToPath(import.meta.url))
const files = fs.readdirSync(directory).filter(name => /^test-.*\.mjs$/u.test(name)).sort()

if (files.length === 0) {
  console.error('no test files found')
  process.exit(1)
}

/**
 * Run one suite to completion.
 * @param {string} file - the suite filename.
 * @returns {Promise<{ file: string, code: number, skipped: boolean }>} the outcome.
 */
function run(file) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [file], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.on('close', code => {
      const skipped = /^SKIP\b/mu.test(output)
      if (code !== 0 || process.env.TEST_VERBOSE === '1') {
        process.stdout.write(`\n─── ${file} ───\n${output}`)
      }
      const tail = output.trim().split('\n').filter(Boolean).at(-1) ?? ''
      console.log(`${code === 0 ? (skipped ? 'SKIP' : 'PASS') : 'FAIL'}  ${file}${tail === '' ? '' : `  ${tail}`}`)
      resolve({ file, code: code ?? 1, skipped })
    })
  })
}

const results = []
for (const file of files) results.push(await run(file))

const failed = results.filter(result => result.code !== 0)
const skipped = results.filter(result => result.code === 0 && result.skipped)
console.log(`\n${results.length - failed.length}/${results.length} suites passed${skipped.length === 0 ? '' : `, ${skipped.length} skipped for a missing prerequisite`}`)
process.exit(failed.length === 0 ? 0 : 1)
