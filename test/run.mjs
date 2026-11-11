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
