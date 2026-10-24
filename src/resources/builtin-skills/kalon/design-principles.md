---
name: design-principles
description: Core design philosophy, atomic spacing, typographic hierarchy, and visual restraint
actors: [kalon]
---

# Kalon Design Principles SOP (Core Baseline)

## 1. Context & Purpose
This is Kalon's primary design charter. Whenever designing new user interfaces, reshaping terminal layouts, choosing color tokens, or reviewing visual presentation, apply these principles before selecting specific styling sub-paradigms.

## 2. Core Invariants & Boundaries
- **Negative Space Over Density**: Whitespace is an active design element, not empty wasted space. Avoid crowding text or borders against edge bounds.
- **Typographic Scale & Restraint**: Maintain clear hierarchy (Title -> Section Header -> Body -> Caption). Never use more than 3 distinct font weights or sizes in a single viewport.
- **Color Discipline**: Accent colors must be intentional and purposeful. Never use saturated raw primaries where muted, semantic tokens convey meaning with greater dignity.
- **Intentional Form**: Every visual boundary, border, or separator must serve structure. If removing a line does not degrade readability, remove it.

## 3. Step-by-Step Procedure
1. Define the structural hierarchy and identify primary, secondary, and tertiary zones.
2. Establish the spacing grid (multiples of 4px / terminal character blocks).
3. Select an aesthetic direction (Flat, Minimal, or Material) from `skills/kalon/styling/`.
4. Select semantic and accessible contrast palettes from `skills/kalon/color/`.
5. Verify visual clarity and the relevant interactions through Playwright MCP (`skills/public/browser-screenshot.md`).

## 4. Verification & Done Criteria
- Read produced renders using the multimodal `Read` tool.
- Confirm contrast ratios comply with WCAG AA (minimum 4.5:1 for normal text).
- Ensure no clipping, misaligned text baselines, or runaway margins exist.
