# AGENTS.md — LOGOX Signpost

LOGOX is a full-screen terminal coding assistant (Node.js, TypeScript, React/Ink) that replaces the legacy Python project. A Director (Logox) works directly on trivial tasks and orchestrates a persistent ensemble of companion actors (Techne, Kalon, Aletheia) for substantive work. Phase roadmap: Basic Features -> Anamnesis Dreaming -> Persistent Subagents. This file is the entry map for external coding agents and is also loaded by Logox as project rules, so it stays short.

## 1. Navigation Protocol (FSP)

1. Before reading or editing `src/<subsystem>/`, read its local `AGENTS.md` first. A folder without one inherits the nearest ancestor signpost (see the map in section 3). Avoid unguided repo-wide greps.
2. Local signposts follow six sections: `Scope` (with a design-rationale link into `docs/`), `Start Here` (task router), `Common Changes` (step-by-step recipes), `Hard Boundaries` (each citing its enforcing test or marked *Unenforced*), `Dependencies`, `Verification & Gaps`. [`src/tools/AGENTS.md`](src/tools/AGENTS.md) is the reference example. Add a new signpost only for constraints that are not evident from code.
3. Backticked paths and `<file>.ts:<symbol>` references in signposts are machine-checked by `npm run check:docs`; keep them resolvable (use `<placeholder>` or `*` for patterns). When you change code a signpost references, update the signpost in the same change.
4. Types and zod schemas (`contracts.ts`, `definitions.ts`, `types.ts`) are authoritative for HOW code works; signposts define boundaries and invariants; [`docs/`](docs/README.md) explains WHY and usage.

## 2. Core Invariants

- **English system interface**: prompts, tool descriptions, schemas, UI labels, status lines and errors are English only, with no bilingual text. Network notices stay concise (`[Network] Connection interrupted. Retrying (1/5)...`). Conversational replies follow the user's language.
- **Natural loop**: `max_iterations = 0`; the `while(true)` loop ends on goal completion, unrecoverable failure, or user cancel (`Esc` / `Ctrl+C`), with no turn-limit prompts.
- **Scratchpad isolation**: temporary scripts, calculations and screenshots go to `join(tmpdir(), 'logox-scratchpad', cwdHash, sessionId, actorId)` (one directory per actor, Director included, so concurrent scripts never collide), never the project root. Permissions auto-approve the whole session tree and actors may read each other's files there; oversized tool output is offloaded to the calling actor's `tool-results/` (`src/kernel/scratchpad.ts`).
- **Vision and UI verification**: multimodal is on by default. `Read` inspects images; for HTML/SVG/frontend work use the local Playwright MCP server in one page session (each actor gets its own browser). For existing desktop bugs, ask the user for a screenshot via `AskUserQuestion`.
- **Configuration**: canonical user config lives in `~/.logox/` (see [usage](docs/USAGE.md)); the retired `~/.logox-ts/` is no longer read. Credentials and runtime journals stay out of tracked files.
- **Sessions**: `state/sessions/<sessionId>/` holds `director.jsonl`, `tasks.json`, `events.json`, `README.md` and `subagents/<actor>.jsonl`. Raw ledgers are append-only.
- **Round memory vs delivery**: normal rounds close through hidden `_FinishRound`; only formal Director dispatches produce structured task reports, while direct human requests get conversational replies. Compaction indexes closed context into compact records and must keep effective constraints, evidence status and open work.
- **Tool-owned presentation**: built-in tools keep `UI.ts` (and interaction logic) beside their definition; shared hosts own layout, focus and permission scheduling.
- **Prompts are static constants**, not strings concatenated inside business logic.
- **Automa**: stateless parallel workers any actor can dispatch. A grant only narrows what the dispatcher already has, and every worker call passes the permission engine under the dispatcher's name; see [`src/tools/AGENTS.md`](src/tools/AGENTS.md).
- **Shared workspace**: companion actors have full tool access; concurrent edits serialize under per-file locks and per-actor read guards prevent stale overwrites.

## 3. Subsystem Map

Paths under `src/`. "Inherits" means no local signpost; use the named one.

| Directory | Signpost | Responsibility |
|---|---|---|
| `actors/` | [`src/actors/AGENTS.md`](src/actors/AGENTS.md) | Personas, ensemble lifecycle, model persistence, `SendMessage` collaboration, bulletin |
| `tools/` | [`src/tools/AGENTS.md`](src/tools/AGENTS.md) | Tool registry and taxonomy (core tools at root; `src/tools/protocol/`, `src/tools/coordination/`, `src/tools/orchestration/` tiers), process lifecycle, `/undo` snapshots |
| `providers/` | [`src/providers/AGENTS.md`](src/providers/AGENTS.md) | Model pool, HTTP transport and proxy fallback, OpenAI routing, thinking levels, login wizard |
| `runtime/` | [`src/runtime/AGENTS.md`](src/runtime/AGENTS.md) | Immutable store snapshots, step timing, task progress, input delivery queues, system events |
| `tui/` | [`src/tui/AGENTS.md`](src/tui/AGENTS.md) | Ink rendering, frame pacing, timeline, actor status bar, panels |
| `resources/` | [`src/resources/AGENTS.md`](src/resources/AGENTS.md) | Hierarchical skills, project rules and guideline loading, hot reload |
| `permissions/` | [`src/permissions/AGENTS.md`](src/permissions/AGENTS.md) | `default` / `auto` / `creative` modes, path risk, rule persistence |
| `context/` | [`src/context/AGENTS.md`](src/context/AGENTS.md) | Watermark budgeting, round-memory indexing, tool-output offload, token metering |
| `config/` | [`src/config/AGENTS.md`](src/config/AGENTS.md) | Config cascade, TOML, `modelSettings()`, themes, onboarding preferences, atomic `StateFile` |
| `prompts/` | [`src/prompts/AGENTS.md`](src/prompts/AGENTS.md) | Prompt composer, charter, collaboration contracts, cache-stable ordering |
| `kernel/` | Inherits `runtime/` | Agent loop (`agent.ts`), execution recovery, scratchpad |
| `app/` | Inherits `runtime/` | Container-level wiring split out of `application.ts`: shared session state, footer status and usage metering, request assembly, input delivery and pending messages, startup restore, the `submit` command dispatcher |
| `store/` | Inherits `runtime/` and `config/` | `.lock-v2` file locks, journals, sessions, session trash, system history, atomic replace |
| `extensions/` | Inherits `tools/` | MCP client (`mcp.ts`, `mcp-client.ts`), Playwright controller, hooks, external processes, extension config |
| `commands/`, `commands.ts` | Inherits `tui/` | Command surface descriptors and slash commands |
| `anamnesis/` | Inherits `context/` | Idle-triggered dream lifecycle (`service.ts`), recap and AutoDream runners (`runner.ts`), memory store (`memory.ts`); not yet wired into the main app |
| `demo/`, `demo.ts` | Inherits `tui/` | Scripted demo scenes behind `--demo` |
| `doctor.ts` | Inherits `tests/` | Environment, dependency and config diagnostics behind `--doctor` |
| `application*.ts`, `cli.tsx` | Root | Application container, bootstrap, sessions, status, command wiring, CLI entry |
| `tests/` | [`tests/AGENTS.md`](tests/AGENTS.md) | Domain test matrices, home-directory isolation, mock fixture rules |

## 4. Verification

```bash
npm run check          # check:docs (links, headings, signposts) + tsc --noEmit
npm run build          # tsc + copy actor profiles into dist/
npm test               # check:docs + build + full suite
node --test --test-concurrency=4 dist/tests/*.test.js   # full suite on an existing build
npm start              # interactive TUI; also --doctor, --demo, --check-config, --list-models
```

Run targeted per-domain test commands from [`tests/AGENTS.md`](tests/AGENTS.md) while iterating (build first; tests run from `dist/`). Run `npm run check` before concluding any change.

Not covered by offline tests (needs manual or authorized live verification):
- Live provider streaming, prompt caching, reasoning levels and billing (tests use local mocks).
- Physical terminal rendering: true color, CJK width, glyphs, mouse tracking, resize.
- Interactive OAuth login in an external browser.
- Headed Playwright automation (needs `npm run browser:install`).
- Multi-process `.lock-v2` contention and long-horizon loops under production load.
