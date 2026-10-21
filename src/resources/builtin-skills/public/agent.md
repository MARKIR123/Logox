---
name: public-skills-signpost
description: Public shared cross-cutting utility procedures and operational SOPs
categories:
  ops: Headless screenshot capture, browser automation, and cross-cutting tool execution
---

# Public Skill Taxonomy & Evolution Guidelines

## 1. Domain Boundaries
- `ops/`: Cross-cutting operations accessible by all ensemble actors without explicit borrowing, including deterministic headless screenshotting and environment inspections.

## 2. Dynamic Discovery
Public specialized utility SOPs reside in categorized subdirectories. Inspect public domain contents on-demand via `Glob("skills/public/<category>/*.md")` and `Read` the required SOP directly.

## 3. Skill Promotion & Storage
To internalize new cross-cutting operational SOPs:
1. Follow the public SOP `skills/public/skill-internalization.md`.
2. Write public skills to `skills/public/` (for core utilities) or `skills/public/<category>/` (for domain operations) in either `~/.logox-ts/skills/public/` (user global) or `.logox/skills/public/` (project private).
