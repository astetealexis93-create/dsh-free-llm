# Changelog

## 0.4.1 — 2026-11-11

- The exact-model metadata that comes back from a call is the model's own
  record, never the bare id. The IDE rejects a bare id and drops the whole
  provider out of the selector with `INVALID_MODEL_INFO`.
- The prompt travels the way each CLI can take it: its standard input, or a
  file inside the workspace the CLI works on. The prompt of the IDE does not
  fit in a Windows command line (32 KiB), and pasting it back as an argument
  broke the turn with `ENAMETOOLONG`.
- The contract test checks the metadata the way the IDE checks it and walks
  every model of every route, not only the first one.
- The turn the IDE spends naming the session is marked as auxiliary: it no
  longer counts as a failed turn in the ledger nor in the plugin's page. The
  IDE gives that turn 60 seconds, and a slow CLI can use them all while the
  answer to the conversation arrives fine.
- The bridge says it in plain words: the AI asks the IDE for its tools instead
  of using the ones its own CLI brings. Clixad keeps its own reader, which is
  the way the prompt reaches it.
- A new probe tells which shape of call each CLI answers
  (`node test/transport.mjs`), and another drives the running IDE to prove the
  route answers there (`node test/field.mjs`).

## 0.4.0 — 2026-11-11

- The routes answer the IDE's model catalog the way it reads it: every model
  carries its provider, its id and its name, and the exact-model query answers
  with the model's metadata instead of the bare id. Before this, the IDE took
  the whole provider out of the selector.
- Each model carries a badge with its provider and that provider's tone, so the
  selector shows one group per CLI with its own colour. The IDE paints the badge
  from a fixed palette, so the tone is the closest one to each provider's
  colour: Kilo and OpenCode land exactly on amber and green.
- The catalog answers at once: the fixed catalog serves the selector and the
  CLI refreshes it in the background, when no turn is using that CLI.
- One CLI at a time per route: a turn, a model listing and a sign-in probe of
  the same route no longer run together.
- The contract test checks the catalog shape, the exact-model metadata and how
  fast the catalog answers.

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
