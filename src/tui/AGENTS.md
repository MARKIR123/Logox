# Module: Terminal UI (TUI) & Animation (`src/tui/`)

## 1. Scope
- **Owns**: React/Ink terminal interface, `TerminalPlane` differential rendering, 80ms animation tick loop, discrete glyph frame pacing, active actor breathing wave, semantic message projection (`buildStageRows`), and full-screen tabbed surfaces.
- **Does not own**: Runtime store state (owned by `src/runtime/`), tool execution (owned by `src/tools/`).

## 2. Start Here (Task Router)
| If investigating... | Start at... | Then check... |
|---|---|---|
| Screen flickering, ConPTY buffer repainting, or terminal stutter | `terminal-plane.ts` | `row-presentation.ts:decorateRow()` |
| Discrete glyph frames or thinking animation loops | `row-presentation.ts:stepIcon()` | Actor `config.yaml:thinkingAnimation` |
| Card folding, mouse hover, or message row generation | `stage.ts:buildStageRows()` | `scene.ts:createBuilder()` |
| Color themes, actor palettes, or statusbar styles | `cards.tsx:palette` | `themeSchema` in `src/config/config.ts` |
| Full-screen tabbed modal pages (`/status`, `/config`, etc.) | `tabbed-page.tsx` | `application.ts:pageTabs()` |
| Tool-specific cards or question interaction | `tools/ui-registry.ts` | Each tool's `UI.ts`; shared `tool-ui.ts` |

## 3. Hard Boundaries
- **Static Card Surfaces**: Card background colors and column widths MUST remain strictly static during animation. `decorateRow()` mutates only 1-column animated glyphs and text luster colors without mutating full-card background TrueColor or triggering ConPTY repaints.
- **Inline Intervention Anti-Fragmentation**: Injected messages (`inputKind: "collaboration_interrupt"`) must render inline inside the active working card with Director accent, never opening separate queued cards.

- **Tool-Owned UI**: Shared hosts delegate tool formatting and question draft/actions to registered tool adapters. Hidden tools are filtered before grouping, selection, folds and fallback rendering, including restored errors. Rendering never reopens an interaction or executes a tool.
- **Current Animation Behavior**:
- **Frame Pacing Defaults**: Discrete glyph frames advance at **200ms** (for sequences <= 8 frames) or **130ms** (for 10-dot Braille).
- **Luster Wave Interpolation**: Continuous title luster waves interpolate every 80ms tick with dual-harmonic sinusoidal easing: a slow respiratory envelope (`Math.sin(now / 650)`) combined with a gentle spatial phase (`Math.sin(column * 0.35 - now / 450)`).
- **Active Actor Animation Reuse**: Running subagent cards animate through the actor's custom `thinkingAnimation` frames while collapsed, confirming background activity without expanding the card.

## 4. Integration Points
```text
runtime/store.ts (emits state snapshot)
  → tui/stage.ts (projects semantic message rows)
  → tui/scene.ts (builds cards, caps, and borders)
  → tui/row-presentation.ts (decorates animations & colors)
  → tui/terminal-plane.ts (writes differential buffers to ConPTY)
```

## 5. Verification
- **Targeted Test Suite**:
  - `tests/thinking-groups.test.ts`: Animation step stability and static card background.
  - `tests/stage-reading.test.ts`: Stage rows projection and reading anchors.
  - `tests/tui-stream.test.tsx`: Streaming markdown rendering and layout stability.
- **Fast Run Command**:
  ```bash
  node --test dist/tests/tui*.test.js dist/tests/terminal*.test.js dist/tests/stage*.test.js dist/tests/thinking-groups.test.js dist/tests/tool-ui.test.js
  ```

## 6. Known Gaps
- Automated row/Ink tests do not substitute for real terminal or live-model visual acceptance.
