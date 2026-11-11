/**
 * Field check: one real turn per route, in the running IDE.
 *
 * The IDE has to be open with the debug port on. Every route gets its own
 * session, its own model and its own prompt, and the verdict comes from the
 * usage ledger the plugin writes plus the screen of the IDE.
 *
 *   node test/field.mjs                # every route
 *   node test/field.mjs kilo qoder     # two routes
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const providers = process.argv.slice(2).length ? process.argv.slice(2) : ['kilo', 'opencode', 'clixad', 'copilot', 'grok', 'qoder']
const timeout = process.env.DSH_FIELD_TIMEOUT ?? '300'

const results = []
for (const provider of providers) {
  console.log(`\n=== ${provider} ===`)
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, 'ui.mjs'), '--provider', provider, '--pick', '0', '--timeout', timeout], {
      stdio: 'inherit',
    })
    child.on('close', resolve)
  })
  results.push({ provider, ok: code === 0 })
}

console.log('\n=== resumen ===')
for (const result of results) console.log(`${result.ok ? 'ok  ' : 'FALLA'} ${result.provider}`)
const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} rutas contestan en la IDE`)
process.exit(failed.length === 0 ? 0 : 1)
