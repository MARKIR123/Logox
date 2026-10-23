# Module: Configuration & Persistence (`src/config/`)

## 1. Scope
- **Owns**: Hierarchical configuration cascade, TOML schema validation, `modelSettings()` resolving thinking protocols and level sets, atomic `StateFile<T>` persistence (`~/.logox/model-preferences.json`, legacy `.logox-ts` fallback), and model variant grouping.
- **Does not own**: Low-level HTTP transport or network model fetching (owned by `src/providers/`).

## 2. Start Here (Task Router)
| If investigating... | Start at... | Then check... |
|---|---|---|
| Configuration cascade, overrides, or TOML errors | `config.ts:loadConfig()` | `config.toml` search paths and `merge()` |
| Thinking protocol capability or effort levels | `config.ts:modelSettings()` | `thinkingProtocol` and `thinkingLevels` logic |
| Atomic state file corruption or lock contention | `model-preferences.ts:StateFile` | `withFileLock()` in `src/store/file-lock.ts` |
| Model grouping or suffix collapsing in picker | `model-grouping.ts` | `groupModelsForProvider()` |
| User statusbar preferences | `statusbar-preferences.ts` | `~/.logox-ts/statusbar.json` |

## 3. Hard Boundaries
- **Hierarchical Configuration Cascade**:
  - Configuration cascades in order of increasing specificity:
    `~/.logox/config.toml` -> `~/.logox-ts/config.toml` -> `<ancestors>/.logox/config.toml` -> `<cwd>/.logox/config.toml` -> Environment (`LOGOX__*`) -> CLI flags.
  - Higher tiers override lower tiers cleanly without leaking obsolete subfields across providers.
  - Model preference priority is project state, canonical user home, then legacy user home. Injected `resourceOptions.home` must reach both loading and saving; isolated tests never write the process user's preferences.
- **StateFile Atomic Safety**:
  - State files use `.tmp` random-UUID writes followed by atomic replace, wrapped inside `withFileLock()`.
  - Corrupted state files MUST throw to trigger diagnostic notices; never silently swallow corruption with empty defaults.
- **Thinking Protocol Capabilities**:
  - `deepseek`: defaults to `['auto', 'off', 'low', 'high', 'max']` (no `medium`).
  - `anthropic-adaptive`: defaults to `['auto', 'off', 'low', 'medium', 'high', 'max']` on Opus, 5 tiers on Sonnet.
  - `reasoning-effort`: maps to OpenAI reasoning effort levels.

## 4. Integration Points
```text
cli.tsx / application.ts (calls loadConfig())
  → config/config.ts (merges TOML files, environment vars, and state preferences)
  → config/model-preferences.ts (reads/saves model-preferences.json via StateFile)
  → providers/registry.ts (receives validated ModelSettings)
```

## 5. Verification
- **Targeted Test Suite**:
  - `tests/config.test.ts`: TOML parsing, environment overrides, cascade order.
  - `tests/model-preferences-usage.test.ts`: Model preferences, thinking effort tiers, and usage ledgers.
  - `tests/state-file-lock.test.ts`: Atomic write concurrency and corrupted file diagnostics.
  - `tests/fresh-directory-models.test.ts`: Fresh-project tabs, global selection precedence and injected-home write isolation.
- **Fast Run Command**:
  ```bash
  node --test dist/tests/config.test.js dist/tests/model-preferences-usage.test.js dist/tests/state-file-lock.test.js dist/tests/fresh-directory-models.test.js
  ```

## 6. Known Gaps
- Isolated configuration tests do not validate live provider availability or recover an unknown previous user selection.
