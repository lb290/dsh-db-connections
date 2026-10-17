/**
 * Display-metadata test: the plugin's name and description must localize in the
 * plugin list, and must satisfy the harness's own resolution rules.
 *
 * The harness reads `<package>/locale/en.json` through the package export map,
 * then discovers sibling `*.json` dictionaries in that same directory. Two rules
 * fail the whole metadata read, so they are asserted here: every filename must be
 * a bare lowercased language id, and every resolved file must share the English
 * locale's directory.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` -> ${detail}`}`)
  if (!ok) failures += 1
}

const dir = path.dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(fs.readFileSync(path.join(dir, '..', 'package.json'), 'utf8'))

// The English dictionary is found through the export map, so this export is what
// makes localization work at all.
check('exports the locale directory', pkg.exports?.['./locale/*.json'] === './locale/*.json',
  JSON.stringify(pkg.exports?.['./locale/*.json']))
check('ships the locale directory', fs.existsSync(path.join(dir, '..', 'locale')))

// The harness only looks for en.json by name; zh.json is discovered as a sibling.
check('locale/en.json exists', fs.existsSync(path.join(dir, '..', 'locale/en.json')))
check('locale/zh.json exists', fs.existsSync(path.join(dir, '..', 'locale/zh.json')))

// A filename that is not a bare language id throws and loses ALL metadata.
const LANGUAGE_ID = /^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/u
for (const name of fs.readdirSync(path.join(dir, '..', 'locale'))) {
  check(`locale/${name} is a language id`, name.endsWith('.json') && LANGUAGE_ID.test(name.slice(0, -5)),
    name)
}

// Every dictionary must carry a `meta` object with title and description.
const dictionaries = {}
for (const name of fs.readdirSync(path.join(dir, '..', 'locale'))) {
  const language = name.slice(0, -5).toLowerCase()
  const parsed = JSON.parse(fs.readFileSync(path.join(dir, '..', 'locale', name), 'utf8'))
  dictionaries[language] = parsed.meta
  check(`locale/${name} carries meta.title`, typeof parsed.meta?.title === 'string' && parsed.meta.title.length > 0)
  check(`locale/${name} carries meta.description`,
    typeof parsed.meta?.description === 'string' && parsed.meta.description.length > 0)
}

// The translation map keeps `en` as the fallback, so an English description must
// also be present in package.json for the non-localized case.
check('package.json carries an English description',
  typeof pkg.description === 'string' && pkg.description.length > 0)
check('the English dictionary matches the package description',
  dictionaries.en.description === pkg.description,
  dictionaries.en.description === pkg.description ? '' : 'they differ; the list would show two different texts')

// The Chinese title must actually be Chinese, not a copy of the English one.
check('the zh title is localized', /[\u4e00-\u9fff]/u.test(dictionaries.zh.title), dictionaries.zh.title)
check('the zh description is localized', /[\u4e00-\u9fff]/u.test(dictionaries.zh.description))

// --- resolve exactly the way the harness does, through the export map ---
// Self-reference resolution: resolving this package's own name from inside it
// exercises the same export map the harness reads the locale files through.
const require = createRequire(path.join(dir, '..', 'package.json'))
let englishPath
try {
  englishPath = require.resolve('dsh-db-connections/locale/en.json')
  check('the harness can resolve en.json through the export map', true, englishPath)
} catch (error) {
  check('the harness can resolve en.json through the export map', false, error.code)
  process.exit(1)
}

// Every sibling must resolve too, and land in the English dictionary's directory.
const englishDir = path.dirname(englishPath)
for (const name of fs.readdirSync(path.join(dir, '..', 'locale'))) {
  let resolved
  try {
    resolved = require.resolve(`dsh-db-connections/locale/${name}`)
  } catch (error) {
    check(`locale/${name} resolves through the export map`, false, error.code)
    continue
  }
  check(`locale/${name} resolves through the export map`, true, resolved)
  check(`locale/${name} shares the English locale directory`,
    path.dirname(resolved) === englishDir, path.dirname(resolved))
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
