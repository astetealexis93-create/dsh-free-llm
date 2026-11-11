/**
 * Transport check: how each CLI takes the long prompt the IDE really sends.
 *
 * The IDE context does not fit in a command line (Windows cuts one at 32 KiB),
 * so every route declares how its prompt travels: as an argument, as the
 * standard input, or as a file the CLI reads itself. This probe runs each
 * route the way the engine runs it and reports the ones that answer.
 *
 *   node test/transport.mjs             # the routes as the engine builds them
 *   node test/transport.mjs --variants  # every shape of call, to pick the flags
 *   node test/transport.mjs kilo grok
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { buildRoutes } from '../index.js'

const argv = process.argv.slice(2)
const variants = argv.includes('--variants')
const all = argv.includes('--all')
const only = argv.filter((arg) => !arg.startsWith('--'))
const TIMEOUT_MS = 180000
const FILLER = 'El contexto de esta maquina es largo y debe viajar entero. '

const temp = mkdtempSync(join(tmpdir(), 'dsh-transport-'))
const file = join(temp, 'prompt.txt')
const prompt = `${FILLER.repeat(600)}\nresponde solo: OK`
const created = []
writeFileSync(file, prompt, { mode: 0o600 })

/** Every shape of call worth trying, per route. */
const VARIANTS = {
  kilo: [{ label: 'run+stdin', args: ['run', '--model', 'kilo/kilo-auto/free'], stdin: true }],
  opencode: [
    { label: 'run+json+stdin', args: ['run', '--model', 'opencode/beam-free', '--format', 'json'], stdin: true },
  ],
  clixad: [
    { label: 'bare+stdin', args: [], stdin: true },
    { label: 'ask+stdin', args: ['ask'], stdin: true },
    { label: '-p+file+abs', args: ['-p', 'Lee el archivo {file} con la herramienta Read y responde solo: OK'], cwd: temp },
    { label: 'ask+inline', args: ['ask', 'responde solo: OK'] },
    { label: '-p+file+cwd', args: ['-p', 'Lee el archivo {file} con la herramienta Read y responde solo: OK'], cwd: process.cwd() },
    { label: '-p+inline', args: ['-p', { inline: true }] },
  ],
  copilot: [
    { label: 'stdin+json', args: ['--output-format', 'json'], stdin: true },
    { label: 'stdin', args: [], stdin: true },
    { label: '-p+stdin', args: ['-p'], stdin: true },
    { label: '-p+stdin+json', args: ['-p', '--output-format', 'json'], stdin: true },
  ],
  grok: [{ label: 'stdin+json', args: ['--output-format', 'streaming-json'], stdin: true }],
  qoder: [{ label: '-p+stdin', args: ['-p', '--model', 'Auto'], stdin: true }],
}

const routes = buildRoutes({})

/** Run a CLI the way the engine runs it: same binary, same prefix, same env. */
function run(route, args, { stdinText, cwd } = {}) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let child
    const env = { ...process.env }
    for (const key of route.stripEnv ?? []) delete env[key]
    const command = [...(route.binArgs ?? []), ...args]
    try {
      child = spawn(route.bin, command, {
        cwd: cwd ?? process.cwd(),
        windowsHide: true,
        env,
        stdio: [stdinText === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ ok: false, error: error.message })
      return
    }
    const timer = setTimeout(() => {
      child.kill()
      resolve({ ok: false, error: 'timeout', stdout, stderr })
    }, TIMEOUT_MS)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, error: error.message, stdout, stderr })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0 && /\bOK\b/.test(stdout), code, stdout, stderr })
    })
    if (stdinText !== undefined) {
      child.stdin?.on('error', () => {})
      child.stdin?.end(stdinText)
    }
  })
}

/** The args the engine builds for a route, with the file placeholder resolved. */
function engineArgs(route) {
  const transport = route.promptTransport ?? 'stdin'
  let promptFile
  if (transport === 'file') {
    // The engine writes the prompt inside the workspace of the CLI.
    promptFile = join(process.cwd(), `.dsh-free-llm-prompt-${process.pid}.txt`)
    writeFileSync(promptFile, prompt, { mode: 0o600 })
    created.push(promptFile)
  }
  const args = route.buildArgs(route.defaultModel, prompt, promptFile, { cwd: process.cwd() })
  return { args, transport, promptFile }
}

const results = []
const targets = Object.keys(variants ? VARIANTS : routes).filter(
  (id) => only.length === 0 || only.includes(id)
)

await Promise.all(
  targets.map(async (id) => {
    const route = routes[id]
    if (!route) {
      results.push({ id, shape: '-', ok: false, note: 'ruta ausente' })
      return
    }
    if (route.launchError) {
      results.push({ id, shape: '-', ok: false, note: route.launchError })
      return
    }
    const shapes = variants
      ? VARIANTS[id].map((shape) => ({
          label: shape.label,
          args: shape.args.map((arg) => {
            if (typeof arg === 'string') return arg.replace('{file}', file)
            if (arg?.inline) return prompt
            return arg
          }),
          stdin: shape.stdin,
          cwd: shape.cwd,
        }))
      : (() => {
          const built = engineArgs(route)
          return [
            {
              label: built.transport,
              args: built.args,
              stdin: built.transport === 'stdin',
              cwd: undefined,
            },
          ]
        })()

    for (const shape of shapes) {
      const outcome = await run(route, shape.args, {
        stdinText: shape.stdin ? prompt : undefined,
        cwd: shape.cwd,
      })
      const entry = {
        id,
        shape: shape.label,
        ok: outcome.ok,
        note: outcome.ok ? '' : (outcome.error ?? `exit ${outcome.code}`),
        tail: outcome.ok ? '' : (outcome.stderr || outcome.stdout || '').trim().slice(-200),
      }
      results.push(entry)
      if (outcome.ok && !all) break
    }
  })
)

rmSync(temp, { recursive: true, force: true })
for (const leftover of created) rmSync(leftover, { force: true })

for (const result of results.sort((a, b) => a.id.localeCompare(b.id) || a.shape.localeCompare(b.shape))) {
  console.log(
    `${result.ok ? 'ok  ' : 'FALLA'} ${result.id.padEnd(9)} ${result.shape.padEnd(16)} ${result.note}${
      result.tail ? ` :: ${result.tail}` : ''
    }`
  )
}
const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} transportes responden`)
process.exit(failed.length === 0 ? 0 : 1)
