# Changelog

## 0.3.0 — 2026-11-11

- Qoder CLI joins the routes with the session the IDE already holds. Its version
  is pinned to 1.1.80, the newest one that runs against the SDK on this machine.
- A route can ask for a clean environment: Qoder CLI no longer inherits the
  IDE's internal variables, which used to make it exit without answering.
- Qoder CLI runs with `--strict-mcp-config` and without its own tools, so the
  AI asks the IDE for tools through the bridge.
- The contract test walks every route, not only the first one, and can also
  check the tool bridge (`node test/run.mjs qoder bridge`).

## 0.2.0 — 2026-11-10

- GitHub Copilot CLI and Grok (xAI) CLI join the routes, with their own streaming
  readers (`assistant.message_delta` and `text`/`thought`/`usage`).
- The tools a CLI brings with it are switched off, so the AI asks for the IDE's
  tools through the bridge instead of using its own.
- The selector names every model with its provider when the provider offers
  several (`deepseek-v4.1-flash-free (OpenCode)`) and with the bare model when
  it offers one.
- Every provider gets its own accent colour on the plugin's page.

## 0.1.0 — 2026-11-10

First release.

- Routes served by the free CLIs installed on the host: Kilo Code, OpenCode and
  Clixad, with Qoder CLI available for profiles that enable it.
- The plugin adopts the binary that is already installed (PATH, global npm, the
  IDE's private npm, the plugin's own folder) and installs it with npm only when
  it is really missing.
- A CLI that already holds a session on the machine is used as it is: no
  credential is asked for a second time.
- Free models are listed from each CLI's own catalogue, with the fixed catalog
  as a fallback, and only the free ones reach the model selector.
- The IDE tools are bridged into every turn through a validated JSON relay, so
  the AI inside the CLI can use the IDE's own tools.
- The plugin's page in the web client shows every provider, its free models, its
  install state, its session state and the usage the plugin recorded.
