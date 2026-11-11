/**
 * dsh-free-llm — rutas de LLM gratuitas para DeepSeek Harness y cualquier otra
 * IDE que monte plugins de cordis.
 *
 * Rutas (ver catalog.js):
 *   kilo      -> Kilo Code CLI   (`kilo run --model <m> --format json`)
 *   opencode  -> OpenCode CLI     (`opencode run --model <m> --format json`)
 *   mimo      -> MiMo Code CLI    (`mimo run --model <m> --format json`)
 *   clixad    -> Clixad CLI       (`clixad -p <prompt>`)
 *
 * La CLI conserva su propia autenticación y sus propios modelos: este adaptador
 * solo traduce el vocabulario de mensajes y streaming del IDE a un turno sin
 * interfaz, en el workspace de la sesión. Las tools que la IDE ofrece viajan en
 * el prompt con un puente JSON validado, así la IA usa los complementos de la
 * IDE y no solo los de su propia CLI.
 *
 * Todas las rutas son opcionales: el perfil decide cuáles montar.
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { CATALOG } from './catalog.js'

export const name = 'free-llm'
export const inject = ['llm']

/** Windows corta una linea de comandos cerca de 32 KiB; un prompt largo va a un archivo. */
const ARG_PROMPT_LIMIT = 20000
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000
/** Nombre del archivo donde una CLI que solo lee su workspace recibe el prompt. */
const PROMPT_FILE_PREFIX = '.dsh-free-llm-prompt-'
/** Cuánto se guarda la respuesta de la CLI cuando se le pregunta si hay sesión. */
const SIGN_IN_CACHE_MS = 60 * 1000

/**
 * One CLI at a time per route.
 *
 * Every CLI here keeps a single session on the machine, so a turn, a model
 * listing and a sign-in probe of the same route must not run together: the
 * second process would take the session and the first would answer nothing.
 */
class CliLock {
  constructor() {
    this.chains = new Map()
  }

  /** Wait until the route is free, then take it. */
  async acquire(key) {
    const previous = this.chains.get(key) ?? Promise.resolve()
    let free
    const mine = new Promise((resolve) => {
      free = resolve
    })
    const chain = previous.then(() => mine)
    this.chains.set(key, chain)
    await previous
    return () => {
      free()
      if (this.chains.get(key) === chain) this.chains.delete(key)
    }
  }
}

const CLI_LOCK = new CliLock()
/** El listado de modelos en vivo se cachea: cada CLI tarda en responder. */
const LIST_TTL_MS = 5 * 60 * 1000
const DEFAULT_CONTEXT_WINDOW = 200000
const TOOL_BRIDGE_PREFIX = 'DSH_TOOL_CALLS '

function appDataPath(...parts) {
  const base = process.env.APPDATA
  return base ? join(base, ...parts) : undefined
}

function profilePath(...parts) {
  const base = process.env.USERPROFILE ?? process.env.HOME
  return base ? join(base, ...parts) : undefined
}

function firstNumber(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

function toCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.round(value))
}

/** A PATH entry can arrive POSIX-shaped when the shell rewrote PATH. */
function windowsPathEntry(dir) {
  const wsl = /^\/mnt\/([a-zA-Z])\/(.*)$/.exec(dir)
  if (wsl) return `${wsl[1].toUpperCase()}:\\${wsl[2].replace(/\//g, '\\')}`
  const msys = /^\/([a-zA-Z])\/(.*)$/.exec(dir)
  if (msys) return `${msys[1].toUpperCase()}:\\${msys[2].replace(/\//g, '\\')}`
  return dir
}

/** Find a bare command on PATH the way a shell would, including npm `.cmd` shims. */
function findOnPath(name) {
  if (process.platform !== 'win32') return null
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const extensions = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = join(windowsPathEntry(dir), `${name}${extension.toLowerCase()}`)
      try {
        if (existsSync(candidate)) return candidate
      } catch {
        /* unreadable PATH entry */
      }
    }
  }
  return null
}

/**
 * Node cannot spawn a `.cmd` without a shell, and a shell would put the prompt on
 * a command line where `&` and `|` mean something. The shim is a text file that
 * names its real target, so read it and launch that instead.
 */
function resolveWindowsShim(bin) {
  if (/\.(m?js|cjs)$/i.test(bin)) return { bin: process.execPath, prefix: [bin] }
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(bin)) return { bin, prefix: [] }
  let text
  try {
    text = readFileSync(bin, 'utf8')
  } catch {
    return null
  }
  const direct = []
  const assigned = []
  for (const match of text.matchAll(/"([^"\r\n]+)"/g)) {
    const quoted = match[1]
    const isAssignment = quoted.includes('=')
    const value = (isAssignment ? quoted.slice(quoted.indexOf('=') + 1) : quoted).trim()
    // A target is an executable or a script. Some CLIs ship a native binary or
    // a script without an extension, so an extension is not required.
    const hasExtension = /\.[a-z0-9]+$/i.test(value)
    if (hasExtension && !/\.(exe|js|mjs|cjs)$/i.test(value)) continue
    const relative = value.replace(/%~dp0\\?/gi, '').replace(/%dp0%\\?/gi, '').replace(/%[^%]*%/g, '')
    if (!relative || relative.includes('%')) continue
    const target = isAbsolute(relative) ? relative : join(dirname(bin), relative)
    try {
      if (existsSync(target)) (isAssignment ? assigned : direct).push(target)
    } catch {
      /* skip an entry the filesystem will not answer for */
    }
  }
  const pick = (list, pattern) => {
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const base = list[index].split(/[\\/]/).pop() ?? list[index]
      if (pattern.test(base)) return list[index]
    }
    return undefined
  }
  const target =
    pick(direct, /\.(js|mjs|cjs)$/i) ??
    pick(direct, /\.exe$/i) ??
    pick(assigned, /\.(js|mjs|cjs)$/i) ??
    pick(assigned, /\.exe$/i) ??
    pick(direct, /^[^.]+$/) ??
    pick(assigned, /^[^.]+$/)
  if (!target) return null
  if (/\.(m?js|cjs)$/i.test(target)) return { bin: process.execPath, prefix: [target] }
  if (/\.exe$/i.test(target)) return { bin: target, prefix: [] }
  // A file without extension is a native binary when it starts with the PE
  // header, and a script otherwise.
  return isNativeBinary(target) ? { bin: target, prefix: [] } : { bin: process.execPath, prefix: [target] }
}

/** True when a file starts with the Windows PE header. */
function isNativeBinary(file) {
  try {
    const handle = openSync(file, 'r')
    const header = Buffer.alloc(2)
    const read = readSync(handle, header, 0, 2, 0)
    closeSync(handle)
    return read === 2 && header.toString('latin1') === 'MZ'
  } catch {
    return false
  }
}

/** Expand one candidate that carries a `*` wildcard into the files that match. */
function expandWildcard(candidate) {
  if (!candidate.includes('*')) return [candidate]
  const star = candidate.indexOf('*')
  const dir = candidate.slice(0, star).replace(/[\\/]+$/, '')
  const rest = candidate.slice(star + 1)
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .sort()
    .map((name) => join(dir, name + rest))
    .filter((path) => {
      try {
        return existsSync(path)
      } catch {
        return false
      }
    })
}

/** The first candidate that exists on disk, else the bare command name. */
function resolveBin(candidates) {
  const list = (Array.isArray(candidates) ? candidates : [candidates]).filter(Boolean)
  for (const raw of list) {
    for (const candidate of expandWildcard(raw)) {
      if (candidate.includes('\\') || candidate.includes('/')) {
        try {
          if (existsSync(candidate)) return candidate
        } catch {
          /* fall through */
        }
        continue
      }
      return findOnPath(candidate) ?? candidate
    }
  }
  return list.pop()
}

/** Resolve executables without a shell, including a VM's own PATH. */
function executablePath(bin) {
  if (typeof bin !== 'string' || !bin) return null
  if (isAbsolute(bin) || /[/\\]/.test(bin)) return existsSync(bin) ? bin : null
  if (process.platform === 'win32') return findOnPath(bin)
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const file = join(dir, bin)
    try {
      if (statSync(file).isFile()) return file
    } catch {
      /* next PATH entry */
    }
  }
  return null
}

/**
 * Una CLI puede pedir un entorno limpio: hay variables internas de la IDE que
 * enredan a la CLI de Qoder y la hacen salir sin responder.
 */
function cleanEnv(env, strip) {
  if (!Array.isArray(strip) || strip.length === 0) return env
  const copy = { ...env }
  for (const key of strip) delete copy[key]
  return copy
}

/**
 * Write the prompt where a CLI can read it: inside the workspace it works on.
 *
 * Some CLIs refuse to open a file outside their own workspace, so the prompt
 * lands next to the project and is removed when the turn ends.
 */
function writePromptFile(cwd, prompt) {
  const file = join(cwd, `${PROMPT_FILE_PREFIX}${process.pid}.txt`)
  try {
    writeFileSync(file, prompt, { mode: 0o600 })
    return file
  } catch {
    const fallback = join(tmpdir(), `${PROMPT_FILE_PREFIX}${process.pid}.txt`)
    writeFileSync(fallback, prompt, { mode: 0o600 })
    return fallback
  }
}

/** Remove the prompt files that a turn that died mid-flight left behind. */
function clearPromptFiles(cwd) {
  try {
    for (const name of readdirSync(cwd)) {
      if (name.startsWith(PROMPT_FILE_PREFIX) && name.endsWith('.txt')) {
        rmSync(join(cwd, name), { force: true })
      }
    }
  } catch {
    /* the workspace may not be readable */
  }
}

/**
 * The harness asks the model for things beside the chat, like the title of a
 * session. Those calls have their own deadline and are not turns of the user.
 */
function isAuxiliaryRequest(options) {
  const messages = Array.isArray(options?.messages) ? options.messages : []
  return messages.some((message) => String(message?.source?.kind ?? '').startsWith('dsh-session-title'))
}

/** A route carries the executable and the arguments that come before its own. */
function spawnCommand(route, args, options) {
  const bin = typeof route === 'string' ? route : route?.bin
  const prefix = typeof route === 'string' ? [] : route?.binArgs ?? []
  const strip = typeof route === 'string' ? [] : route?.stripEnv ?? []
  const env = cleanEnv(options?.env ?? process.env, strip)
  return spawn(bin, [...prefix, ...args], { ...options, env })
}

function runCapture(route, args, { cwd, timeoutMs, env = process.env, signal }) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawnCommand(route, args, { cwd, windowsHide: true, env, signal, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      reject(error)
      return
    }
    let stdout = ''
    let stderr = ''
    const timer = timeoutMs ? setTimeout(() => child.kill(), timeoutMs) : undefined
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      if (timer) clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

/** Project one message's content blocks to plain text. */
function contentToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const out = []
  for (const block of content) {
    if (block == null) continue
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string') out.push(block.text)
        break
      case 'reasoning':
        if (typeof block.text === 'string' && block.text.length > 0) out.push(`[thinking] ${block.text}`)
        break
      case 'tool-call':
        out.push(`[tool call ${block.id ?? ''} ${block.name ?? ''}(${block.arguments ?? ''})]`)
        break
      case 'tool-result':
        out.push(
          `[tool result ${block.toolCallId ?? ''}${block.isError ? ' (error)' : ''}]\n${contentToText(block.content)}`,
        )
        break
      case 'image':
        out.push('[image supplied separately with this request]')
        break
      case 'file':
        out.push('[file attachment]')
        break
      default:
        break
    }
  }
  return out.join('\n').trim()
}

/** Turn the harness conversation into one prompt for the CLI. */
function buildPrompt(options, includeSystem) {
  const parts = []
  if (includeSystem && typeof options.system === 'string' && options.system.trim().length > 0) {
    parts.push(`System instructions:\n${options.system.trim()}`)
  }
  const turns = []
  for (const message of options.messages ?? []) {
    const role = message?.role ?? 'user'
    if ((role === 'system' || role === 'developer') && !includeSystem) continue
    const text = contentToText(message?.content)
    if (text.length === 0) continue
    if (role === 'system' || role === 'developer') {
      turns.push(`[${role}]\n${text}`)
      continue
    }
    turns.push(`${role}: ${text}`)
  }
  if (turns.length > 0) parts.push(`Conversation transcript:\n${turns.join('\n\n')}`)
  parts.push(
    'You are answering as the assistant inside a chat product. Continue the transcript above: reply to the last user turn directly. Do not narrate these instructions, and do not describe the transcript format.',
  )
  return parts.join('\n\n')
}

/** Describe the IDE tools the CLI may ask for. */
function toolBridgePrompt(tools, options = {}) {
  const rule = options.ownReadAllowed
    ? 'Use your own Read tool only to open the prompt file you were given; for every other task request the IDE tools below.'
    : 'Do not use your own built-in tools for files, search or commands; request the IDE tools below so the IDE runs them.'
  return (
    `\n\nDSH tools available for this turn (JSON schemas):\n${JSON.stringify(tools)}\n` +
    `To request one or more of THESE tools, return ONLY ${TOOL_BRIDGE_PREFIX}` +
    '[{"name":"exact tool name","arguments":{}}] with valid JSON double quotes. ' +
    'The host executes the tools under its own permission rules and returns correlated tool results on the next turn. ' +
    'Do not claim a tool was executed before its result arrives. For a normal answer, write normal text without this prefix. ' +
    rule
  )
}

/** Read the tool requests the CLI wrote at the end of its answer. */
function bridgeCalls(text, tools) {
  if (!text.startsWith(TOOL_BRIDGE_PREFIX)) return []
  const calls = JSON.parse(text.slice(TOOL_BRIDGE_PREFIX.length))
  if (!Array.isArray(calls) || calls.length === 0 || calls.length > 16) {
    throw new Error('expected 1 to 16 tool requests')
  }
  const names = new Set(tools.map((tool) => tool.name))
  return calls.map((call) => {
    if (!names.has(call?.name)) throw new Error('the requested tool was not offered for this turn')
    if (!call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) {
      throw new Error('tool arguments must be a JSON object')
    }
    return { type: 'tool-call', id: randomUUID(), name: call.name, arguments: JSON.stringify(call.arguments) }
  })
}

/** Parse one NDJSON event of an OpenCode-style CLI (`--format json`). */
function parseOpencodeLine(line) {
  let event
  try {
    event = JSON.parse(line)
  } catch {
    return null
  }
  if (event?.type === 'error') {
    const message =
      event?.error?.message ?? event?.message ?? (typeof event?.error === 'string' ? event.error : undefined)
    const status = firstNumber(event?.error?.status, event?.status)
    if (typeof message === 'string' && message.length > 0) {
      return { error: status !== undefined ? `${message} (HTTP ${status})` : message }
    }
  }
  if (event?.type === 'text' && typeof event?.part?.text === 'string' && event.part.text.length > 0) {
    return { text: event.part.text }
  }
  if (event?.type === 'reasoning' && typeof event?.part?.text === 'string' && event.part.text.length > 0) {
    return { reasoning: event.part.text }
  }
  if (event?.type === 'step_finish') {
    const tokens = event.part?.tokens
    const cost = typeof event.part?.cost === 'number' ? event.part.cost : undefined
    if (tokens && typeof tokens === 'object') {
      return {
        usage: {
          inputTokens: toCount(tokens.input),
          outputTokens: toCount(tokens.output),
          cacheReadTokens: toCount(tokens.cache?.read),
          cacheWriteTokens: toCount(tokens.cache?.write),
          reasoningTokens: toCount(tokens.reasoning),
        },
        cost,
        usageDelta: true,
      }
    }
    if (cost !== undefined) return { cost }
  }
  return null
}

/**
 * Read one JSONL event of the GitHub Copilot CLI (`--output-format json`).
 *
 * The answer arrives as `assistant.message_delta` chunks; the whole message is
 * repeated later, so it is kept aside and used only if no chunk ever showed up.
 */
function parseCopilotLine(line) {
  let event
  try {
    event = JSON.parse(line)
  } catch {
    return null
  }
  const type = event?.type
  if (type === 'assistant.message_delta') {
    const delta = event?.data?.deltaContent
    if (typeof delta === 'string' && delta.length > 0) return { text: delta }
    return null
  }
  if (type === 'assistant.message') {
    const content = event?.data?.content
    const phase = event?.data?.phase
    if (typeof content === 'string' && content.length > 0 && (phase === undefined || phase === 'final_answer')) {
      return { final: content }
    }
    return null
  }
  if (type === 'error') {
    const message = event?.data?.message ?? event?.message ?? event?.error?.message
    if (typeof message === 'string' && message.length > 0) return { error: message }
  }
  return null
}

/** Read one JSONL event of the Grok CLI (`--output-format streaming-json`). */
function parseGrokLine(line) {
  let event
  try {
    event = JSON.parse(line)
  } catch {
    return null
  }
  if (event?.type === 'text' && typeof event.data === 'string' && event.data.length > 0) {
    return { text: event.data }
  }
  if (event?.type === 'thought' && typeof event.data === 'string' && event.data.length > 0) {
    return { reasoning: event.data }
  }
  if (event?.type === 'usage' && event?.usage && typeof event.usage === 'object') {
    const usage = event.usage
    return {
      usage: {
        inputTokens: toCount(usage.input_tokens),
        outputTokens: toCount(usage.output_tokens),
        cacheReadTokens: toCount(usage.cache_read_input_tokens),
        cacheWriteTokens: toCount(usage.cache_creation_input_tokens),
        reasoningTokens: toCount(usage.reasoning_tokens),
      },
      usageDelta: true,
    }
  }
  if (event?.type === 'error') {
    const message = event?.data?.message ?? event?.message ?? event?.error?.message
    if (typeof message === 'string' && message.length > 0) return { error: message }
  }
  return null
}

/** Read the model ids of a Grok listing: "  * grok-4.7 (default)". */
function parseGrokModelList(stdout) {
  const ids = []
  for (const raw of stdout.split(/\r?\n/)) {
    const match = /^\s*\*\s+([^\s(]+)/.exec(raw)
    if (match) ids.push(match[1])
  }
  return ids
}

/**
 * The name the selector shows for a model.
 *
 * A route that offers a single model shows that model alone; a route that
 * offers several shows them with their provider, because the bare ids repeat
 * the provider prefix that the group already carries.
 */
function modelLabel(id, provider, route, many) {
  const short = id.startsWith(`${provider}/`) ? id.slice(provider.length + 1) : id
  const label = route?.providerLabel ?? provider
  return many ? `${short} (${label})` : short
}

/** Read the ids of a `models` listing: one `provider/model` per line. */
function parseModelList(stdout) {  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    // Some CLIs print a header before the list; it is not a model.
    .filter((line) => !/^(model|models|modelo|modelos|id)$/i.test(line))
}

/**
 * Read the free models of a listing that marks them, as Clixad does:
 * "[free: ~N turns left today]" or "· covered".
 */
function parseMarkedFreeList(stdout) {
  const ids = []
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const id = /^(\S+)/.exec(line)?.[1]
    if (!id) continue
    const free = /\[free:/i.test(line) || /·\s*covered\b/i.test(line)
    if (free) ids.push(id)
  }
  return ids
}

/**
 * Read the plain answer of a CLI that prints text instead of events: the
 * header line and the credit line are not part of the reply.
 */
function parseTextLine(line) {
  const trimmed = line.trim()
  if (trimmed.length === 0) return null
  if (trimmed.startsWith('>')) return null
  if (/^\[[^\]]*\]$/.test(trimmed)) return null
  const text = trimmed.replace(/^(assistant|user|thinking)\s*:\s*/i, '').replace(/^assistant\s+/i, '')
  if (text.length === 0) return null
  return { text }
}

/** A CLI that ignores the JSON flag still prints its answer as plain text. */
function plainTextAnswer(stdout, stderr) {
  const clean = (source) =>
    String(source ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !/reading additional input from stdin/i.test(line))
  const outLines = clean(stdout)
  const answer = outLines.join('\n').trim()
  if (answer.length > 0) return answer
  return clean(stderr).join('\n').trim()
}

/** True when an id names a model that costs nothing. */
function looksFree(id, route) {
  if (route.models?.includes(id)) return true
  return /-free$|-free:|:free$|kilo-auto\/free|openrouter\/free/i.test(id)
}

/**
 * Turn one catalog entry into a route the adapter can run.
 *
 * `family` decides how the answer arrives: `opencode` speaks NDJSON with
 * `--format json`, `text` prints a plain answer. `invocation` decides how the
 * CLI is called: `run-model` takes a model, `print` takes only the prompt.
 */
function buildRoute(entry, override = {}) {
  const route = {
    id: entry.id,
    displayName: entry.displayName,
    family: entry.family,
    invocation: entry.invocation,
    npm: entry.npm,
    bin: entry.bin ?? [],
    binName: entry.bin?.[0] ?? entry.id,
    candidates: entry.candidates ?? [],
    models: entry.models ?? [],
    defaultModel: entry.defaultModel,
    credentials: entry.credentials ?? [],
    credentialPattern: entry.credentialPattern ?? null,
    notes: entry.notes ?? '',
    extraArgs: entry.extraArgs ?? [],
    stripEnv: entry.stripEnv ?? [],
    modelFlag: entry.modelFlag ?? false,
    // How the prompt reaches the CLI: its standard input, a file it reads
    // itself, or the command line when the route insists on it.
    promptTransport: entry.promptTransport ?? 'stdin',
    printFlag: entry.printFlag ?? '',
    providerLabel: entry.providerLabel ?? entry.displayName ?? entry.id,
    accent: entry.accent ?? '#6366f1',
    tone: entry.tone ?? 'neutral',
    blurb: entry.blurb ?? '',
    ...override,
  }
  route.listArgs =
    override.listArgs !== undefined ? override.listArgs : entry.listArgs !== undefined ? entry.listArgs : ['models']
  route.filterFree = override.filterFree ?? entry.filterFree ?? false
  route.parseList =
    override.parseList ??
    (entry.listParser === 'marked-free'
      ? parseMarkedFreeList
      : entry.listParser === 'grok'
        ? parseGrokModelList
        : parseModelList)
  const lineParsers = { text: parseTextLine, opencode: parseOpencodeLine, copilot: parseCopilotLine, grok: parseGrokLine }
  route.parseLine = override.parseLine ?? lineParsers[route.family] ?? parseOpencodeLine

  /**
   * The prompt travels in one of three ways: as an argument, as the standard
   * input of the CLI, or as a file the CLI reads itself. Windows cuts a command
   * line at 32 KiB and the IDE sends longer contexts, so only the first two
   * routes survive a real conversation.
   */
  const promptArgument = (prompt, promptFile) => {
    if (route.promptTransport === 'file') {
      return promptFile
        ? `Lee el archivo ${promptFile} con la herramienta Read y responde a su ultima intervencion.`
        : prompt
    }
    if (route.promptTransport === 'inline') return prompt
    return null
  }

  if (route.invocation === 'run-model') {
    route.buildArgs =
      override.buildArgs ??
      ((model, prompt, promptFile) => {
        const target = model || route.defaultModel
        const args = ['run', '--model', target]
        if (route.family === 'opencode') args.push('--format', 'json')
        const argument = promptArgument(prompt, promptFile)
        if (argument) args.push(argument)
        return args
      })
    return route
  }
  route.buildArgs = override.buildArgs ?? ((model, prompt, promptFile) => {
    const args = []
    const argument = promptArgument(prompt, promptFile)
    if (argument) args.push(route.printFlag || '-p', argument)
    else if (route.printFlag) args.push(route.printFlag)
    if (route.modelFlag && model) args.push('--model', model)
    return [...args, ...(route.extraArgs ?? [])]
  })
  return route
}

/**
 * Read the catalog into the routes the adapter serves.
 *
 * A CLI can be offered by more than one path (a PATH entry, a global npm shim,
 * the bundle of an IDE). The first candidate that can really be launched wins,
 * so a stale shim never hides a working install.
 */
function buildRoutes(config = {}) {
  const configured = config.providers && typeof config.providers === 'object' ? config.providers : {}
  const routes = {}
  for (const entry of CATALOG) {
    const override = configured[entry.id]
    if (override === false || override?.enabled === false) continue
    if (entry.disabled && override === undefined) continue
    const route = buildRoute(entry, override && typeof override === 'object' ? override : {})
    const candidates = [...(route.bin ?? []), ...(route.candidates ?? [])]
    let launch
    let resolved = candidates[candidates.length - 1]
    for (const candidate of candidates) {
      for (const expanded of expandWildcard(candidate)) {
        if (!expanded.includes('\\') && !expanded.includes('/')) {
          const found = findOnPath(expanded)
          if (!found) continue
          resolved = found
          launch = resolveWindowsShim(found)
          break
        }
        try {
          if (!existsSync(expanded)) continue
        } catch {
          continue
        }
        resolved = expanded
        launch = resolveWindowsShim(expanded)
        break
      }
      if (launch) break
    }
    if (!launch) {
      launch = resolveWindowsShim(resolveBin(candidates))
      resolved = route.bin?.[0] ?? resolved
    }
    route.bin = launch?.bin ?? resolved
    route.binArgs = launch?.prefix ?? []
    if (!launch) {
      route.launchError = `cannot launch "${resolved}"`
    }
    routes[entry.id] = route
  }
  return routes
}

/** The catalog entries that know how to sign in, keyed by route id. */
function loginMap(routes) {
  const map = {}
  for (const entry of CATALOG) {
    if (!entry.login) continue
    map[entry.id] = entry.login
  }
  return map
}

/**
 * The turns the ledger wrote before the plugin knew which calls are auxiliary.
 * The harness named them in the error itself, so they can be told apart.
 */
function markOldAuxiliary(entry) {
  if (entry?.auxiliary) return entry
  if (typeof entry?.error === 'string' && entry.error.includes('SESSION_TITLE_TIMEOUT')) {
    return { ...entry, auxiliary: true }
  }
  return entry
}

/** A tiny JSON ledger of the turns that went through the CLIs. */
class UsageLedger {
  constructor(file, limit = 500) {
    this.file = file
    this.limit = limit
    this.entries = []
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      if (Array.isArray(raw)) this.entries = raw.slice(-limit).map(markOldAuxiliary)
    } catch {
      /* no ledger yet */
    }
  }

  record(entry) {
    this.entries.push(entry)
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit)
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(this.entries, null, 2), 'utf8')
    } catch {
      /* the ledger is a report, never a reason to fail a turn */
    }
  }

  summary() {
    const totals = { turns: 0, ok: 0, failed: 0, auxiliary: 0, inputTokens: 0, outputTokens: 0, ms: 0 }
    for (const entry of this.entries) {
      if (entry.auxiliary) {
        totals.auxiliary += 1
        continue
      }
      totals.turns += 1
      if (entry.ok) totals.ok += 1
      else totals.failed += 1
      totals.inputTokens += entry.inputTokens ?? 0
      totals.outputTokens += entry.outputTokens ?? 0
      totals.ms += entry.ms ?? 0
    }
    return { totals, entries: this.entries.slice(-100) }
  }
}

/** Install a missing CLI with npm, into a private folder the plugin owns. */
class CliSetupManager {
  constructor(config) {
    this.config = config
    this.pending = new Map()
    this.errors = new Map()
    this.controller = new AbortController()
  }

  route(provider) {
    const route = this.config.providers?.[provider]
    if (!route) throw new Error(`free-llm: unknown provider "${provider}"`)
    return route
  }

  target(provider) {
    const root = join(this.config.cliInstallDir, provider)
    const name = this.route(provider).binName ?? provider
    return join(root, 'node_modules', '.bin', name + (process.platform === 'win32' ? '.cmd' : ''))
  }

  adopt(provider, file, prefix) {
    const route = this.route(provider)
    const launch = prefix ? { bin: file, prefix } : resolveWindowsShim(file)
    if (!launch) return false
    route.bin = launch.bin
    route.binArgs = launch.prefix
    delete route.launchError
    return true
  }

  status(provider) {
    const route = this.route(provider)
    if (!executablePath(route.bin)) this.adopt(provider, this.target(provider))
    return {
      installed: !route.launchError && !!executablePath(route.bin),
      installing: this.pending.has(provider),
      error: this.errors.get(provider) ?? '',
    }
  }

  async ensure(provider) {
    const route = this.route(provider)
    const status = this.status(provider)
    if (status.installed) return status
    if (!route.npm) throw new Error(`free-llm: "${provider}" is not installed and has no npm package to install it`)
    if (this.pending.has(provider)) return this.pending.get(provider)
    const job = this.install(provider)
      .catch((error) => {
        this.errors.set(provider, error.message)
        throw error
      })
      .finally(() => this.pending.delete(provider))
    this.pending.set(provider, job)
    return job
  }

  async install(provider) {
    const route = this.route(provider)
    const root = join(this.config.cliInstallDir, provider)
    mkdirSync(root, { recursive: true })
    this.errors.delete(provider)
    const npm = executablePath('npm') ?? join(dirname(process.execPath), process.platform === 'win32' ? 'npm.cmd' : 'npm')
    const npmLaunch = resolveWindowsShim(npm)
    if (!npmLaunch) throw new Error(`free-llm: cannot launch npm (${npm})`)
    const result = await runCapture(
      { bin: npmLaunch.bin, binArgs: npmLaunch.prefix },
      ['install', '--prefix', root, '--no-audit', '--no-fund', '--package-lock=false', route.npm],
      { cwd: root, env: process.env, signal: this.controller.signal, timeoutMs: this.config.installTimeoutMs },
    )
    if (result.code !== 0) {
      throw new Error(`free-llm: ${provider} installation failed (exit ${result.code ?? 'timeout'})`)
    }
    if (!this.adopt(provider, this.target(provider))) {
      throw new Error(`free-llm: ${provider} installer finished but its executable is missing`)
    }
    return { ...this.status(provider), installing: false }
  }

  dispose() {
    this.controller.abort()
  }
}

/** Ask the CLI whether it is already signed in; the CLI keeps the credential. */
class SignInManager {
  constructor(config) {
    this.config = config
    this.pending = new Map()
    this.cache = new Map()
  }

  loginFor(provider) {
    const login = CATALOG.find((entry) => entry.id === provider)?.login
    if (!login) throw new Error(`free-llm: "${provider}" does not use a sign-in`)
    return login
  }

  /** A credential file on disk is proof enough that no sign-in is needed. */
  hasStoredCredential(provider) {
    const route = this.config.providers?.[provider]
    for (const file of route?.credentials ?? []) {
      try {
        if (!existsSync(file) || statSync(file).size === 0) continue
        if (route.credentialPattern) {
          if (!route.credentialPattern.test(readFileSync(file, 'utf8'))) continue
        }
        return true
      } catch {
        /* unreadable credential file */
      }
    }
    return false
  }

  async status(provider) {
    const login = this.loginFor(provider)
    if (this.hasStoredCredential(provider)) return { signedIn: true, text: 'credential found on this machine' }
    const route = this.config.providers?.[provider]
    if (!route || !executablePath(route.bin)) return { signedIn: false, text: 'CLI not installed' }
    // The probe asks the CLI over the network, so its answer is kept for a
    // while: the plugin page asks for every route at once.
    const cached = this.cache.get(provider)
    if (cached && Date.now() - cached.at < SIGN_IN_CACHE_MS) return cached.value
    const release = await CLI_LOCK.acquire(provider)
    let result
    try {
      result = await runCapture(route, login.statusArgs ?? [], {
        cwd: this.config.cwd,
        timeoutMs: 30000,
      }).catch(() => ({ code: null, stdout: '', stderr: '' }))
    } finally {
      release()
    }
    const { code, stdout, stderr } = result
    const text = `${stdout}\n${stderr}`
    const value = { signedIn: code === 0 && login.signedIn(text), text: text.trim() }
    this.cache.set(provider, { at: Date.now(), value })
    return value
  }

  /** Start the CLI's own sign-in and report what the human must confirm. */
  async start(provider) {
    const login = this.loginFor(provider)
    const route = this.config.providers?.[provider]
    if (!route) throw new Error(`free-llm: unknown provider "${provider}"`)
    const child = spawnCommand(route, login.loginArgs ?? [], {
      cwd: this.config.cwd,
      windowsHide: true,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let text = ''
    const collect = (chunk) => {
      text += chunk
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    const done = new Promise((resolve) => {
      child.on('close', (code) => resolve({ code, text }))
      child.on('error', (error) => resolve({ code: null, text: `${text}\n${error.message}` }))
    })
    const deadline = Date.now() + 15000
    let info = parseDeviceInfo(text)
    while (Date.now() < deadline) {
      info = parseDeviceInfo(text)
      if (info.url || info.code) break
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    return { url: info.url, code: info.code, note: login.note, done }
  }
}

/** Pull the page and short code out of a CLI device-code prompt. */
function parseDeviceInfo(text) {
  text = String(text).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  const url = /https?:\/\/[^\s'"]+/.exec(text)?.[0]
  const fromUrl = url ? /user_code=([A-Za-z0-9._-]+)/.exec(url)?.[1] : undefined
  const code = fromUrl ?? /\b([A-Z0-9]{4}-[A-Z0-9]{4,8})\b/.exec(text)?.[1]
  return { url, code }
}

/** One adapter serving every configured CLI route. */
class CliAdapter {
  constructor(ctx, config, setup, ledger) {
    this.ctx = ctx
    this.config = config
    this.setup = setup
    this.ledger = ledger
    this.listCache = new Map()
    this.refreshing = new Set()
    this.refreshTimers = new Map()
    this.turns = 0
  }

  providerInfo(provider) {
    const route = this.config.providers[provider]
    return { id: provider, name: route?.providerLabel ?? route?.displayName ?? provider }
  }

  /** The CLI route keeps the host default retry policy. */
  providerRetryPolicy() {
    return undefined
  }

  /** The CLIs expose no separate image-price estimate. */
  imageRequestPricing() {
    return undefined
  }

  /**
   * The models of one route, as the selector wants them.
   *
   * The harness asks every provider for its catalog before it paints the
   * selector, so the answer has to be immediate: the fixed catalog answers at
   * once and the CLI refreshes it in the background for the next call.
   */
  async listModels(provider) {
    const route = this.config.providers[provider]
    if (!route) return []
    const cached = this.listCache.get(provider)
    if (cached && Date.now() - cached.at < LIST_TTL_MS) return cached.models
    const fixed = route.models ?? []
    if (fixed.length > 0) {
      if (!cached) {
        const models = fixed.map((id) => this.modelEntry(provider, id, fixed.length > 1))
        this.listCache.set(provider, { at: Date.now(), models })
      }
      this.scheduleRefresh(provider)
      return this.listCache.get(provider).models
    }
    const release = await CLI_LOCK.acquire(provider)
    let models
    try {
      models = await this.liveModels(provider)
    } finally {
      release()
    }
    this.listCache.set(provider, { at: Date.now(), models })
    return models
  }

  /** Ask the CLI later, once no turn is using it. */
  scheduleRefresh(provider) {
    const pending = this.refreshTimers.get(provider)
    if (pending) clearTimeout(pending)
    const timer = setTimeout(() => {
      this.refreshTimers.delete(provider)
      this.refreshModels(provider)
    }, 5000)
    timer.unref?.()
    this.refreshTimers.set(provider, timer)
  }

  /** Ask the CLI what it offers and keep the answer for the next call. */
  async refreshModels(provider) {
    if (this.refreshing.has(provider)) return
    if (this.turns > 0) return
    this.refreshing.add(provider)
    const release = await CLI_LOCK.acquire(provider)
    try {
      const models = await this.liveModels(provider)
      if (models.length > 0) this.listCache.set(provider, { at: Date.now(), models })
    } catch {
      /* the fixed catalog stays in place */
    } finally {
      release()
      this.refreshing.delete(provider)
    }
  }

  /** The models the CLI itself lists right now. */
  async liveModels(provider) {
    const route = this.config.providers[provider]
    let models = []
    try {
      if (Array.isArray(route.listArgs)) {
        const { code, stdout } = await runCapture(route, route.listArgs, {
          cwd: this.config.cwd,
          timeoutMs: 30000,
        })
        if (code === 0) {
          const ids = route.parseList(stdout).filter((id) => typeof id === 'string' && id.length > 0)
          const free = route.filterFree ? ids.filter((id) => looksFree(id, route)) : ids
          const chosen = free.length > 0 ? free : ids
          models = chosen.map((id) => this.modelEntry(provider, id, chosen.length > 1))
        }
      }
    } catch {
      /* the CLI could not answer; the fixed catalog answers instead */
    }
    return models
  }

  /**
   * One model as the selector shows it: its name, the badge that carries the
   * provider and the tone that paints that badge in the provider's colour.
   */
  modelEntry(provider, id, many) {
    const route = this.config.providers[provider]
    return {
      provider,
      id,
      name: modelLabel(id, provider, route, many),
      ...route?.blurb ? { description: route.blurb } : {},
      badge: { text: route?.providerLabel ?? provider, tone: route?.tone ?? 'neutral' },
    }
  }

  limitsFor(provider, model) {
    const route = this.config.providers[provider]
    return { contextWindow: route?.contextWindow ?? DEFAULT_CONTEXT_WINDOW, maxOutputTokens: route?.maxOutputTokens }
  }

  /** The model id a call runs on. */
  modelId(provider, model) {
    if (typeof model === 'string' && model.length > 0) return model
    return this.config.providers[provider]?.defaultModel ?? ''
  }

  /**
   * The exact metadata the harness reads for one model of this route.
   *
   * The host validates this shape, and a route that answers with the bare id
   * takes its whole provider out of the selector.
   */
  async resolveModel(provider, model) {
    const id = this.modelId(provider, model)
    const route = this.config.providers[provider]
    const limits = this.limitsFor(provider, id)
    const many = (route?.models?.length ?? 1) > 1
    const info = {
      provider,
      id,
      name: modelLabel(id, provider, route, many),
      context: { contextWindow: limits.contextWindow ?? DEFAULT_CONTEXT_WINDOW },
    }
    return info
  }
  async prepareCall(provider, model, signal) {
    return {
      // The host validates this value as the exact-model metadata, so the
      // answer must be the model's own record and never the bare id.
      model: await this.resolveModel(provider, model),
      stream: (options) => this.stream({ ...options, provider, signal }),
    }
  }

  recordFailure(provider, model, startedAt, message, auxiliary = false) {
    this.ledger?.record({
      at: startedAt,
      ms: Date.now() - startedAt,
      provider,
      model,
      inputTokens: 0,
      outputTokens: 0,
      ok: false,
      error: String(message).slice(0, 200),
      ...(auxiliary ? { auxiliary: true } : {}),
    })
  }

  async *stream(options) {
    const provider = options.provider
    const route = this.config.providers[provider]
    if (!route) throw new Error(`free-llm: unknown provider route "${provider}"`)
    const startedAt = Date.now()
    const auxiliary = isAuxiliaryRequest(options)
    if (options.signal?.aborted) {
      this.recordFailure(provider, options.model, startedAt, 'the request was aborted', auxiliary)
      yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'the request was aborted', code: 'ABORTED' } } }
      return
    }
    // One CLI at a time: every CLI here keeps one session on the machine, and
    // two processes at once leave one of them without an answer.
    const release = await CLI_LOCK.acquire(provider)
    this.turns += 1
    try {
      yield* this.streamLocked(options, route, provider)
    } finally {
      this.turns -= 1
      release()
    }
  }

  async *streamLocked(options, route, provider) {
    const startedAt = Date.now()
    const auxiliary = isAuxiliaryRequest(options)
    try {
      await this.setup?.ensure(provider)
    } catch (error) {
      this.recordFailure(provider, options.model, startedAt, error.message, auxiliary)
      throw error
    }
    if (route.launchError) {
      this.recordFailure(provider, options.model, startedAt, route.launchError, auxiliary)
      throw new Error(route.launchError)
    }

    const offeredTools = Array.isArray(options.tools) ? options.tools : []
    const bridgeEnabled = offeredTools.length > 0
    let promptFile
    let child
    const removePromptFile = () => {
      if (!promptFile) return
      try {
        rmSync(promptFile, { force: true })
      } catch {
        /* best effort */
      }
    }
    try {
      const transport = route.promptTransport ?? 'stdin'
      let prompt = buildPrompt(options, this.config.includeSystemPrompt !== false) +
        (bridgeEnabled ? toolBridgePrompt(offeredTools, { ownReadAllowed: transport === 'file' }) : '')
      if (transport === 'file') {
        // A CLI that only reads inside its own workspace needs the prompt in
        // that workspace, not in the temp folder of the system.
        promptFile = writePromptFile(this.config.cwd, prompt)
      } else if (transport === 'inline' && prompt.length > ARG_PROMPT_LIMIT) {
        prompt = prompt.slice(0, ARG_PROMPT_LIMIT)
      }
      options.signal?.throwIfAborted()
      const args = route.buildArgs(options.model, prompt, promptFile, { cwd: this.config.cwd })
      child = spawnCommand(route, args, {
        cwd: this.config.cwd,
        windowsHide: true,
        env: process.env,
        stdio: [transport === 'stdin' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      })
      child.stdin?.on('error', () => {})
      if (transport === 'stdin') child.stdin?.end(prompt)
    } catch (error) {
      removePromptFile()
      this.recordFailure(provider, options.model, startedAt, error.message, auxiliary)
      throw error
    }

    let stderr = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    let aborted = false
    const onAbort = () => {
      aborted = true
      child.kill()
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const timeoutMs = this.config.timeoutMs
    let timedOut = false
    const timer = timeoutMs ? setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs) : undefined
    const cleanup = () => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      if (child.exitCode === null) child.kill()
      removePromptFile()
    }

    let text = ''
    let finalText = ''
    let reasoningText = ''
    let usage
    let cost
    let cliError = ''
    let stdout = ''
    let nextIndex = 0
    let textIndex = -1
    let reasoningIndex = -1

    try {
      const closed = new Promise((resolve) => {
        child.on('close', (code, signal) => resolve({ code, signal }))
        child.on('error', (error) => resolve({ code: null, signal: null, error }))
      })
      const reader = createInterface({ input: child.stdout, crlfDelay: Infinity })
      for await (const line of reader) {
        const trimmed = line.trim()
        if (trimmed.length === 0) continue
        stdout += `${line}\n`
        const parsed = route.parseLine(trimmed)
        if (!parsed) continue
        if (parsed.error) {
          cliError = parsed.error
          child.kill()
          continue
        }
        if (parsed.text) {
          if (textIndex < 0) {
            textIndex = nextIndex++
            yield { type: 'block-start', index: textIndex, blockType: 'text' }
          }
          text += parsed.text
          yield { type: 'text-delta', index: textIndex, text: parsed.text }
        }
        if (parsed.final) finalText = parsed.final
        if (parsed.reasoning) {
          if (reasoningIndex < 0) {
            reasoningIndex = nextIndex++
            yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' }
          }
          reasoningText += parsed.reasoning
          yield { type: 'reasoning-delta', index: reasoningIndex, text: parsed.reasoning }
        }
        if (parsed.usage) usage = parsed.usageDelta ? addUsage(usage, parsed.usage) : parsed.usage
        if (parsed.cost !== undefined) cost = parsed.cost
      }
      const exit = await closed
      if (exit?.error) {
        const message = `free-llm: failed to start "${route.displayName}": ${exit.error.message}`
        this.recordFailure(provider, options.model, startedAt, message, auxiliary)
        throw new Error(message)
      }
      if (aborted) {
        this.recordFailure(provider, options.model, startedAt, 'the request was aborted', auxiliary)
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'the request was aborted', code: 'ABORTED' } } }
        return
      }
      if (timedOut) {
        const message = `free-llm: "${route.displayName}" timed out after ${timeoutMs} ms`
        this.recordFailure(provider, options.model, startedAt, message, auxiliary)
        throw new Error(message)
      }
      if (cliError || (text.length > 0 && exit?.code !== 0)) {
        const detail = cliError || stderr.trim().slice(0, 500) || 'the CLI did not complete'
        const message = `free-llm: "${route.displayName}" failed (exit ${exit?.code ?? 'null'}): ${detail}`
        this.recordFailure(provider, options.model, startedAt, message, auxiliary)
        throw new Error(message)
      }
      if (text.length === 0 && finalText.length > 0) {
        text = finalText
        textIndex = nextIndex++
        yield { type: 'block-start', index: textIndex, blockType: 'text' }
        yield { type: 'text-delta', index: textIndex, text }
      }
      if (text.length === 0 && exit?.code === 0) {
        const answer = plainTextAnswer(stdout, stderr)
        if (answer.length > 0) text = answer
      }
      if (text.length === 0) {
        const detail = cliError || stderr.trim().slice(0, 500)
        const message = cliError
          ? `free-llm: "${route.displayName}" returned an error: ${cliError}`
          : `free-llm: "${route.displayName}" produced no reply (exit ${exit?.code ?? 'null'})${detail ? `: ${detail}` : ''}`
        this.recordFailure(provider, options.model, startedAt, message, auxiliary)
        throw new Error(message)
      }
      let calls = []
      try {
        if (bridgeEnabled) calls = bridgeCalls(text, offeredTools)
      } catch (error) {
        const message = `free-llm: invalid DSH tool request: ${error.message}`
        this.recordFailure(provider, options.model, startedAt, message, auxiliary)
        throw new Error(message)
      }
      if (calls.length) {
        for (const call of calls) {
          const index = nextIndex++
          yield { type: 'block-start', index, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index, id: call.id, name: call.name, argumentsDelta: call.arguments }
          yield { type: 'block-end', index, block: call }
        }
      } else {
        if (textIndex < 0) {
          textIndex = nextIndex++
          yield { type: 'block-start', index: textIndex, blockType: 'text' }
        }
        yield { type: 'block-end', index: textIndex, block: { type: 'text', text } }
      }
      if (reasoningIndex >= 0) {
        yield { type: 'block-end', index: reasoningIndex, block: { type: 'reasoning', text: reasoningText } }
      }
      if (usage) yield { type: 'usage', usage }
      this.ledger?.record({
        at: startedAt,
        ms: Date.now() - startedAt,
        provider,
        model: options.model,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        cacheReadTokens: usage?.cacheReadTokens ?? 0,
        costUsd: cost,
        ok: true,
        ...(auxiliary ? { auxiliary: true } : {}),
      })
      yield { type: 'finish', reason: { kind: calls.length ? 'tool-calls' : 'stop' } }
    } finally {
      cleanup()
    }
  }
}

function addUsage(current, next) {
  return {
    inputTokens: (current?.inputTokens ?? 0) + (next.inputTokens ?? 0),
    outputTokens: (current?.outputTokens ?? 0) + (next.outputTokens ?? 0),
    cacheReadTokens: (current?.cacheReadTokens ?? 0) + (next.cacheReadTokens ?? 0),
    cacheWriteTokens: (current?.cacheWriteTokens ?? 0) + (next.cacheWriteTokens ?? 0),
    reasoningTokens: (current?.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0),
  }
}

/** The sign-in tool the IDE can call when a CLI needs an account. */
function buildTools(manager) {
  const providers = CATALOG.filter((entry) => entry.login).map((entry) => entry.id)
  return [
    {
      name: 'free_llm_sign_in',
      description:
        `Sign in one of the free CLI providers: ${providers.join(', ')}. ` +
        'Returns the page or code to confirm. A provider that is already signed in reports that instead of asking again.',
      parameters: {
        type: 'object',
        properties: { provider: { type: 'string', enum: providers } },
        required: ['provider'],
      },
      async run({ provider }) {
        const status = await manager.status(provider)
        if (status.signedIn) return { signedIn: true, detail: status.text }
        const started = await manager.start(provider)
        const where = [started.url ? `open ${started.url}` : undefined, started.code ? `confirm code ${started.code}` : undefined]
          .filter(Boolean)
          .join(' and ')
        return {
          signedIn: false,
          instruction: where ? `${where}, then try again.` : 'Sign in on the host, then try again.',
          note: started.note,
        }
      },
    },
  ]
}

/** Register the routes, the sign-in tool and the status page. */
export function apply(ctx, config) {
  const raw = config && typeof config === 'object' ? config : {}
  const providers = buildRoutes(raw)
  if (Object.keys(providers).length === 0) {
    ctx.logger?.warn?.('free-llm: no CLI routes enabled')
    return
  }
  const normalized = {
    cwd: typeof raw.cwd === 'string' && raw.cwd.length > 0 ? raw.cwd : process.cwd(),
    providers,
    includeSystemPrompt: raw.includeSystemPrompt !== false,    timeoutMs: Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0 ? raw.timeoutMs : DEFAULT_TIMEOUT_MS,
    installTimeoutMs: Number.isFinite(raw.installTimeoutMs) && raw.installTimeoutMs > 0 ? raw.installTimeoutMs : 600000,
    cliInstallDir:
      typeof raw.cliInstallDir === 'string' && isAbsolute(raw.cliInstallDir)
        ? raw.cliInstallDir
        : profilePath('.dsh', 'free-llm', 'clis'),
    usageFile:
      typeof raw.usageFile === 'string' && raw.usageFile.length > 0
        ? raw.usageFile
        : profilePath('.dsh', 'free-llm-usage.json'),
  }
  clearPromptFiles(normalized.cwd)
  const setup = new CliSetupManager(normalized)
  const manager = new SignInManager(normalized)
  const ledger = new UsageLedger(normalized.usageFile)
  ctx.effect?.(() => () => setup.dispose())

  const adapter = new CliAdapter(ctx, normalized, setup, ledger)
  // The host refuses two adapters under the same provider name and does it
  // all-or-nothing, so each route is registered on its own: a name another
  // plugin already owns is left to that plugin instead of taking the whole
  // bundle down.
  const mounted = []
  const taken = []
  for (const id of Object.keys(providers)) {
    try {
      const unregister = ctx.llm.registerAdapter([id], adapter)
      if (typeof unregister === 'function') ctx.effect?.(() => unregister)
      mounted.push(id)
    } catch (error) {
      taken.push({ id, reason: error?.message ?? String(error) })
      ctx.logger?.warn?.(`free-llm: "${id}" is already served by another plugin`)
    }
  }
  if (mounted.length === 0) {
    ctx.logger?.warn?.('free-llm: no route could be mounted')
    return
  }

  ctx.inject(['tools'], (child) => {
    for (const tool of buildTools(manager)) child.tools.register(tool)
  })

  ctx.inject(['webServer'], (child) => {
    const disposers = [
      child.webServer.register({
        kind: 'exact',
        path: '/free-llm/status.json',
        handler: async (request, response) => {
          // Every route asks its own CLI, so they go together: one slow probe
          // must not hold the others behind it.
          const routes = await Promise.all(
            Object.entries(providers).map(async ([id, route]) => {
              if (!mounted.includes(id)) {
                return {
                  id,
                  name: route.displayName,
                  family: route.family,
                  notes: 'Esta ruta la sirve otro plugin del perfil, así que aquí no se monta.',
                  providerLabel: route.providerLabel,
                  accent: route.accent,
                  installed: setup.status(id).installed,
                  models: [],
                  mounted: false,
                  signedIn: null,
                }
              }
              const wantsSignIn =
                route.credentials?.length || CATALOG.find((entry) => entry.id === id)?.login
              return {
                id,
                name: route.displayName,
                family: route.family,
                notes: route.notes,
                defaultModel: route.defaultModel,
                providerLabel: route.providerLabel,
                accent: route.accent,
                installed: setup.status(id).installed,
                models: await adapter.listModels(id),
                mounted: true,
                signedIn: wantsSignIn
                  ? (await manager.status(id).catch(() => ({ signedIn: null }))).signedIn
                  : null,
              }
            }),
          )
          response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          response.end(JSON.stringify({ routes, usage: ledger.summary() }))
        },
      }),
    ]
    for (const dispose of disposers) ctx.effect?.(() => dispose)
  })

  ctx.logger?.info?.(`free-llm: routes ${mounted.join(', ')}`)
}

export { buildRoutes, buildTools, resolveWindowsShim }
