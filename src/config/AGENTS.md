# Module: Configuration & Persistence (`src/config/`)

## 1. Scope
- **Owns**: The config schema and cascade (`config.ts:loadConfig()`), `modelSettings()` (thinking protocol and level inference), provider `presets`, saved model preferences and atomic `StateFile<T>` (`model-preferences.ts`), model variant grouping (`model-grouping.ts`), statusbar and onboarding preferences, UI presentation preferences (`ui-settings.ts`) and the `/settings` row definitions (`settings-definitions.ts`), and the theme registry (shipped `themes/*.json` plus `~/.logox/themes/*.json`).
- **Does not own**: HTTP transport, model discovery and wire formats ([`src/providers/AGENTS.md`](../providers/AGENTS.md)); the lock and atomic-replace primitives (`src/store/file-lock.ts`, `src/store/replace-file.ts`, see [`src/runtime/AGENTS.md`](../runtime/AGENTS.md)); picker and settings panels (`src/tui/`); actor colors and models ([`src/actors/AGENTS.md`](../actors/AGENTS.md)).
- **Design rationale**: [docs/USAGE.md](../../docs/USAGE.md) (load order, keys); [docs/COLORS.md](../../docs/COLORS.md) (theme files and tokens); [docs/modules/task-models.md](../../docs/modules/task-models.md) (model selection).

## 2. Start Here
| If you need to... | Start at | Then check |
|---|---|---|
| Follow the cascade or a TOML error | `config.ts:loadConfig()` | `config.ts:merge()`, `config.example.toml` |
| Add or change a config key | `config.ts:schema` | `config.example.toml`, `docs/USAGE.md` |
| Resolve a thinking protocol or effort levels | `config.ts:modelSettings()` | `model-preferences.ts:isOpenAiReasoningModel()`, `model-grouping.ts:detectEffortLevels()` |
| Declare which built-in model catalog a gateway mirrors | `config.ts:catalogSchema` (`[catalogs.<provider>]`) | `src/providers/model-table.ts:ModelTable.resolve()`, [docs/modules/model-table.md](../../docs/modules/model-table.md) |
| Provider presets and defaults | `config.ts:presets` | `src/providers/registry.ts:ProviderRegistry.names()` |
| Saved model/effort selection | `model-preferences.ts:preferenceSchema` | `model-preferences.ts:StateFile`, `src/store/file-lock.ts:withFileLock()` |
| Collapse model variants in the picker | `model-grouping.ts:groupModelsForProvider()` | `model-grouping.ts:groupModelFamilies()` |
| Statusbar modules, styles, palettes | `statusbar-preferences.ts:StatusbarPreferences` | `statusbar-palettes.json`, `~/.logox/statusbar.json` |
| Theme files, `base` chains, user overrides | `theme-presets.ts:loadThemePresets()` | `theme-palette.ts:resolveThemeColors()`, `themes/logox-dark.json` |
| Add or change a `/settings` row (label, description, group, kind, options, default, persistence) | `settings-definitions.ts:settingDefinitions` | `ui-settings.ts:UiPreferences`, `tests/settings-definitions.test.ts` |
| Presentation preferences read by renderers (tool tint, thinking display, diff layout, splash, enter key, notify) | `ui-settings.ts:uiSettings()` | `ui-settings.ts:applyUiSettings`, `~/.logox/ui-preferences.json` |
| Preferred user name (`/name`, onboarding step, live timeline label) | `user-profile.ts:sanitizeUserName()` | `user-profile.ts:saveUserName()`, `src/context/environment.ts:formatEnvironment()` |
| First-run onboarding flag | `onboarding-preferences.ts:shouldOfferOnboarding()` | `~/.logox/` onboarding file |

## 3. Common Changes
### Add a config key
1. Add the field with `.default()` to the matching object in `config.ts:schema` (or a shared schema such as `contextPolicySchema`). Also update the `.default({...})` literal of the enclosing object, which must list the same defaults.
2. If it is a new string-typed key that must stay a string when set through `LOGOX__*`, add it to the allow-list in `loadConfig()` (numbers and booleans are coerced by regex).
3. Add it to `config.example.toml` (commented when optional) and describe it in `docs/USAGE.md`.
4. Read it from the validated `Config` at the call site, for example `src/application.ts`; never read TOML directly.
- Tests: `tests/config.test.ts` (cascade and rejection cases).

### Add a theme color token
1. Add the key to `theme-palette.ts:themeColorKeys`. A baseline value is mandatory: add it to `themes/logox-dark.json` (hex, or `$token` for an alias); module load throws on a missing or unknown key.
2. Use it through `palette.<key>` from `theme-palette.ts`; never write a color literal in UI code.
3. Other shipped themes inherit via `base`; override in `themes/*.json` only when the baseline does not suit them. List the token in `docs/COLORS.md`.
- Tests: `tests/theme-colors.test.ts`, `tests/theme-presets.test.ts`, `tests/color-literals.test.ts`.

### Add a shipped theme
1. Create `themes/<name>.json` with `colors` and optionally `base` (`logox-dark` is the root).
2. Update the shipped-theme count assertions and list in `tests/theme-presets.test.ts` (it expects exactly the shipped set). Build copies `themes/*.json` to `dist`.
- Tests: `tests/theme-presets.test.ts`.

### Add a `/settings` row
1. Add the value to `ui-settings.ts:uiPreferencesSchema` (with `.default()`, and to `UiSettings` / `defaultUiSettings` when a renderer reads it live), or pick the store that already owns it (statusbar, user profile, model preference, permissions).
2. Add a `SettingDefinition` to `settings-definitions.ts:settingDefinitions`: `key`, `label`, one-sentence `description`, `group`, `kind`, `options` (and `labels`), `default`, and `read`/`write` hooks; a value that should preview live also sets `preview`/`revert`.
3. Read it where it takes effect (`uiSettings()` in a renderer, or the owning store); document it in `docs/USAGE.md`.
- Tests: `tests/settings-definitions.test.ts` iterates every definition (group, description, default, options, a write that reads back and survives a reload), `tests/settings-behaviours.test.ts` for the behaviour.

### Add a persisted preference file
1. Define a strict Zod schema with a `version` literal and wrap the path in `StateFile` (see `model-preferences.ts:preferenceSchema`). Use `update()` for read-modify-write.
2. Resolve the path from an injectable `home`, never `homedir()` inside the write path, so tests stay isolated.
- Tests: `tests/state-file-lock.test.ts`, `tests/fresh-directory-models.test.ts`.

## 4. Hard Boundaries
- **`cache_retention` resolves model > provider > named provider** like `prompt_cache_key` (`config.ts:modelSettings()` -> `ModelSettings.cacheRetention`); unset stays unset so providers can tell an explicit choice from a default. `[kernel] cache_keepalive` (default true) switches cache keep-alive. Enforced by `tests/provider-cache-retention.test.ts`.
- **`model_kinds` routes a model to another protocol inside one provider** (`config.ts:modelSettings()`, patterns via `config.ts:matchesModelPattern()`): lookup is `[provider]`, then `[providers.<name>]`, then the preset (only when `base_url` is the preset's own); explicit `[provider] kind` disables routing. `ModelSettings.kind` is the model's kind, `providerKind` the provider's. Enforced by `tests/provider-model-kinds.test.ts`.
- **Cascade order** is `~/.logox/config.toml`, then ancestor `.logox/config.toml` files (far to near, home excluded, each physical file loaded once), then the saved model preference, then `LOGOX__*`, then CLI overrides. Enforced by `tests/config.test.ts`.
- **Switching provider drops the old endpoint, model and credentials** and keeps only `temperature`, `max_tokens`, `timeout`, `thinking_effort`. Enforced by `tests/config.test.ts`.
- **Config never stores keys**: `api_key`, prototype keys and credentialed URLs are rejected. Enforced by `tests/config.test.ts`.
- **Only `~/.logox/` is read**: `.logox-ts` is not a config, preference or theme source. Enforced by `tests/fresh-directory-models.test.ts`.
- **Model preference lookup**: project `.logox/state/model-preferences.json`, then `~/.logox/model-preferences.json`; injected `home` must reach both load and save. Enforced by `tests/fresh-directory-models.test.ts`.
- **An unreadable or invalid saved preference never aborts startup**: one diagnostic is emitted and config values win; the file is left untouched. Enforced by `tests/model-preferences-usage.test.ts` (diagnostic and fallback); byte preservation is *Unenforced*.
- **`StateFile` writes are locked, temp-then-replace, and never overwrite a corrupt file**: Enforced by `tests/state-file-lock.test.ts`.
- **Colors are data**: system colors live only in theme JSON (`logox-dark.json` is complete and the root); actor colors and card surfaces belong to `~/.logox/actors/<id>/config.yaml`. Enforced by `tests/color-literals.test.ts`, `tests/theme-colors.test.ts`.
- **Theme application is atomic**: aliases resolve after inheritance; an invalid overlay changes nothing. Enforced by `tests/theme-colors.test.ts`.
- **Bad user theme files are skipped and reported by `themeIssues()`; a bad shipped file throws**: Enforced by `tests/theme-presets.test.ts` (user side); the shipped-file throw is *Unenforced*.
- **Thinking levels per protocol** (`deepseek` has no `medium`; `anthropic-adaptive` on Opus adds `max`; others default to five levels). Enforced by `tests/model-preferences-usage.test.ts`; a user `thinking_levels` always wins.

## 5. Dependencies
- **Depends on**: `src/store/` (`withFileLock()`, `replaceFile()`), `src/extensions/` (MCP and hook schemas embedded in the config schema), `src/runtime/` (`immutable()` for statusbar defaults).
- **Used by**: `src/cli.tsx` and `src/application.ts` (load and apply), `src/providers/` (`modelSettings()`, `presets`), `src/kernel/agent.ts` (kernel limits), `src/actors/` (task models, recovery), `src/context/` (policy, usage), `src/tui/` (theme palette, statusbar).

## 6. Verification & Gaps
- Fast run: `node --test dist/tests/config.test.js dist/tests/model-preferences-usage.test.js dist/tests/state-file-lock.test.js dist/tests/fresh-directory-models.test.js dist/tests/theme-*.test.js dist/tests/color-literals.test.js dist/tests/model-grouping.test.js dist/tests/statusbar-modules.test.js dist/tests/onboarding-preferences.test.js dist/tests/user-name.test.js`
- Not covered offline: live provider availability; recovering an unknown previous user selection; true color fidelity of themes in real terminals.
