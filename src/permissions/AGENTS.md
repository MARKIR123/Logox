# Module: Permissions & Security Sandbox (`src/permissions/`)

## 1. Scope
- **Owns**: Permission evaluation engine, three operating modes (`default`, `auto`, `creative`), project-level rule persistence (`.logox/permissions.json`), path risk categorization (`pathDanger`, `riskyPath`), scratchpad sandbox auto-approval, and tool interceptor guard.
- **Does not own**: Low-level tool process execution (owned by `src/tools/`).

## 2. Start Here (Task Router)
| If investigating... | Start at... | Then check... |
|---|---|---|
| Mode switching, rule evaluation, or prompt decisions | `engine.ts:PermissionEngine` | `.logox/permissions.json` and rule matching |
| Path boundaries, scratchpad auto-approval, or sensitive files | `paths.ts:pathDanger()` | `isScratchpadPath()` and `riskyPath()` |
| Shell command AST risk classification | `shell.ts:shellImpact()` | Prefix matching and AST tokenization |
| Interactive user approval cards & decision caching | `guard.ts:PermissionGuard` | `PermissionEngine.evaluate()` |

## 3. Hard Boundaries
- **Scratchpad Sandbox Auto-Approval**: Operations inside the session scratchpad directory (`tmpdir()/logox-scratchpad/<cwdHash>/<sessionId>/`) MUST be automatically approved with zero user prompts.
- **Deny Precedence**: Explicit `deny` rules take absolute precedence across all 3 modes.
- **Credential & VCS Protection**: Files matching credentials (`auth.json`, `.env`, `id_rsa`, `.ssh`) or VCS internals (`.git`) are strictly protected from modification across all modes.
- **Development Runtime Write in Creative Mode**: In `creative` mode, runtime assets (`.logox` and `.logox-ts` prompts, skills, journals, state) may be modified by the agent, while credentials and `.git` remain protected.

## 4. Integration Points
```text
tools/index.ts (receives tool call)
  → permissions/guard.ts (checks session authorization)
  → permissions/engine.ts (evaluates policy, scratchpad, rules, and mode)
  → store/file-lock.ts (persists project rules atomically)
```

## 5. Verification
- **Targeted Test Suite**:
  - `tests/permissions.test.ts`: Engine evaluation, rule addition, persistent deny precedence.
  - `tests/permission-modes.test.ts`: Fast-path and review behaviors across the 3 modes.
  - `tests/creative-reading.test.ts`: Runtime state write relaxation and credential protection.
- **Fast Run Command**:
  ```bash
  node --test dist/tests/permission*.test.js dist/tests/creative-reading.test.js
  ```
