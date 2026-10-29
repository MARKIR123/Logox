# Module: Terminal UI (`src/tui/`)

## 1. Scope
- **Owns**: React/Ink presentation, terminal output coordination, timeline projection, local form editing and theme consumption.
- **Does not own**: Runtime execution, Actor profile ownership, provider authentication or credential persistence.

## 2. Start Here (Task Router)
| If investigating... | Start at... | Then check... |
|---|---|---|
| Application wiring, windows, focus or Queue/Steer | `app.tsx` / `application.tsx` | `input/` and the public application delivery contract |
| Terminal flicker, scrolling or output ordering | `terminal/terminal.tsx`, `terminal/terminal-plane.ts` | `timeline/row-presentation.ts` |
| Cards, folding or message projection | `timeline/stage.ts` | `timeline/scene.ts`, `timeline/viewport.ts`, `timeline/selection.ts` |
| Markdown or display-cell layout | `timeline/markdown.ts` | `timeline/markdown-table.ts`, `terminal/text.ts` |
| Composer expansion, multiline editing or native caret | `input/fullscreen-editor.tsx` and `input/editor.ts` | App owns the shared draft and passes its single cursor setter |
| Command matching or candidate lists | `commands/completion.ts` | `commands/command-menu.tsx`, `commands/command-suggestions.tsx` |
| Full-screen selectors, management pages or query results | `panels/` | `panels/command-result.tsx`, `src/commands/surfaces.ts`, `src/application-commands.ts` |
| Question layout and answer interaction | `interactions/question-panel.tsx` | `interactions/production-question.tsx`; App owns runtime keyboard handling |
| Local login forms | `login/` | `providers/login.ts`, `providers/login-wizard.ts`; never persist credentials in view state |
| Statusbar layout, styles or preview | `status/statusbar.ts` and `status/statusbar-editor.tsx` | `config/statusbar-preferences.ts`; both command entries share the editor |
| Running Actor pills or navigation | `status/actor-pills.tsx` | `timeline/actor-location.ts` |
| System colors, Actor identity or animation | `appearance/` | `config/theme-palette.ts`, `config/themes/*.json`, Actor profiles |
| Independent acceptance previews | `previews/` | `scripts/preview-slash.mjs`, `scripts/preview-questions.mjs` |

## 3. Hard Boundaries
- **Cohesion**: Only `app.tsx` and `application.tsx` are root source entrypoints. `components/` contains business-neutral primitives; local mouse/keyboard/focus behavior is allowed, while Actor/provider/session/task policy remains outside. Keep feature-specific types beside their implementation, not in global `utils/` or `types/` buckets. Production views never import `previews/`. Verify layout/dependencies with `tests/tui-module-layout.test.ts`.
- **Independent implementation**: UI inspiration is a behavioral/visual specification, not permission to copy or line-edit another project's implementation. Preserve required notices for any genuinely retained third-party source. Existing library dependencies and real external credential-format integrations remain distinct from source adaptation.
- **System colors**: Read semantic palette tokens. Focus uses `accent`; checked/unfocused controls use `checkedFg`; disabled/idle descriptions use `muted`. Preserve theme-revision invalidation through App memoization, timeline projection and encoded rows. Additions pass the color-literal and theme-color regressions. Actor identity and card surfaces remain profile-owned.
- **Command panels**: Settings and Statusbar share `/settings` tabs; the Settings tab ID is `settings`. `/animations` remains a legacy alias of `/settings`; `/statusbar` opens the same editor directly. Settings rows keep fixed order; only modules reorder. Style/palette selectors remain separate from module IDs. Tab drafts update synchronously before save, and a pending gate locks same-chunk input immediately. Settings applies the current tab without closing or losing other drafts; the dedicated editor closes on save. `/config` opens a single read-only Effective Configuration page for the existing model, effort, base URL, Automa and execution limits; it has no appearance controls, mutation actions or source tracing. Single-tab surfaces hide redundant tabs. Permissions and runtime Status (`/status`, state and usage) remain separate.
- **System feedback**: Hosts assign explicit `presentation`; renderers never classify text. Model/effort receipts are silent; saves flash in the existing footer, queries use owner/session-scoped result panels, and welcome appears only in empty state. Replay never re-toasts or reopens results. Result Ctrl+C copies original text, Esc returns without changing drafts, and Ctrl+D still exits. Async results must match their originating surface ID.
- **Input intent**: Normal Enter queues later work; fullscreen Enter inserts a newline and Ctrl+Enter/Send queues. Ctrl+T steers an exact live activity. The right-side expand button edits the same session/Actor draft and caret; Collapse/Esc retains them and the timeline anchor. App remains the sole native cursor owner, passing its setter to the fullscreen view; parent input, paste, mouse and timeline plane yield while that editor is active. Preserve drafts on stale targets or rejected delivery. Queue/Steer never cancels a task. Composer stays free of leading pointer/placeholder clutter; restore the terminal cursor on exit.
- **Selection and mouse**: Statusbar dragging selects only status text; release writes OSC52. Timeline dragging takes priority over folding. Actor pills retain activation order; double-click locates the latest Actor card.
- **Rail ownership**: Director timeline rails use the Director accent, Actor windows use their Actor identity and human turns use `user`. Headers and pills retain per-Actor identity. System messages use the system token. Inline collaboration interruptions stay inside their working card and use `directorIntervention`.
- **Animation safety**: Backgrounds and column widths stay static. Animate only fixed-width glyph slots and text luster. Preserve 200ms frame pacing for up to eight frames and 130ms for ten-dot Braille; Actor frames come from profiles. Optional motion never changes task state.
- **Tool ownership**: Registered tool UI modules own formatting and question actions; hosts own layout/focus/scheduling. Hidden tools have no visible or selectable surface. Rendering never executes a tool or reopens an interaction.
- **Local forms**: Login secrets stay in local drafts and authentication storage, never ordinary runtime questions, transcripts or model context. The pure question-row planner is shared by local forms and production views; do not mount a second keyboard owner for runtime questions.

## 4. Integration Points
```text
runtime/store.ts → timeline/stage.ts → timeline/scene.ts
                                     → timeline/row-presentation.ts
                                     → terminal/terminal-plane.ts
app.tsx → commands/ + panels/ + interactions/ + login/ + status/
        → components/ + appearance/ + terminal/ + input/
```

## 5. Verification
- `tests/tui-module-layout.test.ts`: directory ownership, neutral primitive dependencies and retired build artifacts.
- `tests/{command-suggestions,question-panel,login-panel,login-wizard}.test.*`: independent view/flow behavior and privacy.
- `tests/{settings-interaction,stage-reading,thinking-groups,theme-app,theme-colors,color-literals}.test.*`: interaction, geometry, animation and theme contracts.
- Build with `npm run build`; run Ink tests with `NODE_ENV=development`. Full suite uses isolated homes with shipped profiles, never personal credentials.

## 6. Known Gaps
- Automated Ink/row tests do not replace real-terminal visual acceptance or live provider/OAuth verification.
