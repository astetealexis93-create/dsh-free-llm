// Browser half of dsh-free-llm: the plugin's own page on the Web client.
//
// It shows the free CLI routes this plugin serves, grouped by provider: the
// models each CLI offers for free right now, whether the CLI is installed, and
// whether it already has a session on this machine. Every provider keeps its
// own accent color, so the list reads as a map of who is who. Below, the turns
// the plugin recorded.
//
// The page is registered twice: as a card in the Plugins panel and as a page
// in Settings.
//
// Loaded by the web client's module loader through this package's
// `dsh.client` manifest and `./client` export.
window.__ModuleLoader__.load({
  id: 'dsh-free-llm',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')

    const h = React.createElement
    const { useEffect, useState } = React

    const S = {
      page: { padding: '18px 20px', fontSize: 13, lineHeight: 1.55 },
      title: { fontSize: 16, fontWeight: 650, margin: '0 0 4px' },
      muted: { opacity: 0.66, margin: '0 0 14px', fontSize: 12 },
      card: {
        border: '1px solid rgba(128,128,128,.32)',
        borderRadius: 10,
        padding: '12px 14px',
        marginBottom: 12,
        display: 'flex',
        gap: 12,
      },
      bar: { width: 3, borderRadius: 3, flex: '0 0 3px' },
      body: { flex: '1 1 auto', minWidth: 0 },
      head: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' },
      name: { fontWeight: 650, fontSize: 14 },
      pill: {
        fontSize: 11,
        padding: '1px 7px',
        borderRadius: 999,
        border: '1px solid rgba(128,128,128,.4)',
        opacity: 0.85,
      },
      good: { color: '#46c98b' },
      bad: { color: '#e46c6c' },
      list: {
        margin: '10px 0 0',
        padding: 0,
        listStyle: 'none',
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill,minmax(230px,1fr))',
        gap: '4px 12px',
        fontSize: 12,
      },
      model: { fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', opacity: 0.9 },
      code: {
        fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace',
        fontSize: 11,
        background: 'rgba(128,128,128,.14)',
        padding: '1px 5px',
        borderRadius: 4,
      },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
      th: { textAlign: 'left', fontWeight: 600, padding: '4px 8px', borderBottom: '1px solid rgba(128,128,128,.32)' },
      td: { padding: '4px 8px', borderBottom: '1px solid rgba(128,128,128,.16)' },
    }

    function Pill({ tone, children }) {
      return h('span', { style: { ...S.pill, ...(tone === 'good' ? S.good : tone === 'bad' ? S.bad : {}) } }, children)
    }

    /** The model of a turn is its id, never the metadata object. */
    function modelName(model) {
      if (typeof model === 'string') return model
      if (model && typeof model === 'object') return model.id ?? ''
      return ''
    }

    function RouteCard({ route }) {
      const models = route.models ?? []
      const accent = route.accent ?? '#6366f1'
      return h(
        'div',
        { style: S.card },
        h('span', { style: { ...S.bar, background: accent } }),
        h(
          'div',
          { style: S.body },
          h(
            'div',
            { style: S.head },
            h('span', { style: { ...S.name, color: accent } }, route.providerLabel ?? route.name ?? route.id),
            h('span', { style: { ...S.code } }, route.id),
            h(Pill, { tone: route.installed ? 'good' : 'bad' }, route.installed ? 'instalada' : 'no instalada'),
            route.signedIn === true ? h(Pill, { tone: 'good' }, 'sesión abierta') : null,
            route.signedIn === false ? h(Pill, { tone: 'bad' }, 'sin sesión') : null,
          ),
          route.notes ? h('p', { style: { ...S.muted, margin: '8px 0 0' } }, route.notes) : null,
          h(
            'p',
            { style: { ...S.muted, margin: '8px 0 0' } },
            'Modelo por defecto: ',
            h('span', { style: { ...S.code, color: accent } }, route.defaultModel ?? '—'),
          ),
          models.length
            ? h(
                'ul',
                { style: S.list },
                models.map((model) =>
                  h(
                    'li',
                    { key: model.id, style: { ...S.model, color: accent }, title: model.id },
                    model.name ?? model.id,
                  ),
                ),
              )
            : h('p', { style: { ...S.muted, margin: '8px 0 0' } }, 'Sin modelos gratuitos para listar ahora.'),
        ),
      )
    }

    function UsageTable({ usage, accents }) {
      const all = usage?.entries ?? []
      const entries = all.filter((entry) => !entry.auxiliary)
      if (entries.length === 0) {
        return h('p', { style: S.muted }, 'Todavía no se registró ningún turno.')
      }
      const totals = usage?.totals ?? {}
      const auxiliary = totals.auxiliary ?? 0
      return h(
        'div',
        null,
        h(
          'p',
          { style: { ...S.muted, margin: '0 0 8px' } },
          `${totals.turns ?? 0} turnos · ${totals.ok ?? 0} bien · ${totals.failed ?? 0} con error · ` +
            `${totals.inputTokens ?? 0} tokens de entrada · ${totals.outputTokens ?? 0} de salida` +
            (auxiliary > 0 ? ` · ${auxiliary} auxiliares (título de sesión) fuera de la cuenta` : ''),
        ),
        h(
          'table',
          { style: S.table },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              h('th', { style: S.th }, 'Proveedor'),
              h('th', { style: S.th }, 'Modelo'),
              h('th', { style: S.th }, 'ms'),
              h('th', { style: S.th }, 'Entrada'),
              h('th', { style: S.th }, 'Salida'),
              h('th', { style: S.th }, 'Estado'),
            ),
          ),
          h(
            'tbody',
            null,
            entries
              .slice()
              .reverse()
              .map((entry, index) =>
                h(
                  'tr',
                  { key: `${entry.at}-${index}` },
                  h('td', { style: { ...S.td, color: accents[entry.provider] } }, entry.provider),
                  h('td', { style: { ...S.td, ...S.model } }, modelName(entry.model)),
                  h('td', { style: S.td }, entry.ms ?? ''),
                  h('td', { style: S.td }, entry.inputTokens ?? 0),
                  h('td', { style: S.td }, entry.outputTokens ?? 0),
                  h(
                    'td',
                    { style: S.td },
                    entry.ok ? h(Pill, { tone: 'good' }, 'ok') : h(Pill, { tone: 'bad' }, entry.error ?? 'error'),
                  ),
                ),
              ),
          ),
        ),
      )
    }

    function FreeLlmPage() {
      const [data, setData] = useState(null)
      const [error, setError] = useState('')

      useEffect(() => {
        let alive = true
        fetch('/free-llm/status.json')
          .then((response) => response.json())
          .then((payload) => {
            if (alive) setData(payload)
          })
          .catch((problem) => {
            if (alive) setError(String(problem))
          })
        return () => {
          alive = false
        }
      }, [])

      const accents = {}
      for (const route of data?.routes ?? []) accents[route.id] = route.accent ?? '#6366f1'

      return h(
        'div',
        { style: S.page },
        h('h2', { style: S.title }, 'IAs gratuitas por CLI'),
        h(
          'p',
          { style: S.muted },
          'Cada proveedor es una CLI instalada en esta máquina. El plugin adopta el binario y la sesión que ya existen, ' +
            'y expone sus modelos gratuitos en el selector de modelos.',
        ),
        error ? h('p', { style: { ...S.muted, color: '#e46c6c' } }, `No se pudo leer el estado: ${error}`) : null,
        data
          ? (data.routes ?? []).map((route) => h(RouteCard, { key: route.id, route }))
          : h('p', { style: S.muted }, 'Cargando estado de las rutas…'),
        data ? h('h3', { style: { ...S.title, marginTop: '20px' } }, 'Uso registrado') : null,
        data ? h(UsageTable, { usage: data.usage, accents }) : null,
      )
    }

    /** Required services (cordis fiber inject). */
    const inject = ['slots']

    /**
     * Register this plugin's UI twice: a card in the Plugins panel and a page
     * in Settings. Both render the same component.
     */
    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.slots.inject('plugins.item', () =>
            ctx.slots.register(
              { name: 'plugins.item', id: 'dsh-free-llm', order: 45, label: 'IAs gratuitas (CLI)' },
              FreeLlmPage,
            ),
          ),
        'free-llm: plugins-panel page',
      )
      ctx.effect(
        () =>
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              { name: 'settings.section', id: 'dsh-free-llm-usage', order: 60, label: 'IAs gratuitas' },
              FreeLlmPage,
            ),
          ),
        'free-llm: settings page',
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.FreeLlmPage = FreeLlmPage
    return module.exports
  },
})
