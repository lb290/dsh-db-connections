/**
 * Call the harness's OWN `readPluginMeta` to prove the plugin list will show
 * localized text.
 *
 * Hand-checking the JSON would only prove the files exist; the harness's reader
 * has rules of its own (exact `en.json` filename, export-map resolution, sibling
 * directory containment, bare language ids) that fail the WHOLE metadata read
 * when violated. This runs that reader.
 */
// The harness's own @deepseek-ai module directory; override with
// DSH_RUNTIME_MODULES when your install path differs.
const RUNTIME = process.env.DSH_RUNTIME_MODULES
  ?? 'file:///D:/Program%20Files/nodejs/node_global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const { readPluginMeta } = await import(`${RUNTIME}/dsh-app-boot/lib/index.js`)

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` -> ${detail}`}`)
  if (!ok) failures += 1
}

// The Owning Loader tree's resolution base: the profile directory.
// Override with DSH_PROFILE_BASE when your profile lives elsewhere.
const base = process.env.DSH_PROFILE_BASE ?? 'file:///C:/Users/admin/.dsh/profiles/desktop/'

let meta
try {
  meta = readPluginMeta('dsh-db-connections', base)
} catch (error) {
  check('readPluginMeta returns', false, error.message)
  process.exit(1)
}

console.log('\nresolved metadata:')
console.log(JSON.stringify(meta, null, 2))

check('readPluginMeta returns metadata', meta !== undefined && meta !== null)
check('no metadata error reported', meta?.error === undefined, meta?.error ?? '')
check('title is localized', typeof meta?.title === 'object' && meta.title !== null,
  JSON.stringify(meta?.title))
check('description is localized', typeof meta?.description === 'object' && meta.description !== null)
check('title carries a zh translation', /[\u4e00-\u9fff]/u.test(meta?.title?.zh ?? ''), meta?.title?.zh)
check('description carries a zh translation', /[\u4e00-\u9fff]/u.test(meta?.description?.zh ?? ''))
check('title keeps an English fallback', typeof meta?.title?.en === 'string' && meta.title.en.length > 0,
  meta?.title?.en)
// `en` is the dictionary's own English entry, which takes precedence over the
// package name; the name is only the fallback when no English dictionary exists.
check('the en entry comes from the dictionary', meta?.title?.en === 'Databases', meta?.title?.en)

// The icon is read from package.json and inlined as a data URL.
check('the icon resolved to a data URL', typeof meta?.icon === 'string' && meta.icon.startsWith('data:image/'),
  typeof meta?.icon === 'string' ? meta.icon.slice(0, 30) : String(meta?.icon))

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
