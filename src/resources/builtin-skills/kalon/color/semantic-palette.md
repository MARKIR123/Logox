---
name: semantic-palette
description: Accessible UI contrast (WCAG AA/AAA), semantic role tokens & dark mode color systems
actors: [kalon]
---

# Semantic Palette System SOP (语义化 UI 调色与无障碍对比度)

## 1. Functional Color Roles
Define colors by function, not by hue:
- **Surface**: Base backgrounds, card surfaces, modal elevations.
- **On-Surface**: Primary text, muted text, disabled text.
- **Primary / Accent**: Active selection, focal interactive elements.
- **Success**: Confirmed states, green passes.
- **Warning**: Cautionary indicators, rate-limiting warnings.
- **Error / Danger**: Failures, rejected permissions, fatal aborts.

## 2. WCAG Contrast Checkpoints
- **Normal text (< 18pt)**: Minimum 4.5:1 contrast ratio against surface.
- **Large text (>= 18pt or bold >= 14pt)**: Minimum 3.0:1 contrast ratio.
- **Interactive UI components & borders**: Minimum 3.0:1 contrast ratio.
- Check ratios programmatically in scratchpad via relative luminance calculation before finalizing.

## 3. Dark Mode Tonal Stacking
- Dark themes use surface elevation (lighter gray as layer rises), never drop shadows alone.
- Base: 0dp (`#121212`), Card: 1dp (`#1e1e1e`), Dialog/Modal: 4dp (`#2d2d2d`).
