# Module: Test Suite (`tests/`)

## 1. Scope
- **Owns**: All `tests/*.test.ts(x)` files, the shared helpers `runtime-fixture.ts`, `wait-for.ts`, `tool-fixture.ts`, `terminal-screen.ts`, `compression-fixture.ts`, and `fixtures/` (MCP server, permission worker, shipped-skill snapshot).
- **Does not own**: Production code under test; each subsystem signpost links back here for its group. Live provider, OAuth, real-terminal and headed-browser checks are manual (see section 6).
- Tests compile with `tsc` to `dist/tests/`; run the compiled JavaScript there. The build is a prerequisite, not part of the fast run.

## 2. Start Here
Every `tests/*.test.*` file belongs to exactly one group. Names are shown without extensions where obvious; Ink (tsx) files in a group are matched by the same compiled globs.

| Domain | Test files | Fast run (`node --test ...`) |
|---|---|---|
| Context & round memory | `context*.test.ts`, `actor-context`, `round-memory`, `finish-round`, `runtime-steps` | `dist/tests/context*.test.js dist/tests/actor-context.test.js dist/tests/round-memory.test.js dist/tests/finish-round.test.js dist/tests/runtime-steps.test.js` |
| Providers & models | `providers*.test.ts`, `provider-*`, `network-*`, `openai-provider`, `model-*.test.ts`, `fallback-degradation`, `error-format`, `fresh-directory-models` | `dist/tests/provider*.test.js dist/tests/network-*.test.js dist/tests/openai-provider.test.js dist/tests/model-grouping.test.js dist/tests/model-pool.test.js dist/tests/model-preferences-usage.test.js dist/tests/fallback-degradation.test.js dist/tests/error-format.test.js dist/tests/fresh-directory-models.test.js` |
| Actors & ensemble | `ensemble`, `actor-definitions`, `actor-collaboration*`, `actor-recovery`, `actors-integration`, `actor-color-source`, `actor-compression-contracts`, `task-*`, `progress-lifecycle`, `message-delivery`, `human-input-delivery`, `director-*`, `narration`, `execution-recovery-policy`, `agent`, `user-interrupt` | `dist/tests/actor-collaboration*.test.js dist/tests/actor-color-source.test.js dist/tests/actor-compression-contracts.test.js dist/tests/actor-definitions.test.js dist/tests/actor-recovery.test.js dist/tests/actors-integration.test.js dist/tests/ensemble.test.js dist/tests/task-*.test.js dist/tests/progress-lifecycle.test.js dist/tests/*delivery.test.js dist/tests/director-*.test.js dist/tests/narration.test.js dist/tests/execution-recovery-policy.test.js dist/tests/agent.test.js dist/tests/user-interrupt.test.js` |
| Tools & MCP | `tools-*`, `tool-*`, `automa-tool`, `automa-ui`, `edit-tool`, `git-status-tool`, `subagent-efficiency-vision`, `tiered-tools-integration`, `playwright-browser`, `mcp-ui` | `dist/tests/tool*.test.js dist/tests/automa-tool.test.js dist/tests/automa-ui.test.js dist/tests/edit-tool.test.js dist/tests/git-status-tool.test.js dist/tests/subagent-efficiency-vision.test.js dist/tests/tiered-tools-integration.test.js dist/tests/playwright-browser.test.js dist/tests/mcp-ui.test.js` |
| Permissions | `permission*.test.ts`, `creative-reading` | `dist/tests/permission*.test.js dist/tests/creative-reading.test.js` |
| TUI rendering & interaction | `tui*`, `terminal-*`, `stage-*`, `actor-pills*`, `actor-cards`, `actor-thinking-animation`, `ui-layout`, `thinking-groups`, `timeline-turns`, `app`, `composer-clean`, `fullscreen-*`, `input-queue-ui`, `interactions`, `production-question-geometry`, `question-*`, `toggle-*`, `tabbed-page-single`, `system-notices-ui`, `session-ui`, `session-delete`, `color-literals`, `theme-*` | `dist/tests/tui*.test.js dist/tests/terminal-*.test.js dist/tests/stage-*.test.js dist/tests/actor-pills*.test.js dist/tests/actor-cards.test.js dist/tests/actor-thinking-animation.test.js dist/tests/ui-layout.test.js dist/tests/thinking-groups.test.js dist/tests/timeline-turns.test.js dist/tests/app.test.js dist/tests/composer-clean.test.js dist/tests/fullscreen-*.test.js dist/tests/input-queue-ui.test.js dist/tests/interactions.test.js dist/tests/production-question-geometry.test.js dist/tests/question-*.test.js dist/tests/toggle-*.test.js dist/tests/tabbed-page-single.test.js dist/tests/system-notices-ui.test.js dist/tests/session-ui.test.js dist/tests/session-delete.test.js dist/tests/color-literals.test.js dist/tests/theme-*.test.js` |
| Slash commands & surfaces | `command-*`, `slash-*`, `application-status`, `completion`, `settings-interaction`, `statusbar-customization`, `statusbar-selection`, `model-picker-*` | `dist/tests/command-*.test.js dist/tests/slash-*.test.js dist/tests/application-status.test.js dist/tests/completion.test.js dist/tests/settings-interaction.test.js dist/tests/statusbar-customization.test.js dist/tests/statusbar-selection.test.js dist/tests/model-picker-*.test.js` |
| Sessions & storage | `sessions`, `session-*.test.ts`, `state-file-lock`, `replace-file`, `system-history*` | `dist/tests/sessions.test.js dist/tests/session-integration.test.js dist/tests/session-leases.test.js dist/tests/session-lifecycle.test.js dist/tests/state-file-lock.test.js dist/tests/replace-file.test.js dist/tests/system-history*.test.js` |
| Resources & extensions | `resources`, `hierarchical-skills`, `extensions` | `dist/tests/resources.test.js dist/tests/hierarchical-skills.test.js dist/tests/extensions.test.js` |
| Prompts & disclosure | `prompt-*`, `prompts`, `docs`, `runtime-context-updates`, `anthropic-tool-disclosure`, `openai-tool-disclosure` | `dist/tests/prompt*.test.js dist/tests/docs.test.js dist/tests/runtime-context-updates.test.js dist/tests/*-tool-disclosure.test.js` |
| Config, login & doctor | `config*`, `onboarding-preferences`, `user-name`, `doctor`, `login*`, `custom-*`, `credential-import`, `oauth-login`, `statusbar-modules` | `dist/tests/config*.test.js dist/tests/onboarding-preferences.test.js dist/tests/user-name.test.js dist/tests/doctor.test.js dist/tests/login*.test.js dist/tests/custom-*.test.js dist/tests/credential-import.test.js dist/tests/oauth-login.test.js dist/tests/statusbar-modules.test.js` |
| Demo & Anamnesis | `demo`, `anamnesis*` | `dist/tests/demo.test.js dist/tests/anamnesis*.test.js` |

Full run: `node --test --test-concurrency=4 dist/tests/*.test.js`. Helper files (`runtime-fixture.ts`, `terminal-screen.ts`, `compression-fixture.ts`) are not tests and match no `*.test.js` glob.

## 3. Common Changes
### Add a test file
1. Create `tests/<name>.test.ts` (or a tsx file for Ink). Name it with the prefix of its group so the group glob picks it up; a file that matches no glob in section 2 needs a new glob or group row in this file.
2. Import from `../src/...js` with `node:test` and `node:assert/strict`. The compiled file lands in `dist/tests/` after `npm run build`.
3. For an application-level test use `runtime-fixture.ts:createTestApplication()` (wraps the provider so scripted turns close through `_FinishRound`) and `waitForSnapshot()` instead of sleeps.
- Tests: `tests/docs.test.ts` guards signposts and links.

### Isolate the home directory and temp files
1. Pass `resourceOptions: {home: <temp>, boundary: <temp>}` to `createApplication()` / `createTestApplication()`, and the same `home` and `boundary` arguments to `loadConfig()`, so `~/.logox/` is never read or written. `new Resources(cwd, {home, boundary})` takes the same options.
2. Create roots with `mkdtemp(join(tmpdir(), 'logox-test-'))` and remove them in `finally { await rm(root, {recursive: true, force: true}); }`.
3. Bind servers to `listen(0, '127.0.0.1')`; in `finally` call `server.closeAllConnections()` and `server.close()`, and kill spawned children.
- Tests: pattern shown in `tests/actors-integration.test.ts`, `tests/resources.test.ts`.

### Test an Ink component
1. Copy the harness from `tests/app.test.tsx`: `Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true})`, a `PassThrough` input with `isTTY`/`setRawMode`, and `TerminalScreen` (from `terminal-screen.ts`) as output.
2. Render with `renderTerminal` from `src/tui/terminal/terminal.tsx`, wrap flushes in `act()` with `instance.waitUntilRenderFlush()`, and read `screen.lines` or `backgroundColors`.
3. Run with `NODE_ENV=development`. New files under `src/tui/` also need an entry in the `layout` map of `tests/tui-module-layout.test.ts`.
- Tests: `tests/app.test.tsx`, `tests/fullscreen-composer.test.tsx`

### Add or reuse a fixture
1. Put static assets in `tests/fixtures/` and resolve them relative to `import.meta.url`. Current ones: `mcp-server.mjs` (`extensions.test.ts`), `permission-worker.ts` (`permissions.test.ts`, `permission-modes.test.ts`), `browser-screenshot-v1.md` (`hierarchical-skills.test.ts`).
2. Put shared code helpers beside the tests as non-`.test` files (see `runtime-fixture.ts`). Do not add production-only branches to make a fixture pass. `wait-for.ts` holds the shared `waitFor(read, predicate, {timeoutMs, label})` poller.
- Tests: `tests/extensions.test.ts`

## 4. Hard Boundaries
- **Tests never touch the real home or credentials**: always pass a temp `home` and `boundary`; use fake or local providers so no API credits are spent. *Unenforced* (convention; a test that forgets reads the real `~/.logox/`).
- **Async assertions wait on conditions, never fixed sleeps**: UI frames, store state, files and cross-process effects are awaited with `tests/wait-for.ts:waitFor` (or `runtime-fixture.ts:waitForSnapshot`), which polls with a generous deadline and reports the last observed value; only scheduling timeouts may be widened, never semantic assertions. *Unenforced*.
- **Temp roots are deterministic**: `mkdtemp` under `tmpdir()` with cleanup in `finally`; dynamic ports only. *Unenforced*.
- **Delivery regressions inspect real artifacts**: assert actual provider requests and persisted receipts, not only queue or card creation (pending admission, finalizer sealing, retry, stale targets, broadcasts after stop). Examples: `tests/message-delivery.test.ts`, `tests/human-input-delivery.test.ts`. As a rule, *Unenforced*.
- **Raw journals stay append-only**: tests distinguish authoritative records from UI and model projections. Enforced by `tests/round-memory.test.ts`, `tests/session-lifecycle.test.ts`.
- **Finalizer enforcement is never weakened**: `runtime-fixture.ts` adapts only successful scripted turns; lifecycle and wire tests bypass it. *Unenforced*.
- **Signposts and docs stay valid**: links, headings, and code references are checked. Enforced by `tests/docs.test.ts` and `scripts/check-docs.mjs` (`npm run check`).

## 5. Dependencies
- **Depends on**: every `src/` subsystem it covers, `scripts/check-docs.mjs` (docs checker), `node:test`, `react` and `ink` for TUI tests.
- **Used by**: `package.json` (`npm test` runs `check:docs`, `build`, then the full suite), developers and agents verifying a change; subsystem signposts link here for their group commands.

## 6. Verification & Gaps
- Fast run: pick the group row in section 2. Before concluding a change: `npm run check`, then the full run in section 2.
- Not covered offline: live provider and model compliance; real-terminal rendering (true color, CJK width, mouse, resize); interactive OAuth; headed Playwright (`tests/playwright-browser.test.ts` is skipped without installed browsers); heavy multi-process `.lock-v2` contention and long-horizon loops.
