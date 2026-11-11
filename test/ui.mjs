/**
 * Ground check: one real turn in the IDE, through the host, on one route.
 *
 * The contract test talks to the adapter directly, so it never sees the part
 * that breaks in the field: the host reading the catalog and the exact-model
 * metadata. This probe drives the running IDE instead — new session, model
 * picker, one prompt — and then reads the usage ledger the plugin writes, so
 * the verdict comes from the turn itself and not from the screen.
 *
 *   node test/ui.mjs --provider kilo --pick 0
 *   node test/ui.mjs --provider qoder --pick 3 --timeout 240
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CDP_PORT = process.env.DSH_CDP_PORT ?? '9222'
const PROMPT = process.env.DSH_UI_PROMPT ?? 'responde solo: OK'
const ARTIFACTS = join(homedir(), 'AppData', 'Local', 'Temp', 'dsh-free-llm-ui')
const LEDGER = join(homedir(), '.dsh', 'free-llm-usage.json')

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback
}
const provider = option('provider', '')
const pick = Number(option('pick', '0'))
const timeoutSec = Number(option('timeout', '300'))
const listOnly = args.includes('--list')
const dump = args.includes('--dump')

/** The name each route wears in the selector. */
const PROVIDER_TEXT = {
  kilo: 'Kilo Code',
  opencode: 'OpenCode',
  clixad: 'Clixad',
  copilot: 'Copilot',
  grok: 'Grok',
  qoder: 'Qoder',
}
const providerLabel = PROVIDER_TEXT[provider] ?? provider

mkdirSync(ARTIFACTS, { recursive: true })
const log = (...parts) => console.log(...parts)

const ledgerBefore = readLedger()

function readLedger() {
  try {
    return JSON.parse(readFileSync(LEDGER, 'utf8'))
  } catch {
    return []
  }
}

/** The turn the plugin recorded for this route after the probe started. */
function newTurns(after) {
  const before = ledgerBefore.slice()
  const newer = after.slice(before.length)
  return newer.filter((turn) => !provider || turn.provider === provider)
}

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
const page = targets.find((target) => target.type === 'page')
if (!page) {
  console.error(`no IDE page on the debug port ${CDP_PORT}`)
  process.exit(2)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
let nextId = 0
const pending = new Map()
const send = (method, params = {}, ms = 20000) => {
  const id = ++nextId
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve({ __timeout: true })
    }, ms)
    pending.set(id, (value) => {
      clearTimeout(timer)
      resolve(value)
    })
  })
}
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message.result ?? message.error)
    pending.delete(message.id)
  }
})
await new Promise((resolve) => ws.addEventListener('open', resolve))
await send('Runtime.enable')
await send('Page.enable')

const evaluate = async (expression, ms = 20000) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true }, ms)
  if (!result || result.__timeout) return undefined
  if (result.exceptionDetails) return undefined
  return result.result?.value
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const json = async (expression) => {
  const raw = await evaluate(`JSON.stringify((() => { ${expression} })())`)
  if (typeof raw !== 'string') return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}
const clickAt = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
}
const shot = async (name) => {
  const image = await send('Page.captureScreenshot', { format: 'png' }, 25000)
  if (image?.data) writeFileSync(join(ARTIFACTS, `${name}.png`), Buffer.from(image.data, 'base64'))
}

// A new session, so the turn starts from a clean history.
const newSession = await json(`
  const buttons = [...document.querySelectorAll('button')].filter((b) => b.getAttribute('aria-label') === 'Nueva sesión')
  const visible = buttons.find((b) => b.getBoundingClientRect().width > 0) ?? buttons[buttons.length - 1]
  if (!visible) return null
  const box = visible.getBoundingClientRect()
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
`)
if (newSession) {
  await clickAt(newSession.x, newSession.y)
  await sleep(2500)
}

// The model picker. The IDE restores its last view, so the chat may not be
// in front yet: wait for the picker and fall back to the chat tab.
const findTrigger = () =>
  json(`
  const button = [...document.querySelectorAll('button')].find((b) => /seleccionar modelo/i.test(b.getAttribute('aria-label') || ''))
  if (!button) return null
  const box = button.getBoundingClientRect()
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, expanded: button.getAttribute('aria-expanded') }
`)
let trigger = null
for (let attempt = 0; attempt < 15 && !trigger; attempt++) {
  trigger = await findTrigger()
  if (!trigger) {
    const chat = await json(`
      const tab = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Chat')
      if (!tab) return null
      const box = tab.getBoundingClientRect()
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    `)
    if (chat) {
      await clickAt(chat.x, chat.y)
      await sleep(2000)
    } else {
      await sleep(2000)
    }
  }
}
if (!trigger) {
  console.error('the IDE shows no model picker')
  await shot('sin-selector')
  process.exit(2)
}
// The picker opens in groups: one click on the group shows its models.
// A popover left open from another run gets in the way, so close it first.
const escape = async () => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(900)
}
await escape()
trigger = (await findTrigger()) ?? trigger
if (trigger.expanded === 'true') {
  // Something else is open under the same trigger: close it first.
  await clickAt(trigger.x, trigger.y)
  await sleep(1500)
  trigger = (await findTrigger()) ?? trigger
}
if (trigger.expanded !== 'true') {
  await clickAt(trigger.x, trigger.y)
  await sleep(2000)
}

// The picker opens in two steps: the first click shows the model in use, and
// a second one opens the list with every provider.
const listRows = () =>
  json(`
  const rows = [...document.querySelectorAll('[role="menuitemradio"],[role="menuitem"],[role="option"]')]
  return rows.map((row) => (row.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 70))
`)
let rows = await listRows()
if ((rows?.length ?? 0) <= 1) {
  const item = await json(`
    const node = document.querySelector('[role="menuitem"]')
    if (!node) return null
    const box = node.getBoundingClientRect()
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  `)
  if (item) {
    await clickAt(item.x, item.y)
    await sleep(2000)
    rows = await listRows()
  }
}
log(`modelos visibles (${rows?.length ?? 0}), de ${providerLabel}:`)
for (const row of (rows ?? []).filter((row) => row.includes(providerLabel))) log('  -', row)

if (dump) {
  const structure = await json(`
    const out = []
    document.querySelectorAll('[role]').forEach((node) => {
      const role = node.getAttribute('role') || ''
      if (!/menu|option|radio|listbox|dialog/i.test(role)) return
      const box = node.getBoundingClientRect()
      out.push({
        role,
        label: node.getAttribute('aria-label') || '',
        expanded: node.getAttribute('aria-expanded') || '',
        checked: node.getAttribute('aria-checked') || '',
        text: (node.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60),
        box: [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)],
      })
    })
    return out.slice(0, 80)
  `)
  const popovers = await json(`
    return [...document.querySelectorAll('body > div, [data-radix-popper-content-wrapper], [data-state]')]
      .filter((n) => n.getBoundingClientRect().width > 20)
      .map((n) => ({
        tag: n.tagName,
        state: n.getAttribute('data-state') || '',
        cls: (n.className || '').toString().slice(0, 40),
        text: (n.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 120),
      }))
      .slice(0, 20)
  `)
  log('popovers:', JSON.stringify(popovers))
  log('roles:', JSON.stringify(structure, null, 1))
  await shot('selector-abierto')
  ws.close()
  process.exit(0)
}

if (listOnly) {
  await shot('selector')
  ws.close()
  process.exit(0)
}

// The chosen model: the Nth one of the wanted route.
const wanted = await json(`
  const rows = [...document.querySelectorAll('[role="menuitemradio"],[role="menuitem"],[role="option"]')]
  const wanted = ${JSON.stringify(providerLabel)}
  const matches = rows.filter((row) => ((row.textContent || '').trim().replace(/\\s+/g, ' ')).includes(wanted))
  const row = matches[${pick}] ?? rows[${pick}] ?? rows[0]
  if (!row) return null
  row.scrollIntoView({ block: 'center' })
  const box = row.getBoundingClientRect()
  return {
    x: box.x + 40,
    y: box.y + box.height / 2,
    text: (row.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 70),
    inside: box.top >= 0 && box.bottom <= window.innerHeight,
  }
`)
if (!wanted) {
  console.error('the model list did not open')
  await shot('sin-modelos')
  process.exit(2)
}
log('modelo elegido:', wanted.text)
await clickAt(wanted.x, wanted.y)
await sleep(2500)

// The picker can show more models than fit on the screen, so the click may
// land on nothing. The trigger says which model is in use.
const selectedModel = () =>
  json(`
  const button = [...document.querySelectorAll('button')].find((b) => /seleccionar modelo/i.test(b.getAttribute('aria-label') || ''))
  return button ? (button.getAttribute('aria-label') || '') : ''
`)
let current = await selectedModel()
for (let attempt = 0; attempt < 3 && !current.includes(wanted.text.split(' ')[0]); attempt++) {
  log('el modelo no cambió, reintento:', current)
  await clickAt(wanted.x, wanted.y)
  await sleep(2000)
  current = await selectedModel()
}
log('modelo en uso:', current)
if (!current.includes(wanted.text.split(' ')[0])) {
  console.error(`the IDE kept "${current}" instead of "${wanted.text}"`)
  await shot('modelo-no-cambiado')
  process.exit(2)
}

// The prompt.
const box = await json(`
  const field = document.querySelector('textarea,[contenteditable="true"]')
  if (!field) return null
  const rect = field.getBoundingClientRect()
  return { x: rect.x + 60, y: rect.y + 25 }
`)
if (!box) {
  console.error('the IDE shows no prompt field')
  await shot('sin-caja')
  process.exit(2)
}
// The picker keeps the focus, so it has to close before the field takes it.
await escape()
await clickAt(box.x, box.y)
await sleep(500)
await send('Input.insertText', { text: PROMPT })
await sleep(700)
const typed = await json(`
  const field = document.querySelector('textarea,[contenteditable="true"]')
  return field ? String(field.value ?? field.textContent ?? '') : ''
`)
if (!typed.includes(PROMPT)) {
  console.error(`the prompt did not reach the field: ${JSON.stringify(typed.slice(0, 80))}`)
  await shot('sin-texto')
  process.exit(2)
}
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
await sleep(2000)
// Enter does not always send: the send button is the other way.
const still = await json(`
  const field = document.querySelector('textarea,[contenteditable="true"]')
  return field ? String(field.value ?? field.textContent ?? '') : ''
`)
if (still.includes(PROMPT)) {
  const send = await json(`
    const button = [...document.querySelectorAll('button')].find((b) => /enviar mensaje/i.test(b.getAttribute('aria-label') || ''))
    if (!button) return null
    const rect = button.getBoundingClientRect()
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  `)
  if (send) {
    await clickAt(send.x, send.y)
    await sleep(1500)
  }
}
log('turno enviado:', PROMPT)

// The verdict: the screen says whether the turn failed, the ledger says
// whether the route answered. The harness also asks the model for a session
// title with its own deadline, and that extra call can time out on a slow
// CLI without the answer being wrong, so an answered turn always wins.
const deadline = Date.now() + timeoutSec * 1000
let screen = ''
let screenFailed = false
while (Date.now() < deadline) {
  await sleep(4000)
  screen =
    (await evaluate(`(() => {
      const text = document.body.innerText || ''
      return text.slice(-1200).replace(/\\s+/g, ' ')
    })()`)) ?? ''
  screenFailed = /Este turno falló|INVALID_MODEL_INFO|INVALID_CATALOG/i.test(screen)
  const turns = newTurns(readLedger())
  if (screenFailed) break
  if (turns.some((turn) => turn.ok)) break
}
await shot('turno')

const turns = newTurns(readLedger())
const answeredTurn = turns.find((turn) => turn.ok)
const failedTurn = turns.find((turn) => !turn.ok)
const answered = Boolean(answeredTurn) && !screenFailed
log('turnos en el libro:', JSON.stringify(turns))
log('pantalla:', screen.slice(-400))
if (answered) {
  log('RESULTADO: ok')
} else if (failedTurn?.error?.includes('SESSION_TITLE_TIMEOUT')) {
  log('RESULTADO: fallo')
} else {
  log('RESULTADO: fallo')
}

ws.close()
process.exit(answered ? 0 : 1)
