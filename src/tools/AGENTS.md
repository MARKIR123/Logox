# Module: Tools & Execution Engine (`src/tools/`)

## 1. Quick Route (核心文件导航)
- `index.ts`: Master tool dispatcher, permission enforcement, and canonical schema registry.
- `types.ts`: Canonical tool aliases (case-insensitive mapping to PascalCase).
- `process.ts`: Subprocess spawning, active execution registry, tree kill (`taskkill /T /F`), and 1.5s forced stdio destruction.
- `bin/browser-shot.mjs`: Legacy deterministic screenshot CLI (fallback path only).
- `bin/browser-shot.cmd`: Windows batch wrapper for `browser-shot`.
- `BrowserShot/`: Screenshot CLI implementation (`cli.ts`, `cdp.ts`) plus `prompt.ts` — its usage contract, appended to the Shell tool description. Deliberately **not** a registered tool: screenshots are a shell-invocable utility, not a first-class capability.
- `snapshots.ts`: In-memory file snapshots and `/undo` atomic rollback engine.

### Sub-Tool Directories (PascalCase Tool Structure)
- `ReadTool/`: Text and multimodal image reading (`PNG`, `JPG`, `WebP`, `GIF`).
- `WriteTool/`: Atomic file creation and replacement.
- `EditTool/`: Exact string replacement with unique match verification.
- `GlobTool/`: Fast filesystem pattern matching.
- `GrepTool/`: High-performance ripgrep search.
- `ShellTool/`: Command execution (PowerShell/sh) with `browser-shot` in PATH and deadlock guards.
- `AskUserQuestionTool/`: Interactive user inquiry with multi-select and preview support.
- `WebFetchTool/`: Clean Markdown web scraping.
- `ActorTool/`: Concurrent subagent task dispatching (`Actor`).
- `ListActorsTool/`: Director radar (`ListActors`) with execution metrics & tool IDs.
- `CancelActorTool/`: Surgical subagent interruption (`CancelActor`) with 'tool' and 'activity' scopes.
- `UpdateTaskProgressTool/`: Multi-step task milestone and phase progression (`UpdateTaskProgress`).
- `CraftActorTool/`: Actor definition submission.
- `ReadActorTool/`: Actor active branch inspection.
- `BorrowSkillTool/`: Ephemeral single-task skill borrowing.

## 2. Invariants (刚性边界与底线)
- **PascalCase Alignment**: Tools are strictly named in PascalCase (`Read`, `Write`, `Edit`, `Glob`, `Grep`, `Shell`, `AskUserQuestion`, `WebFetch`, `Actor`, `ListActors`, `CancelActor`, `UpdateTaskProgress`). Lowercase and snake_case aliases are normalized automatically in `canonicalToolName()`.
- **Process Cleanup Guarantee**: `runProcess()` enforces a 1.5-second safety timer after kill signals to destroy unclosed stdio streams and reject immediately, preventing orphaned child processes (e.g. Chrome) from deadlocking the session.
- **Forbidden Deadlock Parameters**: `--virtual-time-budget=0` is strictly forbidden in Shell commands. `ShellTool` automatically sanitizes or guards against this Chromium deadlock flag.
- **Deterministic Capture**: The `browser-shot` CLI freezes the virtual clock *after* the page is ready and then advances it by explicit 16.67ms budgets, so `--time` means animation time, never load wait. Freezing *before* navigation stalls `Page.loadEventFired` and makes every capture time out into the legacy fallback. Identical arguments must yield byte-identical PNGs; never add wall-clock sleeps to "fix" timing, and never let a silent fallback pass as success.- **Scratchpad Confinement**: All probe scripts, transient calculations, and screenshots must be placed in session scratchpad.

## 3. Cross-Reference (关联路标)
- Actor lifecycle & dispatch: [`../actors/AGENTS.md`](../actors/AGENTS.md)
- Permission guard & policies: [`../permissions/`](../permissions/)
- Architectural rationale & design history: [`../../docs/`](../../docs/)
