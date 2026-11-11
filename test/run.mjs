/**
 * Contract test for dsh-free-llm.
 *
 * It mounts the plugin the way the harness does, then asks every enabled route
 * for its free models and for one real turn. The CLIs answer over the network,
 * so the test needs them installed and reachable.
 *
 *   node test/run.mjs            # every route
 *   node test/run.mjs kilo       # one route
 *   node test/run.mjs qoder bridge   # one route, plus the IDE tool bridge
 */
import { apply } from '../index.js'

const only = process.argv[2]
const withBridge = process.argv.includes('bridge')
const results = []

function fakeCtx() {
  const state = { adapters: [], tools: [] }
  const ctx = {
    state,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect: () => {},
    inject: () => {},
    llm: {
      registerAdapter(names, adapter) {
        state.adapters.push({ names, adapter })
        return () => {}
      },
    },
    tools: { register: (tool) => state.tools.push(tool) },
  }
  return ctx
}

const ctx = fakeCtx()
apply(ctx, {})

if (ctx.state.adapters.length === 0) {
  console.error('no routes were registered')
  process.exit(1)
}

// Cada ruta se registra con su propio adapter, así que se recorren todos.
const routes = ctx.state.adapters
  .flatMap((entry) => entry.names.map((name) => ({ name, adapter: entry.adapter })))
  .filter((entry) => !only || entry.name === only)

if (routes.length === 0) {
  console.error(`no route matched "${only ?? '*'}"`)
  process.exit(1)
}

for (const { name: route, adapter } of routes) {
  const models = await adapter.listModels(route)
  results.push({ route, models: models.length, ok: models.length > 0 })
  console.log(`${route}: ${models.length} free models -> ${models.slice(0, 4).map((model) => model.id).join(', ')}`)
  console.log(`${route}: selector names -> ${models.slice(0, 4).map((model) => model.name).join(' | ')}`)

  // The contract the host checks before it paints the selector: every model
  // carries provider, id and name, ids never repeat, and the badge that holds
  // the provider colour uses a tone the UI knows. The host forwards the tone
  // untouched, so the set that matters is the one the Tag component paints.
  const TONES = new Set([
    'neutral',
    'info',
    'success',
    'warning',
    'danger',
    'outline',
    'solid',
    'quiet',
  ])
  const seen = new Set()
  let catalogOk = models.length > 0
  for (const model of models) {
    if (model.provider !== route) catalogOk = false
    if (typeof model.id !== 'string' || model.id.length === 0) catalogOk = false
    if (typeof model.name !== 'string' || model.name.length === 0) catalogOk = false
    if (seen.has(model.id)) catalogOk = false
    seen.add(model.id)
    if (!model.badge || !TONES.has(model.badge.tone)) catalogOk = false
  }
  results.push({ route, catalog: catalogOk ? 'ok' : 'bad', ok: catalogOk })
  console.log(`${route}: catalog contract -> ${catalogOk ? 'ok' : 'BAD'}`)

  // The exact-model metadata: the host rejects a bare id here and drops the
  // whole provider out of the selector.
  const info = await adapter.resolveModel(route, models[0]?.id)
  const infoOk =
    Boolean(info) &&
    info.provider === route &&
    info.id === models[0]?.id &&
    typeof info.name === 'string' &&
    info.name.length > 0 &&
    Number.isInteger(info.context?.contextWindow) &&
    info.context.contextWindow > 0
  results.push({ route, resolve: infoOk ? 'ok' : 'bad', ok: infoOk })
  console.log(`${route}: resolveModel -> ${JSON.stringify(info)}`)

  // The selector waits for this answer, so it has to come back at once even
  // when the CLI behind it is slow.
  adapter.listCache?.clear?.()
  const startedAt = Date.now()
  await adapter.listModels(route)
  const listMs = Date.now() - startedAt
  const fastOk = listMs < 3000
  results.push({ route, listMs, ok: fastOk })
  console.log(`${route}: cold catalog -> ${listMs} ms ${fastOk ? 'ok' : 'TOO SLOW'}`)

  const call = await adapter.prepareCall(route, models[0]?.id, undefined)
  const events = []
  for await (const event of call.stream({
    provider: route,
    model: call.model,
    messages: [{ role: 'user', content: 'responde solo: OK' }],
    tools: [],
  })) {
    events.push(event)
    if (event.type === 'text-delta') events.text = (events.text ?? '') + event.text
  }
  const answer = (events.text ?? '').trim()
  const finished = events.find((event) => event.type === 'finish')
  const ok = answer.length > 0 && finished?.reason?.kind === 'stop'
  results.push({ route, turn: answer, ok })
  console.log(`${route}: turn -> ${JSON.stringify(answer.slice(0, 120))}`)

  if (!withBridge) continue

  // The bridge: the IDE offers a tool, the CLI must ask for THAT tool and not
  // for one of its own.
  const bridgeCall = await adapter.prepareCall(route, models[0]?.id, undefined)
  const bridgeEvents = []
  for await (const event of bridgeCall.stream({
    provider: route,
    model: bridgeCall.model,
    messages: [
      {
        role: 'user',
        content: 'Usa la herramienta read_file para leer README.md. No lo hagas tú con tus propias herramientas.',
      },
    ],
    tools: [
      {
        name: 'read_file',
        description: 'Read a file from disk.',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
    ],
  })) {
    bridgeEvents.push(event)
  }
  const toolCall = bridgeEvents.find((event) => event.type === 'tool-call-delta')
  const bridgeFinish = bridgeEvents.find((event) => event.type === 'finish')
  const bridgeOk = Boolean(toolCall) && toolCall.name === 'read_file' && bridgeFinish?.reason?.kind === 'tool-calls'
  results.push({ route, bridge: toolCall?.name ?? 'none', ok: bridgeOk })
  console.log(`${route}: bridge -> ${toolCall ? `${toolCall.name} ${toolCall.argumentsDelta}` : 'no tool call'}`)
}

const failed = results.filter((entry) => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  console.error('failed:', failed.map((entry) => entry.route).join(', '))
  process.exit(1)
}
// The background refresh of the live catalog may still hold a CLI process.
process.exit(0)
