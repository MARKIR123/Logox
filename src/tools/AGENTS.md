---
categories:
  protocol: Round lifecycle and working-tree inspection
  coordination: Actor communication and shared capabilities
  orchestration: Task dispatch and execution management
  extensions: Configured MCP service discovery and invocation
---

# Module: Tools & Execution (`src/tools/`)

## 1. Scope
- **Owns**: Built-in tool registry and metadata (`registry.ts`, `catalog.ts`, `metadata.ts`), Zod parameter schemas and aliases, native tool disclosure (`discovery.ts`), tool-owned UI (`ui-registry.ts`), process tree lifecycle (`process.ts`), and `/undo` snapshots (`snapshots.ts`).
- **Does not own**: Permission evaluation ([`src/permissions/AGENTS.md`](../permissions/AGENTS.md)); actor-facing tool execution and ensemble state ([`src/actors/AGENTS.md`](../actors/AGENTS.md)); MCP transport and the Playwright server config (`src/extensions/`, no signpost; routed through the Start Here table); provider wire formats for disclosure ([`src/providers/AGENTS.md`](../providers/AGENTS.md)).
- **Design rationale**: [docs/modules/context.md](../../docs/modules/context.md) (tool disclosure); [docs/modules/resources-and-extensions.md](../../docs/modules/resources-and-extensions.md) (MCP and Playwright).

## 2. Start Here
| If you need to... | Start at | Then check |
|---|---|---|
| Trace a core tool call (validate, permission, run) | `index.ts:Tools.execute()` | `index.ts:validateToolCall()`, `src/permissions/guard.ts` |
| Trace an actor-facing tool (Actor, SendMessage, ListActors...) | `src/actors/services.ts:ActorServices.execute()` | `src/actors/services.ts:serviceTools`, `src/actors/collaboration.ts` |
| Change which actors see a tool, or how it loads | `metadata.ts:toolMetadataSchema` | `registry.ts:ToolRegistry.resolveForActor()`, `metadata.ts:isToolAllowedForActor()` |
| Override tool metadata per user or project | `registry.ts:ToolRegistry.reloadUserConfigs()` | `metadata.ts:userToolConfigSchema`, `.logox/tools.json` |
| Change the deferred-tool directory or LoadTools behavior | `registry.ts:ToolRegistry.formatDiscoveryCatalog()` | `discovery.ts:buildToolExposure()`, `discovery.ts:resolveToolLoad()`, `protocol/LoadToolsTool/` |
| Change a category description | Frontmatter `categories:` of this file | `taxonomy.ts:readToolCategories()` |
| Rename a parameter or keep a legacy name | `<tier>/<Name>Tool/<Name>Tool.ts` schema | `aliases.ts:normalizeAliases()`, `types.ts:toolAliases` |
| Change a card title, visibility or question UI | `<Name>Tool/UI.ts` | `ui-registry.ts:toolUIs`, `ui-types.ts`, `src/tui/timeline/tool-ui.ts:createToolUI()` |
| Improve a tool error hint | `diagnostics.ts:diagnosticHandlers` | `<Name>Tool/diagnostic.ts` |
| Hidden round-closing metadata | `protocol/_FinishRoundTool/_FinishRoundTool.ts` | `src/kernel/agent.ts`, `src/context/round-memory.ts` |
| Silent git inspection | `protocol/_GitStatusTool/_GitStatusTool.ts` | `metadata` export there (`terminalVisibility: 'silent'`) |
| Automa (stateless read-only sub-agent) | `orchestration/AutomaTool/AutomaTool.ts:executeAutoma()` | `tool-models.ts:ToolModelStorage` (`~/.logox/tool-models.json`, `/model automa`) |
| Classify a Shell command as search, read, list or command (timeline grouping) | `ShellTool/classify.ts:classifyShellCommand()` | `src/tui/timeline/tool-groups.ts:groupToolMessages()`, `src/permissions/shell.ts:shellCommands()` |
| Missing ripgrep binary | `GrepTool/rg-path.ts:resolveRgPath()` | `@vscode/ripgrep` in `package.json` |
| Hanging child process | `process.ts:runProcess()` | `process.ts:killActivityProcesses()` |
| `/undo` rollback | `snapshots.ts:Snapshots` | the `/undo` branch in `src/application.ts` |
| MCP tools, Playwright browser | `src/extensions/mcp.ts:Mcp` | `src/extensions/playwright.ts:playwrightServer()`; `src/application.ts` registers MCP tools under category `extensions` |

## 3. Common Changes
### Add a built-in tool
1. Create `<tier>/<Name>Tool/` (`core` tools sit directly under `src/tools/`; tiers are `protocol/`, `coordination/`, `orchestration/`). Model it on `GlobTool/`:
   - `<Name>Tool.ts`: a `z.strictObject` schema, the `execute<Name>()` function, and `export const metadata: ToolMetadataInput` (`name`, `category`, `roles`, `terminalVisibility`; optional `loading`, `promptVisibility`, `description`).
   - `prompt.ts`: the `<NAME>_DESCRIPTION` string (see `GlobTool/prompt.ts`).
   - `UI.ts`: `export const UI = createToolUI([...])` naming the title parameters (see `GlobTool/UI.ts`).
   - Optional `diagnostic.ts`, registered in `diagnostics.ts:diagnosticHandlers`.
2. Metadata defaults: `category: 'core'` implies `loading: 'eager'` and `promptVisibility: 'always'`; any other category defaults to `deferred` and `summary`. `roles` is `'all' | 'director' | 'actors' | string[]`; `terminalVisibility` is `'card' | 'notice' | 'silent'`.
3. Register the schema and description in `index.ts`: import them, add to `schemas` and `descriptions` (typed `Record<ToolName, string>`, so a missing entry fails typecheck), and add to the re-export block.
4. Register the metadata in `catalog.ts:builtinToolRegistrations()`: import `metadata as metaN` and append it to the array. The JSON-schema definition is derived from `schemas` and `descriptions`; only `SendMessage` is special-cased.
5. Add the canonical name plus lowercase and snake_case spellings to `types.ts:toolAliases`. Without them `canonicalToolName()` rejects the tool.
6. Add `UI` to `ui-registry.ts:toolUIs`.
7. Wire execution:
   - Tool that touches files or the shell: add a branch in `index.ts:Tools.execute()` after the permission block, and extend its `effect` computation if the tool is read-only.
   - Tool that needs ensemble state (the `coordination/` and `orchestration/` tools): add the name to `src/actors/services.ts:serviceTools` and a branch in `ActorServices.execute()`.
- Tests: `tests/tool-ui.test.ts` (iterates `schemas`; needs a UI entry), `tests/tools-registry.test.ts`, `tests/tools-claude-alignment.test.ts`; add a `tests/<name>-tool.test.ts` for execution.

### Add a tool category / tier
1. Create the directory `src/tools/<category>/` (category names are directory paths; `metadata.ts:toolCategorySchema` allows nested paths).
2. Add `<category>: <one-line English description>` to the frontmatter `categories:` of this file. That is the only runtime source of descriptions; no formatter code changes.
3. Set `category: '<category>'` in each tool's metadata. Non-`core` categories default to deferred and appear in the LoadTools directory under `<category>/`.
- Tests: `tests/tools-taxonomy.test.ts` (new categories and the packaged signpost), `tests/tools-registry.test.ts`.

### Change a model-facing parameter
1. Edit the schema in `<Name>Tool.ts` (see `ReadTool/ReadTool.ts` for the pattern). Use Claude Code names (`file_path`, `old_string`, `new_string`, `head_limit`).
2. Never add `.default()` to a model-facing field; use `.optional()` and apply the default in `execute<Name>()`. Zod 4 lists defaulted fields as `required` in `z.toJSONSchema`, which forces the model to send them.
3. To keep an old name working, wrap the schema as `z.preprocess(value => normalizeAliases(value, {old: 'new'}), schema)` as in `EditTool/EditTool.ts`. The canonical key wins when both are present; the strict object then rejects any name that is neither.
4. If the path argument changes, update `aliases.ts:filePathOf()`, which `Tools.execute()` uses to build the permission target.
5. Update the description in `prompt.ts` and the title keys in `UI.ts`.
- Tests: `tests/tool-parameter-alignment.test.ts` (required lists, alias parsing), `tests/tool-contract-accuracy.test.ts` (description matches behavior).

## 4. Hard Boundaries
- **Model-facing fields never use `.default()`**: defaulted fields become `required` in the JSON schema. Partially enforced: `tests/tool-parameter-alignment.test.ts` asserts the `required` list of the core tools; other tools are *Unenforced*.
- **Legacy parameter names only through `normalizeAliases()`**: `path`, `old_text`, `new_text`, Grep `limit` are accepted but not exposed to the model, and are scheduled for removal. Enforced by `tests/tool-parameter-alignment.test.ts`.
- **Built-in names are PascalCase and resolve through `toolAliases`**: Enforced by `tests/tools-claude-alignment.test.ts`.
- **Automa is read-only and stateless**: only Read, Glob, Grep, WebFetch; Write, Edit and Shell are refused. Enforced by `tests/automa-tool.test.ts`. Its model lives in `ToolModelStorage`, not `ActorCatalog` (storage covered by `tests/tool-models.test.ts`; the decoupling itself is *Unenforced*).
- **`_FinishRound` is mandatory**: always eager, silent and available to all roles; user overrides that defer, hide or restrict it are rejected. Enforced by `tests/tool-disclosure.test.ts`, `tests/tools-registry.test.ts`, `tests/tool-ui.test.ts`.
- **`loading` is independent of `roles` and `terminalVisibility`**: Enforced by `tests/tool-disclosure-registry.test.ts`.
- **The deferred directory lists names and one-line descriptions, never schemas**; builtin names cannot be overridden by extension registrations. Enforced by `tests/tool-disclosure-registry.test.ts`.
- **Loading a tool never executes it or grants permission**: Enforced by `tests/anthropic-tool-disclosure.test.ts`, `tests/openai-tool-disclosure.test.ts`.
- **Categories come from data, not code**: `categories:` frontmatter in this file feeds `readToolCategories()`; a missing or invalid header falls back to directory names. Enforced by `tests/tools-taxonomy.test.ts`.
- **Read keeps complete lines**: default 2,000 lines, 256 KiB UTF-8 output cap that fails explicitly instead of clipping a line, 32 MiB file cap, 10 MiB image cap. Enforced by `tests/tool-contract-accuracy.test.ts` for the 256 KiB and line rules; the 32 MiB and 10 MiB caps are *Unenforced*.
- **Grep uses the bundled ripgrep** (`LOGOX_RIPGREP_PATH` first, never host PATH as primary). `tests/tool-parameter-alignment.test.ts` asserts the resolved binary exists; the no-PATH rule is *Unenforced*.
- **`runProcess()` reclaims children within 1.5 s of a kill**, even if `taskkill` fails. Enforced by `tests/agent.test.ts`.
- **Every built-in owns a `UI.ts`; hidden tools have no visible surface**: Enforced by `tests/tool-ui.test.ts`. Execution code must not import `ui-registry.ts`: *Unenforced*.
- **Titles name the decision-relevant parameter first and stay on one line**: Enforced by `tests/tool-ui.test.ts`.
- **Tool descriptions live in the tool's `prompt.ts`, not under `src/prompts/`**: *Unenforced*.

## 5. Dependencies
- **Depends on**: `src/permissions/` (path risk and `guard.authorize()` before every core tool), `src/runtime/` (`ToolDefinition`, `ToolCall`), `src/tui/timeline/tool-ui.ts` (`createToolUI`), `src/extensions/` (MCP definitions and the Playwright server config), `@vscode/ripgrep`.
- **Used by**: `src/kernel/agent.ts` (`agentRequestBase()` pool and exposure), `src/actors/services.ts` (service tool execution), `src/application.ts` (registry creation, MCP registration, `/undo`, `/model automa`), `src/tui/` (`ui-registry.ts` for cards and the question interaction), `src/context/` (round memory from `_FinishRound`).

## 6. Verification & Gaps
- Fast run: `node --test dist/tests/tools-*.test.js dist/tests/tool-*.test.js dist/tests/automa-tool.test.js dist/tests/git-status-tool.test.js dist/tests/finish-round.test.js dist/tests/tiered-tools-integration.test.js dist/tests/*disclosure*.test.js`
- Not covered offline: live Playwright browser runs (`tests/playwright-browser.test.ts` is skipped without installed browsers); live provider behavior for native tool search.
- Shell has no `run_in_background`, `BashOutput` or `KillShell`.
- `Shell.timeout` still infers units: values up to 600 are seconds, larger are milliseconds. Removing this needs a caller migration, not a description edit.
