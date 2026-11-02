# Module: Terminal UI (`src/tui/`)

## 1. Scope
- **Owns**: React/Ink presentation under `src/tui/` (entrypoints `app.tsx`, `application.tsx`), terminal output coordination, timeline projection, local form editing and theme consumption. By inheritance also the slash command surface `src/commands.ts` (`commandCatalog`) and `src/commands/surfaces.ts` (`CommandSurfaces`), and the demo scene `src/demo.ts` with `src/demo/`.
- **Does not own**: Runtime execution and the store ([`src/runtime/AGENTS.md`](../runtime/AGENTS.md)); Actor profiles ([`src/actors/AGENTS.md`](../actors/AGENTS.md)); provider authentication and credential persistence ([`src/providers/AGENTS.md`](../providers/AGENTS.md)); theme palette and statusbar preference storage ([`src/config/AGENTS.md`](../config/AGENTS.md)); tool-owned UI modules ([`src/tools/AGENTS.md`](../tools/AGENTS.md)).
- **Design rationale**: [docs/UI-SPEC.md](../../docs/UI-SPEC.md); [docs/modules/README.md](../../docs/modules/README.md)

## 2. Start Here
| If you need to... | Start at | Then check |
|---|---|---|
| Trace application wiring, windows, focus, Queue/Steer | `app.tsx`, `application.tsx` | `input/input-delivery.ts` |
| Fix flicker, scrolling or output ordering | `terminal/terminal.tsx`, `terminal/terminal-plane.ts` | `timeline/row-presentation.ts` |
| Change cards, folding or message projection | `timeline/stage.ts` | `timeline/scene.ts`, `timeline/viewport.ts`, `timeline/selection.ts` |
| Change how consecutive Read/Grep/Glob/Shell/browser (every Playwright or `browser_*` MCP call, noun "page action") calls collapse into groups | `timeline/tool-groups.ts:groupToolMessages()` | `src/tools/ShellTool/classify.ts:classifyShellCommand()`, `timeline/stage.ts` |
| Change how a tool group row reads (summary, targets, running hint, truncation) | `timeline/group-row.ts:toolGroupRow()` | `timeline/scene.ts:pushOrdinaryCard` (`expandable`, `subline`), `src/tools/orchestration/ActorTool/UI.ts:renderActivity` |
| Change Markdown or display-cell layout | `timeline/markdown.ts` | `timeline/markdown-table.ts`, `terminal/text.ts` |
| Change the composer, multiline editing or native caret | `input/fullscreen-editor.tsx`, `input/editor.ts` | `app.tsx` owns the shared draft and the single cursor setter |
| Change command matching or candidates | `commands/completion.ts:commandSuggestions()` | `commands/command-menu.tsx`, `src/commands.ts:commandCatalog` |
| Change selectors, management pages or query results | `panels/` | `panels/command-result.tsx`, `src/commands/surfaces.ts:CommandSurfaces`, `src/application-commands.ts:createCommandTabsFor()` |
| Change question layout or answer interaction | `interactions/question-panel.tsx` | `interactions/production-question.tsx`; `app.tsx` owns runtime keyboard handling |
| Change login forms | `login/login.tsx`, `login/login-wizard.tsx` | `src/providers/login-wizard.ts` |
| Change statusbar layout, modules or style | `status/statusbar.ts`, `status/statusbar-editor.tsx` | `src/config/statusbar-preferences.ts` |
| Change running Actor pills or navigation | `status/actor-pills.tsx` | `timeline/actor-location.ts` |
| Change system colors, Actor identity or animation | `appearance/` | `src/config/theme-palette.ts`, `src/config/themes/*.json`, Actor profiles |
| Preview a view in isolation | `previews/` | `scripts/preview-slash.mjs`, `scripts/preview-questions.mjs` |
| Change the dream demo scene | `src/demo.ts` | `src/demo/scene.ts`, `src/demo/portfolio.ts` |

## 3. Common Changes
### Add a statusbar module
1. Add the id to `statusbarIds` and a label to `statusbarLabels` in `src/config/statusbar-preferences.ts`. New ids append disabled to saved layouts; `defaultStatusbar` enables only the first six.
2. Add a `Descriptor` (`icon`, color `token`, `variants`) to `registry` in `status/statusbar.ts`. It is typed `Record<StatusbarId, Descriptor>`, so a missing entry fails typecheck. List `variants` from longest to shortest for narrow widths.
3. If the module needs data not on `StageStatus`, extend `src/runtime/stage-status.ts` and populate it in `src/application-status.ts`.
- Tests: `tests/statusbar-modules.test.ts` (iterates `statusbarIds`), `tests/statusbar-customization.test.tsx`

### Add a slash command
1. Add an entry to `commandCatalog` in `src/commands.ts` (`name`, `usage`, `description`, `argument`). Completion, `/help` and the reserved-name check for custom commands all read this list.
2. Handle it in `src/application.ts`: simple actions are an `if (text === '/name')` branch in the command dispatcher (near `/help`, `/skills`, `/reload`); tabbed pages are added to `src/application-commands.ts:createCommandTabsFor()`.
3. Report through the existing receipt or surface helpers with an explicit `presentation`; never classify text in a renderer.
- Tests: `tests/command-surfaces.test.ts`, `tests/statusbar-customization.test.tsx` (catalog and completion discoverability), `tests/slash-receipts.test.ts`

### Add a tab or page to a command surface
1. Build the `CommandTab` (`id`, `title`, `lines` or `toggles`) in `src/application-commands.ts:createCommandTabsFor()`, and extend `ApplicationCommandContext` for any new data.
2. Persist edits in `saveConfigToggles()` (same file), dispatched by tab id from the `onSaveToggles` callback in `src/application.ts`.
3. `src/commands/surfaces.ts:CommandSurfaces.openPage()` and `panels/tabbed-page.tsx` render it with no changes; a single-tab page hides its tab bar.
- Tests: `tests/settings-interaction.test.tsx`, `tests/tabbed-page-single.test.tsx`, `tests/command-panels.test.tsx`

## 4. Hard Boundaries
- **Only `app.tsx` and `application.tsx` are root source files**: every other module sits in a responsibility directory; `components/` depends only on neutral foundations, and production never imports `previews/`. No global "utils" or "types" catch-all directories. Enforced by `tests/tui-module-layout.test.ts`, which lists every file per directory, so adding or moving a file means editing its `layout` map.
- **Colors come from semantic palette tokens**: no color literals in UI source; theme revision invalidates App memoization, timeline projection and encoded rows. Enforced by `tests/color-literals.test.ts`, `tests/theme-colors.test.ts`.
- **Command pages**: `/animations` is an alias of `/settings`; `/config` is a read-only page with no mutation; drafts update synchronously and a pending save locks same-chunk input; Settings saves keep the page and other drafts open. Enforced by `tests/slash-commands-decoupled.test.ts`, `tests/settings-interaction.test.tsx`, `tests/statusbar-customization.test.tsx`.
- **System feedback**: hosts assign `presentation`; saves flash in the footer, replay never re-toasts or reopens results, results scope to owner and session. Enforced by `tests/system-notices-ui.test.tsx`, `tests/command-result.test.tsx`, `tests/command-receipt-races.test.ts`.
- **Input intent**: normal Enter queues; fullscreen Enter inserts a newline and Ctrl+Enter queues; Ctrl+T steers an exact activity; `app.tsx` is the sole native cursor owner; failed or stale deliveries keep drafts; Queue/Steer never cancels a task. Enforced by `tests/fullscreen-composer.test.tsx`, `tests/fullscreen-editor.test.tsx`, `tests/input-queue-ui.test.tsx`.
- **Composer stays free of leading pointer or placeholder clutter**: Enforced by `tests/composer-clean.test.tsx`.
- **Selection and mouse**: statusbar drag selects only status text and writes OSC52; actor pill double-click locates the latest card. Enforced by `tests/statusbar-selection.test.tsx`, `tests/actor-pills-locator.test.tsx`. Timeline drag taking priority over folding is *Unenforced*.
- **Rail ownership**: Director, Actor, human and system rails use their own identity tokens; collaboration interruptions use `directorIntervention` inside the working card. The token exists in `tests/theme-presets.test.ts`; rail assignment itself is *Unenforced*.
- **Animation safety**: backgrounds and column widths stay static, only fixed-width glyph slots animate, and optional motion never changes task state. The 200 ms pacing for up to eight frames is enforced by `tests/actor-thinking-animation.test.ts`; the 130 ms ten-dot Braille pacing is *Unenforced*.
- **Tool UI is tool-owned**: registered tool UIs own formatting; hidden tools have no visible or selectable surface; rendering never executes a tool. Enforced by `tests/tool-ui.test.ts`.
- **Expandable cards draw no `▮`**: tool groups and the "Task from" card lead with ▸/▾ via `pushOrdinaryCard({expandable: true})`; the whole title row (including the elapsed time) hovers and toggles through `:title_*` selection keys. A group header is `<verb> N <noun>` per category (`timeline/group-row.ts:groupVerb()` picks a stable word per group id from the actor's `activity_verbs` pool, gerund while running, past when done), italic, white (`palette.fg`) while running and muted when finished. A collapsed running group shows each running tool as a `└` row (`timeline/group-row.ts:visibleRunningCalls()`, kept at least 700 ms per tool id); expanded groups show none. A running single-tool `▮` breathes between muted and the role color on the 200 ms frame rhythm. Enforced by `tests/tool-group-render.test.ts`.
- **Only a drawn actor card splits a tool group**: the card draws once at its activity's first message, so later messages of a running actor never break the Director's run (`timeline/stage.ts:buildStageRows`). Enforced by `tests/tool-group-render.test.ts`.
- **Swarm rows**: `src/tools/orchestration/AutomaTool/UI.ts:UI` renders `step.swarm` as an expandable card (`Drone swarm · 4 drones · 3 returned · 12.1s`, same header rules as tool groups). Collapsed, only running jobs show as `└` rows whose frame and clock are drawn by `timeline/row-presentation.ts:decorateRow` from the row animation (keys ending `:swarm_icon` and `:swarm_time`), never by a timer; expanded, each job is a nested card with the fold id `<messageId>-job-<index>` (read through `ToolRenderContext.isOpen`, and part of the message layout cache key in `timeline/stage.ts`) showing its calls and receipt. Jobs still queued or running in an ended step render as `interrupted`; messages without `swarm` use the default card. Enforced by `tests/automa-ui.test.ts`.
- **Card row consistency**: `timeline/scene.ts:pushOrdinaryCard` enforces three rules for every single-line card row (tools, thinking, groups, Task from, Message from, SendMessage). (1) Every ` · ` is its own `palette.muted` segment (`SceneSegment.separator`) and never recolors on hover. (2) The hover/click region runs from the leading icon or ▸/▾ to the last non-blank cell, status, elapsed time, sizes, token counts and fault labels included. (3) Hover recolors muted segments with the surface owner's color, read from `FrameWrap.surfaceColor` (set by `appendActorCard` to the actor's color and by `createBuilder`'s `surfaceColor` argument to the view owner on the timeline), never from the card's `ownerId` or sender; semantic colors (sender names, error red, running white) are kept. An actor card's own header rows (name, title, status, arrow, stop) set `SceneRow.hoverColor` to that actor's color (the rail keeps the surface color), so their row highlight never takes the hosting surface's color. Enforced by `tests/card-row-consistency.test.ts`.
- **No artifact blank rows**: `timeline/scene.ts:pushMarkdown` trims leading and trailing blank lines (and draws nothing for blank text), `pushProse` and `pushOrdinaryCard` drop trailing newlines and trailing empty body lines, and thinking text goes through `compactParagraphs()` (no empty rows at the edges or between paragraphs; stored text is unchanged). Interior blank lines of tool output and Markdown paragraph breaks are content and stay. Enforced by `tests/stage-blank-rows.test.ts`.
- **Login secrets stay local**: never in runtime questions, transcripts or model context; one keyboard owner for runtime questions. Enforced by `tests/login-panel.test.tsx`, `tests/question-panel.test.tsx`, `tests/fullscreen-composer.test.tsx`.

## 5. Dependencies
- **Depends on**: `src/runtime/` (store snapshots, `CommandSurface`, `StageStatus`), `src/config/` (theme palette, statusbar preferences), `src/tools/` (`src/tools/ui-registry.ts` via `timeline/tool-ui.ts`), `src/actors/` (profile identity and animation frames), `src/providers/` (login wizard flows).
- **Used by**: `src/cli.tsx` (mounts the App), `src/application.ts` (`CommandSurfaces`, command tabs, receipts), `src/resources/` (custom command names in completion).

## 6. Verification & Gaps
- Fast run: `node --test dist/tests/tui*.test.js dist/tests/command-*.test.js dist/tests/statusbar-*.test.js dist/tests/settings-interaction.test.js dist/tests/theme-*.test.js dist/tests/color-literals.test.js dist/tests/fullscreen-*.test.js dist/tests/question-*.test.js dist/tests/login-*.test.js dist/tests/stage-*.test.js dist/tests/actor-pills*.test.js`
- Run Ink tests with `NODE_ENV=development`.
- Not covered offline: real-terminal rendering (true color, CJK width, Nerd Font glyphs, mouse SGR, resize); live provider and OAuth flows.
