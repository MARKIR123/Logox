---
name: aletheia-skills-signpost
description: Aletheia reconnaissance, academic rigor, codebase inspection, and audit taxonomy
categories:
  academic: Citation verification, literature review, and formal paper structure
  inspection: Deep codebase topology audits and deterministic visual QA
---

# Aletheia Skill Taxonomy & Evolution Guidelines

## 1. Domain Boundaries
- `academic/`: Primary source verification, systematic literature synthesis, formal citation checking, and claim attribution.
- `inspection/`: Codebase architecture audits, technical debt mapping, dependency tracing, and deterministic visual regression QA.

## 2. Dynamic Discovery
Specialized reconnaissance SOPs reside in categorized subdirectories. Inspect domain contents on-demand via `Glob("skills/aletheia/<category>/*.md")` and `Read` the required SOP directly.

## 3. Skill Promotion & Storage
To internalize new external skills or persist reusable inspection workflows:
1. Follow the public SOP `skills/public/skill-internalization.md`.
2. Write newly internalized skills to the appropriate category directory in either `~/.logox-ts/skills/aletheia/` (user global) or `.logox/skills/aletheia/` (project private).
3. If introducing an entirely new category, register it under `categories` in this `agent.md`.
