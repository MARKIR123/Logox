# AGENTS.md — LOGOX Core Technical Map & Agent Navigation Signpost

This document is the primary navigational map for AI coding agents (Claude, Codex, Cursor, local models) working on `logox-ts`.
It defines global architectural invariants, module topologies, and disciplined exploration protocols.

---

## 1. Information Retrieval Protocol (阅读与检索优先级)

When exploring and reasoning about this repository, follow this two-tier priority:

1. **First Priority (Primary Route) — Directory `AGENTS.md` + Typed Interfaces (`*.ts`)**:
   - Subtree signposts (`src/*/AGENTS.md`) define exact file routes, invariant boundaries, and entrypoints.
   - Types and schemas never lie (`zod` schemas in `contracts.ts`, `definitions.ts`, `types.ts`).
   - Read localized signposts first, then navigate straight to specific lines with `Read`. Do NOT run unguided repo-wide greps.
2. **Second Priority (Context & Rationale) — `docs/`**:
   - Code and type definitions tell you **HOW** the system is built.
   - `docs/` explains **WHY** it was built this way (architectural motivations, design tree decisions, and cross-module collaboration choreography).
   - Consult `docs/` when facing ambiguous tradeoffs, refactoring boundaries, or when understanding inter-module design intent.

---

## 2. Core Invariants (刚性架构红线)

1. **English System Interface**:
   - All internal prompts, tool names, schemas, descriptions, error diagnostics, and terminal status lines must be **strictly 100% English**.
   - No bilingual parenthetical clutter (e.g. avoid `Updated (已修改)`).
   - Conversational responses to the user follow the language used by the user.
2. **Continuous Natural Execution Loop**:
   - `max_iterations = 0` (unlimited natural while(true) loop). No 50-turn blocking popups; stops on task completion or user cancel (`Esc` / `Ctrl+C`).
3. **Scratchpad Sandbox Isolation**:
   - All ephemeral test scripts, numerical calculations, and screenshots MUST be created in the session scratchpad directory (`tmpdir()/logox-scratchpad/<cwdHash>/<sessionId>/`), never in the project root.
4. **Multimodal Vision & `browser-shot` Standard**:
   - Multimodal vision is enabled by default. `Read` directly inspects images.
   - For web/SVG/UI preview inspections: run the pre-injected CLI `browser-shot <target> [outputPng] [--time <ms>]` via `Shell`, followed by `Read`. Never write custom CDP scripts or start background debugging servers.
5. **Single-Writer Safety**:
   - Production source code files have strictly one designated writer at any time (typically Techne). Reviewers (Aletheia, Kalon) provide coordinates and visual QA, never competing write handles.
6. **Persistent User Configuration in `~/.logox-ts/`**:
   - User credentials, custom providers, discovered model stores, and actor model bindings persist in `~/.logox-ts/` (fallback `~/.logox/`), never in project git trees or external tool paths.

---

## 3. Subsystem Map (子系统路标索引)

| Subsystem | Signpost Path | Core Responsibility |
|---|---|---|
| **Actors & Ensemble** | [`src/actors/AGENTS.md`](src/actors/AGENTS.md) | Actor personas, ensemble lifecycle, actor model persistence, `SendMessage` (queue vs interrupt), `.logox/bulletin.md` |
| **Providers & Models** | [`src/providers/AGENTS.md`](src/providers/AGENTS.md) | Model pool, Undici transport, proxy auto-fallback, OpenAI dual-auth (API Key vs Responses API), 6-tier thinking |
| **Tools & Execution** | [`src/tools/AGENTS.md`](src/tools/AGENTS.md) | PascalCase tools, process tree management, 1.5s forced cleanup, `browser-shot` CLI, `ListActors` & `CancelActor` |
| **Terminal UI (TUI)** | [`src/tui/AGENTS.md`](src/tui/AGENTS.md) | Ink plane rendering, 180-200ms frame pacing, dual-harmonic breathing wave, active actor animation, anti-noise inline cards |
| **Runtime & Store** | [`src/runtime/AGENTS.md`](src/runtime/AGENTS.md) | While(true) engine, task progress tracking, dual-write session transcripts (`director.jsonl`, `tasks.json`) |
| **Resources & Skills** | [`src/resources/AGENTS.md`](src/resources/AGENTS.md) | Hierarchical skills (`skills/<actor>/<domain>/*.md`), Path as Prompt, three-tier waterfall priority |

---

## 4. Development & Verification Commands

- Check types and documentation integrity: `npm run check`
- Build TypeScript & copy assets: `npm run build`
- Run test suite: `npm test`
- Start TUI interactive assistant: `npm start`
