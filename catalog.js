/**
 * dsh-free-llm — catálogo de las CLIs gratuitas que el plugin monta como rutas de LLM.
 *
 * Una entrada describe una CLI de punta a punta: dónde está su binario, cómo se
 * instala si falta, cómo lista sus modelos, cómo se le pide una respuesta y qué
 * credenciales guardaría si esa CLI pide sesión.
 *
 * El motor (index.js) convierte cada entrada en una ruta de LLM. Añadir una CLI
 * nueva es añadir una entrada aquí, sin tocar el motor.
 *
 * Los identificadores de modelo son reales, no inventados: se leyeron de los
 * catálogos vivos de cada CLI el 2026-11-10. Los listados en vivo mandan sobre
 * estos; la lista fija es el respaldo cuando la CLI no puede responder (sin red,
 * base de datos local dañada).
 */

const HOME = {
  appData: process.env.APPDATA,
  profile: process.env.USERPROFILE ?? process.env.HOME,
}

/** Un shim de npm global, con el paquete real para el instalador. */
function npmShim(name, packageName, extraCandidates = []) {
  return {
    bin: [name],
    npm: packageName,
    candidates: [
      ...(HOME.appData ? [`${HOME.appData}\\npm\\${name}.cmd`, `${HOME.appData}\\npm\\${name}`] : []),
      ...extraCandidates,
    ],
  }
}

/** Modelos que el gateway de Kilo declara con precio cero (verificado 2026-11-10). */
const KILO_FREE_MODELS = [
  'kilo/kilo-auto/free',
  'kilo/openrouter/free',
  'kilo/cohere/north-mini-code:free',
  'kilo/dots-studio/dots-3-note-preview:free',
  'kilo/liquid/lfm-3-1.7b:free',
  'kilo/nvidia/nemotron-3-ultra-550b-a55b:free',
  'kilo/nvidia/nemotron-3.5-lightning:free',
  'kilo/nvidia/nemotron-3.5-super-vl:free',
  'kilo/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'kilo/thinkingmachines/inkling-2-small:free',
]

/** Modelos que la CLI de OpenCode lista con precio cero (verificado 2026-11-10). */
const OPENCODE_FREE_MODELS = [
  'opencode/beam-free',
  'opencode/big-pickle',
  'opencode/deepseek-v4-flash-free',
  'opencode/deepseek-v4.1-flash-free',
  'opencode/flint-40b-free',
  'opencode/glm-5.3-flash-free',
  'opencode/iceman-free',
  'opencode/inkling-2-small-free',
  'opencode/longcat-2.5-free',
  'opencode/mimo-v2.6-flash-free',
  'opencode/minimax-m3.1-flash-free',
  'opencode/nemotron-3.5-lightning-free',
  'opencode/nemotron-3.5-super-vl-free',
]

/**
 * Los modelos gratuitos de Clixad rotan cada día: `clixad models` los marca con
 * "[free: ~N turns left today]" o "covered". Estos son los que estaban libres
 * el 2026-11-10 y sirven de respaldo si la lista en vivo falla.
 */
const CLIXAD_FREE_MODELS = [
  'claude-haiku-5.5',
  'deepseek-v4-flash',
  'gemini-2.5-flash-lite',
  'gemini-3.5-flash-lite',
  'gpt-5-nano',
]

/** Modelos que ofrece Qoder CLI (verificado 2026-11-10 con la CLI 1.1.80). */
const QODER_MODELS = [
  'Auto',
  'Ultimate',
  'Fast',
  'Efficient',
  'Sonus',
  'Cantus',
  'Qwen4-Max-Preview',
  'Qwen3.8-Max',
  'Qwen3.8-Flash',
  'Kimi-K3.1-Pro',
  'Kimi-K2.8-Preview',
  'GLM-5.3',
  'GLM-5.3-Flash',
  'DeepSeek-V4-Pro',
  'DeepSeek-Flash',
  'MiniMax-M3.1-Flash',
]

/**
 * Herramientas que la CLI de Copilot trae consigo. Se le quitan para que la
 * IA use las herramientas de la IDE a través del puente del host, no las suyas.
 */
const COPILOT_OWN_TOOLS = [
  'powershell',
  'read_powershell',
  'stop_powershell',
  'list_powershell',
  'view',
  'create',
  'edit',
  'web_fetch',
  'fetch_copilot_cli_documentation',
  'search_code_subagent',
  'semantic_code_search',
  'skill',
  'run_dynamic_workflow',
  'dynamic_workflows_manage',
  'sql',
  'session_store_sql',
  'read_agent',
  'list_agents',
  'write_agent',
  'grep',
  'glob',
  'task',
]

/** Las herramientas propias de Grok, que también se le quitan. */
const GROK_OWN_TOOLS = [
  'run_terminal_command',
  'read_file',
  'search_replace',
  'list_dir',
  'grep',
  'kill_command_or_subagent',
  'todo_write',
  'get_command_or_subagent_output',
  'spawn_subagent',
  'scheduler_create',
  'scheduler_delete',
  'scheduler_list',
  'monitor',
  'search_tool',
  'use_tool',
  'workflow',
  'enter_plan_mode',
  'exit_plan_mode',
  'ask_user_question',
  'send_feedback',
  'web_search',
  'web_fetch',
  'image_gen',
  'image_edit',
  'image_to_video',
  'reference_to_video',
  'write',
]

/**
 * Herramientas que trae la CLI de Qoder. Se le quitan para que la IA use las
 * herramientas de la IDE a través del puente del host, no las suyas.
 */
const QODER_OWN_TOOLS = [
  'Bash',
  'BashInput',
  'BashOutput',
  'BashResize',
  'PowerShell',
  'Read',
  'Write',
  'Edit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'ImageSearch',
  'ImageGen',
  'VideoGen',
  'VideoGenRetrieve',
  'TodoWrite',
  'Skill',
  'AskUserQuestion',
  'ExitPlanMode',
  'EnterPlanMode',
  'Monitor',
  'TaskStop',
  'Agent',
  'SendMessage',
  'EnterWorktree',
  'ExitWorktree',
  'CompleteTask',
  'CodebaseInvestigator',
]

export const CATALOG = [
  {
    id: 'kilo',
    displayName: 'Kilo Code (CLI) · gratis',
    providerLabel: 'Kilo Code',
    accent: '#f59e0b',
    tone: 'warning',
    blurb: 'Modelo gratuito del gateway de Kilo: sin clave, sin registro y sin cuota.',
    family: 'text',
    invocation: 'run-model',
    ...npmShim('kilo', '@kilocode/cli'),
    listArgs: ['models'],
    listParser: 'ids',
    filterFree: true,
    defaultModel: 'kilo/kilo-auto/free',
    models: KILO_FREE_MODELS,
    credentials: [],
    login: null,
    notes:
      'Kilo CLI es un fork de OpenCode. Sus modelos gratuitos vienen del gateway de Kilo, ' +
      'sin clave ni registro. En esta máquina contesta en texto plano.',
  },
  {
    id: 'opencode',
    displayName: 'OpenCode (CLI) · gratis',
    providerLabel: 'OpenCode',
    accent: '#22c55e',
    tone: 'success',
    blurb: 'Modelo de precio cero del catálogo de OpenCode.',
    family: 'opencode',
    invocation: 'run-model',
    ...npmShim('opencode', 'opencode-ai'),
    listArgs: ['models'],
    listParser: 'ids',
    filterFree: true,
    defaultModel: 'opencode/deepseek-v4.1-flash-free',
    models: OPENCODE_FREE_MODELS,
    credentials: [`${HOME.profile}\\.local\\share\\opencode\\auth.json`],
    login: {
      loginArgs: ['auth', 'login', 'opencode', '--method', 'device'],
      statusArgs: ['auth', 'list'],
      signedIn: (out) =>
        /\bstored\b|\boauth\b|\bapi[- ]key\b|\benv\b/i.test(out) &&
        !/no (?:authenticated )?integrations|0 credentials|not authenticated/i.test(out),
      note: 'Los modelos gratuitos de OpenCode no piden sesión; esto es solo para una cuenta de pago.',
      optional: true,
    },
    notes: 'Su CLI solo lista los modelos con precio cero, así que el selector sale limpio.',
  },
  {
    id: 'clixad',
    displayName: 'Clixad (CLI) · gratis con anuncios',
    providerLabel: 'Clixad',
    accent: '#a855f7',
    tone: 'neutral',
    blurb: 'Modelo que la CLI de Clixad marca como gratis hoy; la lista rota cada día.',
    family: 'text',
    invocation: 'print',
    ...npmShim('clixad', 'clixad'),
    listArgs: ['models'],
    listParser: 'marked-free',
    defaultModel: 'deepseek-v4-flash',
    models: CLIXAD_FREE_MODELS,
    credentials: [],
    login: {
      loginArgs: ['login'],
      statusArgs: ['whoami'],
      signedIn: (out) =>
        /balance|credits|@|signed in/i.test(out) && !/not (?:signed|logged) in|logged out/i.test(out),
      note: 'Clixad guarda el token en la máquina; si ya hay sesión, no se vuelve a pedir.',
    },
    notes:
      'Clixad se paga con anuncios: cada turno gasta turnos gratuitos que se renuevan a diario. ' +
      'Su propio comando dice cuáles están libres hoy.',
  },
  {
    id: 'copilot',
    displayName: 'GitHub Copilot (CLI) · con tu plan',
    providerLabel: 'GitHub Copilot',
    accent: '#6366f1',
    tone: 'info',
    blurb: 'Modelo que tu plan de GitHub deja disponible desde la CLI.',
    family: 'copilot',
    invocation: 'print',
    promptMode: 'inline',
    bin: ['copilot'],
    npm: '@github/copilot',
    candidates: [
      // El IDE trae su propia copia de la CLI; su shim tiene un espacio en la ruta,
      // así que el motor lo resuelve al script real y lo lanza con node.
      ...(HOME.appData ? [`${HOME.appData}\\ideep code\\ideep\\node\\*\\copilot.cmd`] : []),
      ...(HOME.appData ? [`${HOME.appData}\\npm\\copilot.cmd`] : []),
    ],
    listArgs: null,
    listParser: 'ids',
    defaultModel: 'mai-code-1.1-flash',
    models: ['mai-code-1.1-flash'],
    credentials: [`${HOME.profile}\\.copilot\\config.json`],
    credentialPattern: /"loggedInUsers"\s*:\s*\[\s*\{/,
    extraArgs: ['--output-format', 'json', '--excluded-tools', ...COPILOT_OWN_TOOLS],
    login: {
      loginArgs: ['login'],
      statusArgs: ['--version'],
      signedIn: (out) => /copilot cli/i.test(out),
      note: 'La sesión de Copilot CLI es la misma de GitHub en esta máquina.',
    },
    notes:
      'Copilot CLI usa la cuota que ya viene con tu plan de GitHub. Su CLI no tiene comando de ' +
      'modelos, así que la lista sale del catálogo; el modelo lo elige la CLI.',
  },
  {
    id: 'grok',
    displayName: 'Grok (xAI CLI) · con tu cuenta',
    providerLabel: 'Grok (xAI)',
    accent: '#ef4444',
    tone: 'danger',
    blurb: 'Modelo de xAI: cobra por token.',
    family: 'grok',
    invocation: 'print',
    promptMode: 'inline',
    bin: ['grok'],
    npm: null,
    candidates: [
      ...(HOME.profile ? [`${HOME.profile}\\.grok\\bin\\grok.exe`, `${HOME.profile}\\.grok\\bin\\grok`] : []),
    ],
    listArgs: ['models'],
    listParser: 'grok',
    defaultModel: 'grok-4.7',
    models: ['grok-4.7'],
    credentials: [`${HOME.profile}\\.grok\\auth.json`],
    extraArgs: ['--output-format', 'streaming-json', '--disallowed-tools', GROK_OWN_TOOLS.join(',')],
    login: {
      loginArgs: ['login'],
      statusArgs: ['models'],
      signedIn: (out) => /logged in with/i.test(out),
      note: 'Grok CLI guarda el token en ~/.grok/auth.json; si ya está, no se vuelve a pedir.',
    },
    notes:
      'Grok CLI usa la sesión de grok.com que ya tienes en esta máquina. Ojo: cobra por token, ' +
      'no es un modelo gratuito como los de Kilo u OpenCode.',
  },
  {
    id: 'qoder',
    displayName: 'Qoder CLI (Qoder) · con tu sesión',
    providerLabel: 'Qoder CLI',
    accent: '#0ea5e9',
    tone: 'success',
    blurb: 'Modelo de Qoder CLI, con la sesión de tu IDE.',
    family: 'text',
    invocation: 'print',
    modelFlag: true,
    // La CLI se instala en la carpeta que el plugin posee. La 1.1.85 que trae el
    // IDE pide un SDK más nuevo del que hay, así que la versión va fijada.
    bin: ['qodercli'],
    npm: '@qoder-ai/qodercli@1.1.80',
    candidates: [
      ...(HOME.profile
        ? [`${HOME.profile}\\.dsh\\free-llm\\clis\\qoder\\node_modules\\@qoder-ai\\qodercli\\bundle\\qodercli.js`]
        : []),
    ],
    listArgs: ['--list-models'],
    listParser: 'ids',
    defaultModel: 'Auto',
    models: QODER_MODELS,
    credentials: [`${HOME.profile}\\.qoder\\.auth`],
    // Sin MCP propios y sin sus herramientas: la IA habla con la IDE por el puente.
    extraArgs: [
      '--strict-mcp-config',
      ...QODER_OWN_TOOLS.flatMap((tool) => ['--disallowed-tools', tool]),
    ],
    // Variables internas de la IDE: heredadas hacen que la CLI salga sin responder.
    stripEnv: [
      'QODER_AGENT_SDK_ENTRYPOINT',
      'QODER_WORKER_CWD',
      'QODER_WORKER_RUNTIME_ASSET_ROOT',
      'QODER_SESSION_TYPE',
      'QODER_SDK_AUTH_PAYLOAD_FILE',
      'QODERCLI_RUNTIME_PACKAGING',
    ],
    login: {
      loginArgs: ['login'],
      statusArgs: ['status'],
      signedIn: (out) => /username|email|auth source/i.test(out),
      note: 'La sesión de Qoder CLI es la misma que la del IDE.',
    },
    notes:
      'Qoder CLI expone plugins, MCP, skills y agents de la IDE y usa tu sesión. Arranca despacio ' +
      '(unos 40 s), pero contesta. La versión 1.1.80 va fijada porque la 1.1.85 del IDE pide un ' +
      'SDK que no está instalado.',
  },
]

export const CATALOG_BY_ID = Object.fromEntries(CATALOG.map((entry) => [entry.id, entry]))
