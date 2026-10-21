---
name: kalon-skills-signpost
description: Kalon aesthetic, visual styling, and narrative skill taxonomy
categories:
  styling: Visual UI design languages, elevation hierarchy, and motion physics
  color: Specialized palettes, theme tokens, and accessible contrast standards
  literature: Narrative storytelling, tone consistency, and copy polish
---

# Kalon Skill Taxonomy & Evolution Guidelines

## 1. Domain Boundaries
- `styling/`: UI design systems, styling paradigms (flat design, Material design, minimalism), elevation hierarchy, and visual transitions.
- `color/`: Harmonic palettes, semantic token systems, Morandi hues, dark mode contrasts, and WCAG accessibility standards.
- `literature/`: Narrative voice, copywriting rhythm, technical documentation polishing, and conversational warmth.

## 2. Dynamic Discovery
Specialized domain SOPs reside in categorized subdirectories. Inspect domain contents on-demand via `Glob("skills/kalon/<category>/*.md")` and `Read` the required SOP directly.

## 3. Skill Promotion & Storage
To internalize new external skills or persist reusable design recipes:
1. Follow the public SOP `skills/public/skill-internalization.md`.
2. Write newly internalized skills to the appropriate category directory in either `~/.logox-ts/skills/kalon/` (user global) or `.logox/skills/kalon/` (project private).
3. If introducing an entirely new category, register it under `categories` in this `agent.md`.
