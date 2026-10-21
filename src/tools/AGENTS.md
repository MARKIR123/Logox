# Module: Tools & Execution Engine (`src/tools/`)

## 1. Scope
- **Owns**: Canonical tool registry, Zod parameter schemas, tool aliases, process tree lifecycle management, `browser-shot` screenshot CLI, and file rollback snapshots (`/undo`).
- **Does not own**: Permission evaluation engine (owned by `src/permissions/`).

## 2. Start Here (Task Router)
| If investigating... | Start at... | Then check... |
|---|---|---|
| Tool dispatch, schemas, or execution | `index.ts:Tools.execute()` | `types.ts:canonicalToolMap` and `<ToolName>Tool/` |
| Process tree termination or hanging CLI | `process.ts:runProcess()` | 1.5s forced cleanup timer and `taskkill /T /F` |
| Visual preview inspection or screenshot CLI | `BrowserShot/cli.ts` | `BrowserShot/cdp.ts` and `ShellTool/prompt.ts` |
| Atomic file undo and snapshot rollback | `snapshots.ts:Snapshots` | `/undo` command in `src/application.ts` |
| Missing argument validation error formatting | `index.ts:validateToolCall()` | Specific tool Zod schema in `<ToolName>Tool.ts` |

## 3. Hard Boundaries
- **PascalCase Alignment**: Tools are strictly registered in PascalCase (`Read`, `Write`, `Edit`, `Glob`, `Grep`, `Shell`, `AskUserQuestion`, `WebFetch`, `Actor`, `ListActors`, `CancelActor`, `UpdateTaskProgress`). Aliases are normalized via `canonicalToolName()`.
- **1.5s Process Cleanup Guarantee**: `runProcess()` enforces a 1.5-second safety timer after kill signals to destroy unclosed stdio streams and reject immediately, preventing orphaned child processes from deadlocking the session.
- **Deadlock Guard**: `--virtual-time-budget=0` is strictly forbidden in Shell commands.
- **Deterministic Capture**: The `browser-shot` CLI freezes the virtual clock *after* page load and advances by explicit 16.67ms increments. `--time` means animation time, not load wait.
- **Scratchpad Confinement**: All temporary calculation scripts and preview screenshots must be written inside session scratchpad.

## 4. Integration Points
```text
kernel/agent.ts (receives tool calls from model)
  → tools/index.ts (validates schema & requests permission)
  → permissions/guard.ts (evaluates policy & prompts user if needed)
  → tools/<ToolName>Tool/<ToolName>Tool.ts (executes action)
```

## 5. Verification
- **Targeted Test Suite**:
  - `tests/tools-claude-alignment.test.ts`: PascalCase alignment and execution for all tools.
  - `tests/subagent-efficiency-vision.test.ts`: Multimodal reading and process error tolerance.
- **Fast Run Command**:
  ```bash
  node --test dist/tests/tools-*.test.js dist/tests/subagent-efficiency-vision.test.js
  ```
