---
categories:
  protocol: Round lifecycle and working-tree inspection
  coordination: Actor communication and shared capabilities
  orchestration: Task dispatch and execution management
  extensions: Configured MCP service discovery and invocation
---

# Module: Tools & Execution Engine (`src/tools/`)

## 1. Scope
- **Owns**: Canonical tool registry, Zod parameter schemas, tool aliases, bundled ripgrep resolution, process tree lifecycle management, and file rollback snapshots (`/undo`). Browser interaction and screenshots use the local Playwright MCP server in `src/extensions/`.
- **Does not own**: Permission evaluation engine (owned by `src/permissions/`).

## 2. Start Here (Task Router)
| If investigating... | Start at... | Then check... |
|---|---|---|
| Tool dispatch, schemas, or execution | `index.ts:Tools.execute()` | `types.ts:canonicalToolMap` and `<ToolName>Tool/` |
| Actor status details or Director-bound messages | `coordination/ListActorsTool/` and `coordination/SendMessageTool/` | `actors/facts.ts`, `actors/collaboration.ts` and `actors/services.ts` |
| Model-facing parameter names or legacy aliases | `<ToolName>Tool/<ToolName>Tool.ts` | `aliases.ts:normalizeAliases()` |
| Missing or broken ripgrep binary | `GrepTool/rg-path.ts:resolveRgPath()` | `package.json` `@vscode/ripgrep` dependency |
| Process tree termination or hanging CLI | `process.ts:runProcess()` | 1.5s forced cleanup timer and `taskkill /T /F` |
| Browser interaction, screenshots, or offline setup | `../extensions/playwright.ts` | `../extensions/mcp.ts` image transport and `npm run browser:install` |
| Atomic file undo and snapshot rollback | `snapshots.ts:Snapshots` | `/undo` command in `src/application.ts` |
| Stateless mechanical indexing & extraction | `orchestration/AutomaTool/` | `prompt.ts:AUTOMA_ANIMATION_FRAMES` and `AutomaTool.ts` |
| Dedicated tool model configuration & persistence | `tool-models.ts:ToolModelStorage` | `~/.logox/tool-models.json` and `/model automa` in `application.ts` |
| Tiered tool taxonomy & role scoping | `AGENTS.md` category descriptions and `taxonomy.ts` loader | `metadata.ts:ToolMetadata`, `registry.ts:ToolRegistry` and `.logox/tools.json` |
| Silent git state on-demand inspection | `protocol/_GitStatusTool/` | `metadata.ts` (`terminalVisibility: 'silent'`) |
| Missing argument validation error formatting | `index.ts:validateToolCall()` | Specific tool Zod schema in `<ToolName>Tool.ts` |
| Tool presentation, visibility or question actions | `ui-registry.ts` and sibling `UI.ts` | `ui-types.ts` and shared `tui/timeline/tool-ui.ts` |
| Hidden terminal round metadata | `protocol/_FinishRoundTool/` | `kernel/agent.ts` and `context/round-memory.ts` |

## 3. Hard Boundaries
- **PascalCase Alignment**: Tools are strictly registered in PascalCase (`Read`, `Write`, `Edit`, `Glob`, `Grep`, `Shell`, `AskUserQuestion`, `WebFetch`, `Automa`, `Actor`, `ListActors`, `CancelActor`, `UpdateTaskProgress`). Aliases are normalized via `canonicalToolName()`.
- **Automa Read-Only Confinement**: Automa executes as an ephemeral, stateless mechanical sub-agent using exclusively Read, Glob, Grep, WebFetch. It is strictly prohibited from Write, Edit, Shell, and Actor delegation. Calls append to `subagents/automa.jsonl` for auditability but accumulate zero conversational context across invocations. Automa is strictly a tool decoupled from `ActorCatalog`; its dedicated model is persisted via `ToolModelStorage` (`~/.logox/tool-models.json`) and configured via `/model automa [model|inherit]`, defaulting to session model inheritance.
- **Claude Code Parameter Contract**: Model-facing schemas expose `file_path`, `old_string`, `new_string`, Grep `output_mode`/`glob`/`head_limit`, and Shell millisecond `timeout`. Never add `.default()` to a model-facing field: Zod 4 marks defaulted fields as `required` in `toJSONSchema`, which forces the model to send them. Legacy names (`path`, `old_text`, `new_text`, Grep `limit`) are accepted only through `normalizeAliases()` and are scheduled for removal.
- **Tiered Tool Taxonomy & Dynamic Role Scoping**: Root tools use `core`; categorized tools use directory paths rather than a closed category enum. The `categories: {directory: description}` frontmatter in this `AGENTS.md` is the runtime category source; only that data is indexed, not this navigation body. Add categories in data, not formatter branches. Roles are adjudicated via `isToolAllowedForActor(meta.roles, actorId)` (`'all' | 'director' | 'actors' | readonly string[]`); new actors inherit group eligibility without code changes.
- **Disclosure and Presentation**: `loading: 'eager' | 'deferred'` is independent of roles and terminal visibility. Root tools default eager; categorized tools default deferred. `_FinishRound` is mandatory/eager; LoadTools is eager only for native disclosure. Every eligible deferred tool appears by name and short English description, without schemas or implementation paths. Legacy non-hidden prompt visibility values are accepted but do not select loading or directory detail. `hidden` removes eligibility. Terminal visibility (`'card' | 'notice' | 'silent'`) is independent and captured on runtime steps from the application-owned registry.
- **Read Evidence Integrity**: Text reads retain complete selected lines, with a default 2,000-line range and a 256 KiB UTF-8 output limit. Oversized output fails explicitly; do not silently clip individual lines. The file-size limit remains 32 MiB and visual image input remains limited to 10 MiB.
- **Native Contracts**: `discovery.ts` retains genuine canonical LoadTools pairs and sorted discovered names; loading never executes a target or grants permission. Anthropic references and Responses search outputs expand current legal definitions. Unknown endpoints use all ordinary legal contracts. Deferred directory text alone does not reduce native schema cost.
- **Bundled ripgrep**: Grep must resolve the ripgrep binary from the `@vscode/ripgrep` dependency (or `LOGOX_RIPGREP_PATH`); never rely on the host PATH as the primary source. The JS traversal is a last-resort fallback only.
- **Internal Tool Policy**: `_FinishRound` is an explicitly terminal, hidden, omit-pair tool, not a prefix-based permission exception. Its minimal receipt is recorded without another model request; it creates no visible tool step.
- **Presentation Ownership**: Built-ins, including collaboration tools, own `UI.ts`; common hosts retain layout, focus and permission scheduling. Execution never imports the renderer registry. Unknown extension tools use a safe visible fallback. Add tool-local signposts only for non-obvious constraints.
- **Tool-Owned Titles**: Each `UI.ts` names the most decision-relevant parameter first: `file_path` for Read/Write/Edit, `pattern` for Grep/Glob, task owner/goal for Actor, question header for AskUserQuestion, and channel for channel-scoped SendMessage. Titles must stay one line and never dump payload bodies.
- **Prompt Ownership**: Tool-specific descriptions and repair prompts stay co-located in `src/tools/<Tool>/prompt.ts`. Cross-cutting rules (charter, collaboration, reporting, recovery, runtime state) live under `src/prompts/`; do not move tool descriptions into that tree.
- **1.5s Process Cleanup Guarantee**: `runProcess()` enforces a 1.5-second safety timer after kill signals to destroy unclosed stdio streams and reject immediately, preventing orphaned child processes from deadlocking the session.
- **Browser Verification**: Playwright MCP owns browser state and screenshots. Keep actions and evidence in one page session; generic Shell execution does not inject browser shims or rewrite browser flags.
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
  - `tests/tool-parameter-alignment.test.ts`: Model-facing schemas, legacy aliases, Grep modes, Shell timeout, AskUserQuestion multiSelect, bundled ripgrep.
  - `tests/tools-claude-alignment.test.ts`: PascalCase alignment and execution for all tools.
  - `tests/tools-metadata.test.ts`: Metadata contracts and dynamic role scoping resolver.
  - `tests/tools-registry.test.ts`: ToolRegistry category grouping and user config overrides.
  - `tests/tools-taxonomy.test.ts`: Root AGENTS.md descriptions, arbitrary new categories, collapsed/explicit indexing, preserved schemas and packaged assets.
  - `tests/git-status-tool.test.ts`: Silent _GitStatus execution and fallback.
  - `tests/tiered-tools-integration.test.ts`: Integration across director, worker, dynamic actor, and TUI silent rendering.
  - `tests/subagent-efficiency-vision.test.ts`: Multimodal reading and process error tolerance.
- **Fast Run Command**:
  ```bash
  node --test dist/tests/tools-*.test.js dist/tests/git-status-tool.test.js dist/tests/tiered-tools-integration.test.js dist/tests/tool-parameter-alignment.test.js dist/tests/finish-round.test.js
  ```

## 6. Known Gaps
- `Shell` does not yet support `run_in_background`, `BashOutput`, or `KillShell`; background execution is deferred.
- `Shell.timeout` retains legacy unit inference: positive values up to 600 are seconds, larger values are milliseconds. The model-facing contract must disclose this; removing inference requires a caller migration, not a description-only edit.
- Legacy parameter aliases (`path`, `old_text`, `new_text`, Grep `limit`) remain accepted for migration and are scheduled for removal in a later version.
- Provider wire compatibility is tested with local fixtures; live model behavior is not certified by registry or UI tests.
