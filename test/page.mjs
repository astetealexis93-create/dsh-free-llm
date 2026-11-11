/**
 * Page check: the plugin's own page in the running IDE.
 *
 * The dashboard is the part a person looks at, so it gets checked on the
 * screen and not only in the JSON: the routes with their colours, the usage
 * summary and the table of turns. The turn the IDE spends naming a session
 * must not show up as a failed turn, and a row with a strange model must not
 * take the whole page down.
 *
 *   node test/page.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CDP_PORT = process.env.DSH_CDP_PORT ?? '9222'
const ARTIFACTS = join(homedir(), 'AppData', 'Local', 'Temp', 'dsh-free-llm-ui')
mkdirSync(ARTIFACTS, { recursive: true })

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
const page = targets.find((target) => target.type === 'page')
if (!page) {
  console.error(`no IDE page on the debug port ${CDP_PORT}`)
  process.exit(2)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
let nextId = 0
const pending = new Map()
const errors = []
const send = (method, params = {}, ms = 20000) => {
  const id = ++nextId
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve({ __timeout: true })
    }, ms)
    pending.set(id, (result) => {
      clearTimeout(timer)
      resolve(result)
    })
  })
}
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.method === 'Runtime.exceptionThrown') {
    errors.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text ?? '')
  }
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message.result)
    pending.delete(message.id)
  }
})
await new Promise((resolve) => ws.addEventListener('open', resolve))
await send('Runtime.enable')

const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result?.exceptionDetails) {
    console.error('the page answered with an error:', JSON.stringify(result.exceptionDetails).slice(0, 300))
  }
  return result?.result?.value
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// The page lives in the plugins panel, in the card of the plugin.
await evaluate(`(() => {
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  const button = [...document.querySelectorAll('button')].find((n) => /Complementos/i.test(n.getAttribute('aria-label') || n.textContent || ''))
  button?.click()
  return 'ok'
})()`)
let opened = false
for (let attempt = 0; attempt < 12 && !opened; attempt += 1) {
  await sleep(2000)
  opened = await evaluate(`(() => {
  const card = [...document.querySelectorAll('button')].find((n) => (n.textContent || '').trim() === 'IAs gratuitas (CLI)')
  if (!card) return false
  card.click()
  return true
})()`)
}
if (!opened) {
  console.error('the plugins panel has no card for the plugin')
  process.exit(2)
}

// The page asks every CLI whether it has a session, so the usage block can
// take a while to arrive.
let view = null
for (let attempt = 0; attempt < 15; attempt += 1) {
  view = await evaluate(`(() => {
  const text = document.body.innerText || ''
  const summary = (text.match(/[\\d]+ turnos ·[^\\n]*/) || [''])[0]
  const rows = [...document.querySelectorAll('tr')].map((row) => (row.innerText || '').replace(/\\s+/g, ' ').trim()).filter(Boolean)
  return {
    summary,
    rows,
    routes: [...document.querySelectorAll('span')].map((n) => (n.textContent || '').trim())
      .filter((n) => /^(Kilo Code|OpenCode|Clixad|Copilot|Grok|Qoder CLI)$/.test(n)),
  }
})()`)
  if (view.summary) break
  await sleep(5000)
}

const shot = await send('Page.captureScreenshot', { format: 'png' })
if (shot?.data) writeFileSync(join(ARTIFACTS, 'pagina-plugin.png'), Buffer.from(shot.data, 'base64'))

console.log('proveedores en la pagina:', [...new Set(view.routes)].join(', ') || '(ninguno)')
console.log('resumen de uso:', view.summary || '(vacio)')
console.log(`filas de la tabla: ${view.rows.length}`)
for (const row of view.rows.slice(0, 5)) console.log('  -', row.slice(0, 110))
if (errors.length) console.log(`errores en la consola: ${errors.length} -> ${errors[0].slice(0, 160)}`)

const auxiliaryRows = view.rows.filter((row) => /SESSION_TITLE|auxiliar/i.test(row))
const ok =
  view.summary.includes('turnos') &&
  view.rows.length > 0 &&
  auxiliaryRows.length === 0 &&
  errors.length === 0
console.log(
  ok
    ? 'RESULTADO: ok'
    : `RESULTADO: FALLA (${auxiliaryRows.length} filas auxiliares, ${errors.length} errores)`,
)
ws.close()
process.exit(ok ? 0 : 1)
