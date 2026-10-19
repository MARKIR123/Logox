# Module: Terminal UI (TUI) & Animation (`src/tui/`)

## 1. Quick Route (核心文件导航)
- `terminal-plane.ts`: TerminalPlane hardware render plane, 80ms animation loop clock, `armAnimation()`.
- `row-presentation.ts`: `decorateRow()`, `stepIcon()`, `thinkingDuration()`, 180-200ms glyph frame pacing, dual-harmonic breathing luster wave.
- `scene.ts`: RowBuilder, `createBuilder()`, `appendActorCard()`, card caps (`▄`/`▀`), hover tracking, and frame wrappers.
- `stage.ts`: Semantic message projection (`buildStageRows`), inline intervention prose rendering, and actor card folding.
- `cards.tsx`: Theme palettes (`applyTheme`), actor surface colors (`ownerSurface`), and choice styling.
- `app.tsx`: Top-level React/Ink component, window focus routing, mouse gestures, and slash command surface modals.
- `tabbed-page.tsx`: Full-screen tabbed interface (`/status`, `/providers`, `/config`, `/usage`, `/permissions`).

## 2. Invariants (刚性边界与底线)
- **Breathing Rhythm Frame Pacing (插帧缓动)**:
  - Discrete glyph frames in `stepIcon()` advance at **200ms** (for sequences <= 8 frames) or **130ms** (for 10-dot Braille), creating an organic, deliberate rhythm without frantic strobe flicker.
  - Continuous title luster waves interpolate every 80ms tick with dual-harmonic sinusoidal easing: a 4.1s slow respiratory envelope (`Math.sin(now / 650)`) combined with a gentle traveling spatial phase (`Math.sin(column * 0.35 - now / 450)`).
- **Active Actor Animation Reuse**:
  - When a subagent is running (`active: true`), its actor card header visibly breathes with the actor's theme color luster wave.
  - While collapsed (`open: false`), the card symbol animates through the actor's custom `thinkingAnimation` frames, giving the user immediate visual confirmation that the subagent is working.
- **Inline Intervention Anti-Fragmentation**:
  - Injected messages (`inputKind: 'collaboration_interrupt'`) are rendered inline inside the active working card with Director accent `#d97757`, never fragmenting into separate queued cards.
- **Static Card Surfaces & Layout Stability**:
  - Card background and layout widths must remain strictly static during animation. `decorateRow()` mutates only colors and fixed-width slots without causing layout shifts or background repainting.

## 3. Cross-Reference (关联路标)
- Actor coordination: [`../actors/AGENTS.md`](../actors/AGENTS.md)
- Runtime activity state: [`../runtime/AGENTS.md`](../runtime/AGENTS.md)
- Architectural rationale & design history: [`../../docs/`](../../docs/)
