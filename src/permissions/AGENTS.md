# Module: Permissions & Security Sandbox (`src/permissions/`)

## 1. Scope
- **Owns**: Permission evaluation (`engine.ts:PermissionEngine.evaluate()`), the three modes (`default`, `auto`, `creative`), session and project rules (`.logox/permissions.json`), path danger classification (`paths.ts`), shell impact classification (`shell.ts`), and the run-time guard that asks the user or an independent approval model (`guard.ts:PermissionGuard.authorize()`).
- **Does not own**: Building permission targets from tool arguments and executing tools ([`src/tools/AGENTS.md`](../tools/AGENTS.md), `src/tools/index.ts:Tools.execute()`); the scratchpad path itself (`src/kernel/scratchpad.ts`, see [`src/runtime/AGENTS.md`](../runtime/AGENTS.md)); the `/permissions` panel and approval cards (`src/tui/`).

## 2. Start Here
| If you need to... | Start at | Then check |
|---|---|---|
| Understand why an action was allowed, asked or denied | `engine.ts:PermissionEngine.evaluate()` | `.logox/permissions.json`, `engine.ts:permissionRuleSchema` |
| Change what counts as a dangerous shell command | `shell.ts:shellImpact()` | `shell.ts:shellWords()`, `shell.ts:shellCommands()` |
| Protect or exclude a path | `paths.ts:pathDanger()` | `paths.ts:searchExclusions()`, `paths.ts:runtimePath()` |
| Change user approval, denial memory or the approval model | `guard.ts:PermissionGuard.authorize()` | `guard.ts:PermissionGuard.review()`, `guard.ts:reviewSystem` |
| Add, revoke or persist rules and mode | `engine.ts:PermissionEngine.add()` | `engine.ts:PermissionEngine.setMode()`, `src/store/file-lock.ts:withFileLock()` |
| See where targets are built | `src/tools/index.ts:Tools.execute()` | `src/tools/index.ts:Tools.permissionGuard()` |

## 3. Common Changes
### Add a shell danger rule
1. Add a check in `shell.ts:shellImpact()` returning `{kind: 'danger', reason}` (asks in `default` and `auto`, denied in `creative`) or `{kind: 'forbidden', reason}` (denied in every mode, checked before rules). Match on the lowercased, slash-normalized words, per segment from `shellCommands()`.
2. Keep reasons short and in English; they are shown on the approval card and stored in guard records.
3. Do not classify interpreters, pipes or substitutions as dangerous by name; they fall through to mode adjudication (`kind: 'unknown'`).
- Tests: `tests/permissions.test.ts` (Shell cases), `tests/permission-modes.test.ts` (three-mode matrix).

### Protect a path
1. Add the segment or pattern to `paths.ts:pathDanger()`. Credential and repository matches are dangers in every mode; runtime-tree writes are the one danger `creative` may allow (`RUNTIME_WRITE_DANGER`).
2. Mirror it in `paths.ts:searchExclusions()` and `searchablePath()` so Glob and Grep hide it. `shellImpact()` already consults `pathDanger()` for command words.
- Tests: `tests/permissions.test.ts`, `tests/creative-reading.test.ts`.

### Make a tool read-only for the fast path
1. Set `effect: 'read'` in the permission target built in `src/tools/index.ts:Tools.execute()`, or, for tools identified by name, add the lowercase name to the read list in `engine.ts:PermissionEngine.evaluate()`.
2. Verify that `risky` is false for in-project targets; risky reads still ask.
- Tests: `tests/permission-modes.test.ts`, `tests/creative-reading.test.ts`.

## 4. Hard Boundaries
- **Explicit `deny` rules win in every mode**, including `creative`, and before scratchpad and allow rules. Enforced by `tests/permission-modes.test.ts`, `tests/permissions.test.ts`.
- **Forbidden shell commands are denied in every mode** (self-destructing commands, root deletion, any path segment named legacy). Enforced by `tests/permissions.test.ts`.
- **Credentials (`.env*`, `auth.json`, `id_rsa`, `.ssh`, `.aws`) and `.git` are never writable by default**: `default`/`auto` ask, `creative` denies. Enforced by `tests/permissions.test.ts`, `tests/creative-reading.test.ts`.
- **`creative` may write the runtime tree** (`.logox`) while credentials and `.git` stay protected. `.logox-ts` is still treated as a runtime path so that stale directories holding credentials stay protected; nothing reads it as configuration. Enforced by `tests/permissions.test.ts` (runtime-write case), `tests/creative-reading.test.ts`.
- **Allow rules never match compound or dynamic shell commands**; shell rules must be static token prefixes. Enforced by `tests/permissions.test.ts`.
- **Project rule files are bound to the project root, written under `withFileLock`, and a corrupt or mismatched file is never overwritten**. Enforced by `tests/permissions.test.ts`.
- **Denials are remembered per operation fingerprint and cleared when the user's authorization changes**; a late `allow` after a new `deny` rule does not execute. Enforced by `tests/permission-modes.test.ts`.
- **An approval model verdict must be complete and valid; otherwise the action pauses** (one automatic retry, then ask the user to retry or switch mode). Enforced by `tests/permission-modes.test.ts`.
- **Scratchpad operations are auto-approved without prompts** (`engine.ts` allows when every path is inside the directory set by `setScratchpadDir()`). *Unenforced*; no test exercises the scratchpad branch.
- **Permission modes are not an OS sandbox**: they gate tool calls only. *Unenforced* (documented limitation).

## 5. Dependencies
- **Depends on**: `src/kernel/scratchpad.ts` (`isScratchpadPath()`), `src/store/file-lock.ts` (rule persistence), `src/runtime/` (`Provider`, `inputKind()` for review context), `src/actors/ensemble.ts` (`ActorContext` type).
- **Used by**: `src/tools/index.ts` (builds targets, owns the guard), `src/tools/GlobTool/` and `src/tools/GrepTool/` (`searchablePath()`, `searchExclusions()`), `src/actors/services.ts` (authorizes service tools), `src/application.ts` (engine, mode, scratchpad, reviewer model), `src/tui/` (rules panel and approval cards).

## 6. Verification & Gaps
- Fast run: `node --test dist/tests/permission*.test.js dist/tests/creative-reading.test.js`
- Not covered offline: real approval-model judgment quality; behavior under an actual OS-level sandbox; multi-process rule contention beyond the scripted cases.
