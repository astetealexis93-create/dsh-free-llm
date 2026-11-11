# dsh-free-llm

**Las IAs que ya tenés instaladas, servidas como rutas de LLM para DeepSeek Harness (y cualquier otra IDE que monte plugins de cordis).**

Kilo Code, OpenCode, Clixad, GitHub Copilot, Grok (xAI) y Qoder CLI ya viven en tu máquina, con su sesión
abierta y sus modelos gratuitos. Este plugin los monta como **proveedores de modelos** dentro del selector de
la IDE: no pide credenciales otra vez, no descarga un segundo binario y no te saca de tu cuenta.

Además, cada turno **cruza las herramientas de la IDE dentro de la CLI**: los complementos que tenés
instalados (MCP, herramientas propias, lectura de archivos) quedan disponibles para la IA que vive en la
CLI, no solo para la que vive en el chat. Las tools que trae la propia CLI se desactivan, para que la IA use
las de la IDE y no las suyas.

---

## Qué hace

- **Adopta la CLI que ya está.** Busca el binario en el PATH, en el npm global, en el npm privado de la
  IDE y en su propia carpeta de instalación. Si no está, la instala con npm en una carpeta propia.
- **Respeta la sesión que ya tenés.** Si el CLI tiene credenciales guardadas en la máquina, el plugin lo
  detecta y no vuelve a pedir login. Solo arranca un inicio de sesión cuando de verdad falta.
- **Publica los modelos gratuitos** de cada CLI en el selector, con los nombres reales de cada modelo. Si
  una CLI ofrece varios, el nombre va con su proveedor (`deepseek-v4.1-flash-free (OpenCode)`); si ofrece uno
  solo, va el modelo pelado. Cada proveedor aparece en su propio grupo del selector y lleva su color: en la
  página del plugin con el color exacto, y en el selector del chat con la insignia del proveedor.
- **Cruza las tools de la IDE** a cada turno con un puente JSON validado, y devuelve las llamadas como
  tool calls del harness.
- **Anota el uso** de cada turno (proveedor, modelo, tokens, duración) y lo muestra en su propia página.
- **No se pisa con la CLI.** Cada CLI tiene su propia sesión en la máquina, así que un turno, un listado de
  modelos y una comprobación de sesión de la misma ruta nunca corren a la vez.

---

## Proveedores incluidos

| Proveedor | CLI | Modelos | Sesión |
|---|---|---|---|
| `kilo` | [Kilo Code](https://github.com/Kilo-Org/kilocode) (`@kilocode/cli`) | 10 modelos `:free` del gateway de Kilo (`kilo/kilo-auto/free`, Nemotron, LFM, North Mini Code…) | No hace falta: el gateway no pide clave |
| `opencode` | [OpenCode](https://opencode.ai) (`opencode-ai`) | Los modelos con precio cero de su catálogo (`opencode/deepseek-v4.1-flash-free`, `opencode/glm-5.3-flash-free`…) | Opcional, solo para una cuenta de pago |
| `clixad` | [Clixad](https://clixad.dev) (`clixad`) | Los que el propio CLI marca como libres hoy (rota cada día) | Se reutiliza la sesión guardada |
| `copilot` | [GitHub Copilot CLI](https://github.com/github/copilot-cli) (`@github/copilot`) | Los que tu plan de GitHub deja disponibles (`mai-code-1.1-flash`) | Se reutiliza la sesión de GitHub |
| `grok` | [Grok CLI](https://github.com/xai-org/grok-cli) | `grok-4.7` | Se reutiliza la sesión de grok.com |
| `qoder` | [Qoder CLI](https://qoder.com/cli) (`@qoder-ai/qodercli`, fijada en 1.1.80) | Los que la CLI lista en vivo (`Auto`, `GLM-5.3`, `DeepSeek-V4-Pro`, `Qwen3.8-Max`, `MiniMax-M3.1-Flash`…) | Se reutiliza la sesión del IDE |

Los identificadores son reales, leídos de los catálogos vivos de cada CLI. La lista en vivo manda; la lista
fija del catálogo es el respaldo cuando la CLI no puede responder (sin red, base de datos local dañada).

**Sobre lo gratis de verdad:** Kilo, OpenCode y Clixad dan modelos de precio cero. Copilot gasta la cuota que
ya viene con tu plan de GitHub. Grok cobra por token. Qoder CLI usa lo que tu sesión del IDE tiene. El plugin
no promete nada que la CLI no cumpla: cada proveedor dice en su tarjeta lo que cuesta.

**Qoder CLI arranca despacio**: unos 40 segundos antes de que conteste, porque levanta plugins, skills y
sus propios MCP. Por eso el plugin le pasa `--strict-mcp-config` y le quita sus herramientas: la IA habla con
la IDE por el puente, no con la caja de herramientas de la CLI. La versión va fijada en 1.1.80 porque la
1.1.85 que trae el IDE pide un SDK que no está instalado en esta máquina.

---

## Instalación

### En DeepSeek Harness

Pega el link del repo en el instalador de plugins, igual que con cualquier otro bundle:

```
https://github.com/astetealexis93-create/dsh-free-llm
```

El perfil monta el plugin y las rutas aparecen en el selector de modelos.

### En otra IDE con cordis

En el `package.json` del perfil:

```json
{
  "dependencies": {
    "dsh-free-llm": "github:astetealexis93-create/dsh-free-llm"
  }
}
```

Y el bundle en `cordis.patch.yml`:

```yaml
- insert:
    - id: free-llm
      name: dsh-free-llm
```

### Para desarrollar en local

```bash
git clone https://github.com/astetealexis93-create/dsh-free-llm.git
cd dsh-free-llm
npm link --no-audit --no-fund
```

y en el perfil: `"dsh-free-llm": "link:/ruta/a/dsh-free-llm"`.

---

## Configuración

Todo es opcional; el perfil manda. En el `cordis.patch.yml` del perfil:

```yaml
- insert:
    - id: free-llm
      name: dsh-free-llm
      config:
        providers:
          clixad: false          # apagar un proveedor
          opencode:
            defaultModel: opencode/glm-5-free
        includeSystemPrompt: false
        timeoutMs: 600000
```

| Clave | Qué hace |
|---|---|
| `providers.<id>.enabled` / `false` | Apaga un proveedor |
| `providers.<id>.defaultModel` | Modelo por defecto de esa ruta |
| `providers.<id>.bin` | Ruta explícita del binario |
| `providers.<id>.models` | Fija la lista de modelos |
| `includeSystemPrompt` | Si el prompt de sistema llega a la CLI |
| `timeoutMs` | Tiempo máximo de un turno |
| `cliInstallDir` | Dónde se instalan las CLIs que falten |
| `usageFile` | Dónde se guarda el registro de uso |

---

## Cómo funciona

```
catalog.js   los datos: qué CLI, qué binario, qué modelos, cómo se instala
index.js     el motor: monta las rutas, ejecuta la CLI, traduce el streaming,
             cruza las tools y registra el uso
client.js    la página del plugin en la web del IDE
```

El motor habla con la CLI en su propio idioma:

- **Familia `opencode`** — CLIs que emiten NDJSON con `--format json` (Kilo, OpenCode). Es el mismo
  protocolo, así que un solo lector las cubre.
- **Familia `text`** — CLIs que contestan en texto plano (Clixad, Qoder CLI). El plugin recupera la respuesta
  tal cual.
- **Familia `copilot`** — Copilot CLI emite eventos JSON con el texto en trozos (`assistant.message_delta`).
- **Familia `grok`** — Grok CLI emite `text`, `thought` y `usage` en `streaming-json`.

En Windows, ningún `.cmd` se lanza con shell: el motor lee el shim, encuentra el script real y lo arranca con
node. Por eso funciona incluso con el espacio en `ideep code` del PATH de la IDE.

### El catálogo que pide el selector

El IDE le pregunta a cada ruta sus modelos antes de pintar el selector, así que la respuesta tiene que ser
inmediata. El plugin contesta con el catálogo fijo al instante y, cuando no hay turno en curso, refresca esa
lista con la CLI en vivo para la siguiente llamada. Cada modelo lleva el nombre que se ve, la descripción del
proveedor y la insignia que lleva su color.

El IDE también le pregunta los datos exactos de cada modelo (contexto, nombre). Ahí el plugin contesta con
el modelo completo: si devolviera solo el identificador, el IDE sacaría el proveedor entero del selector.

La insignia del selector no lleva un color libre: el IDE la pinta con una paleta cerrada y el plugin elige el
tono que más se acerca al color de cada proveedor. Kilo y OpenCode caen exactos (ámbar y verde); el resto se
acerca al tono más próximo de la paleta.

| Proveedor | Color de la insignia | Tono |
|---|---|---|
| Kilo Code | ámbar `#f59e0b` | `warning` |
| OpenCode | verde `#22c55e` | `success` |
| Clixad | gris | `neutral` |
| GitHub Copilot | azul `#4176e6` | `info` |
| Grok (xAI) | rojo `#ec1313` | `danger` |
| Qoder CLI | verde `#22c55e` | `success` |

### El puente de herramientas

El IDE ofrece sus tools al plugin; el plugin las describe en el prompt con un prefijo y un JSON validado:

```
DSH_TOOL_CALLS [{"name":"read_file","arguments":{"path":"README.md"}}]
```

El host ejecuta la tool con sus propias reglas de permisos y devuelve el resultado en el turno siguiente.
La CLI nunca dice que ejecutó algo antes de tener el resultado.

### Sesiones

El plugin **no guarda credenciales**: cada CLI sigue siendo la dueña de su sesión. Antes de ofrecer un
inicio de sesión, comprueba si ya hay una credencial en la máquina y, si la hay, la da por buena.

---

## Desarrollo

```bash
node test/run.mjs               # todas las rutas
node test/run.mjs qoder         # una sola
node test/run.mjs qoder bridge  # una sola, y además el puente de tools
```

## Licencia

MIT. Este plugin reutiliza el patrón de montaje de plugins de cordis y está inspirado en
[`dsh-llm-cli`](https://github.com/Mans230/dsh-llm-cli) de Mans230 (MIT).
