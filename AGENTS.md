# AGENTS.md — LOGOX Core Technical Map & Agent Navigation Signpost

This document establishes the **Fractal Signpost Protocol (FSP)** for AI coding agents (Claude, Codex, Cursor, local models) working on `Logox`.
It defines global architectural invariants, module topologies, and disciplined exploration protocols.
All subsystem development and maintenance must strictly adhere to the FSP paradigm.

---

## 1. Fractal Signpost Protocol (FSP) & Look-Ahead Navigation

Before exploring, reading, or modifying files in any subsystem directory (`src/<subsystem>/`), adhere to this strict sequence:

1. **Check Local Signpost First (`src/<subsystem>/AGENTS.md`)**:
   - Subtree signposts define exact file routes, invariant boundaries, and entrypoints.
   - Read the localized signpost FIRST before reading actual source files or running repo-wide greps.
   - If a subdirectory lacks an `AGENTS.md`, fall back to the nearest ancestor signpost and follow symbol imports.
2. **6-Section Minimal Signpost Template**:
   - Localized signposts strictly adhere to the 6 sections:
     `Scope` → `Start Here (Task Router)` → `Hard Boundaries` → `Integration Points` → `Verification` → `Known Gaps`.
3. **Type Contracts Over Prose**:
   - Types and schemas never lie (`zod` schemas in `contracts.ts`, `definitions.ts`, `types.ts`).
   - Type definitions tell you **HOW** the system behaves; signposts define **BOUNDARIES**.
4. **Public Documentation (`docs/`)**:
   - Start with [the documentation index](docs/README.md) for usage and current module behavior.
   - Public guides must stand alone; local development instructions and working documents are not publication dependencies.

---

## 2. Core Invariants

1. **English System Interface**:
   - All internal prompts, tool names, schemas, descriptions, error diagnostics, and terminal status lines must be **strictly 100% English**.
   - No bilingual parenthetical clutter or mixed-language tags.
   - Conversational responses to the user follow the language used by the user.
2. **Continuous Natural Execution Loop**:
   - `max_iterations = 0` (unlimited natural while(true) loop). No 50-turn blocking popups; stops on task completion or user cancel (`Esc` / `Ctrl+C`).
3. **Scratchpad Sandbox Isolation**:
   - All ephemeral test scripts, numerical calculations, and screenshots MUST be created in the session scratchpad directory (`tmpdir()/logox-scratchpad/<cwdHash>/<sessionId>/`), never in the project root.
4. **Multimodal Vision & Browser Verification**:
   - Multimodal vision is enabled by default. `Read` inspects local images; MCP image blocks enter visual input directly.
   - Use the local Playwright MCP server for web/SVG/UI verification. Keep interaction, state checks, and screenshots in the same page session; each actor receives its own isolated browser instance.
5. **Shared Workspace & Observation Guard**:
   - Companion actors hold full tool access (`Read`, `Edit`, `Write`, `Shell`, `Grep`, `Glob`, `SendMessage`) and self-verify their work. Concurrent non-overlapping `Edit` calls serialize under per-file atomic locks, while stale overwrites are blocked by per-actor read observation guards.
6. **Persistent User Configuration in `~/.logox/`**:
   - Primary user storage is `~/.logox/`. Some components still load `~/.logox-ts/` for compatibility, with component-specific precedence; see [usage](docs/USAGE.md). Credentials and runtime data stay outside tracked source files.
7. **Internal Round Memory and Independent Reports**:
   - Every normally completed round submits hidden `_FinishRound` metadata. Only formal Director assignments produce task reports; direct human requests receive normal answers.
   - Closed context uses compact five-field indexes with authoritative ledger ranges. Raw journals remain append-only; effective goals, constraints, evidence status and unresolved work survive instead of every original message.
8. **Fractal Signpost Protocol (FSP) Enforcement**:
   - Subsystem and test signposts follow the six-section template. Tool folders inherit the nearest signpost; add a local one only for constraints not evident from code.

---

## 3. Subsystem Map

| Subsystem | Signpost Path | Core Responsibility |
|---|---|---|
| **Actors & Ensemble** | [`src/actors/AGENTS.md`](src/actors/AGENTS.md) | Actor personas, ensemble lifecycle, actor model persistence, `SendMessage` (queue vs interrupt), `.logox/bulletin.md` |
| **Tools & Execution** | [`src/tools/AGENTS.md`](src/tools/AGENTS.md) | PascalCase tools, process tree management, 1.5s forced cleanup, `ListActors` & `CancelActor`; browser interaction via Playwright MCP |
| **Providers & Models** | [`src/providers/AGENTS.md`](src/providers/AGENTS.md) | Model pool, Undici transport, proxy auto-fallback, OpenAI dual-auth (API Key vs Responses API), 6-tier thinking |
| **Runtime & Store** | [`src/runtime/AGENTS.md`](src/runtime/AGENTS.md) | While(true) engine, task progress tracking, dual-write session transcripts (`director.jsonl`, `tasks.json`) |
| **Terminal UI (TUI)** | [`src/tui/AGENTS.md`](src/tui/AGENTS.md) | Ink plane rendering, 180-200ms frame pacing, dual-harmonic breathing wave, active actor animation, anti-noise inline cards |
| **Resources & Skills** | [`src/resources/AGENTS.md`](src/resources/AGENTS.md) | Hierarchical skills (`skills/<actor>/<domain>/*.md`), Path as Prompt, three-tier waterfall priority |
| **Permissions & Sandbox** | [`src/permissions/AGENTS.md`](src/permissions/AGENTS.md) | Three-tier security matrix, scratchpad auto-approval, sensitive path protection, persistent rules |
| **Context & Compaction** | [`src/context/AGENTS.md`](src/context/AGENTS.md) | Dual-watermark pruning, hidden round memory and compact indexes, tool output disk archiving, token metering |
| **Configuration & Storage** | [`src/config/AGENTS.md`](src/config/AGENTS.md) | Hierarchical config cascade, atomic `StateFile` locking, thinking protocol and level sets |
| **Prompts & Assembly** | [`src/prompts/AGENTS.md`](src/prompts/AGENTS.md) | Static/dynamic prompt zones, charter, collaboration fragments, compaction/recovery sections, cache-stable order |
| **Test Suite & Verification** | [`tests/AGENTS.md`](tests/AGENTS.md) | Domain test groups, fast verification commands (~1-3s), test sandbox isolation rules |

---

## 4. Development & Verification Commands

- Check types and documentation integrity: `npm run check`
- Build TypeScript & copy assets: `npm run build`
- Run targeted domain test group: see [`tests/AGENTS.md`](tests/AGENTS.md)
- Run full test suite: `node --test --test-concurrency=4 dist/tests/*.test.js`
- Start TUI interactive assistant: `npm start`
