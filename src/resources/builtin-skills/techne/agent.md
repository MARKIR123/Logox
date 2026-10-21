---
name: techne-skills-signpost
description: Techne engineering standards, architectural patterns, and execution taxonomy
categories:
  engineering: Strict TDD cycles, defensive coding, and error unwinding
  patterns: Single-writer concurrency isolation and explicit state machine modeling
---

# Techne Skill Taxonomy & Evolution Guidelines

## 1. Domain Boundaries
- `engineering/`: Test-driven development (red-green-refactor), defensive edge handling, boundary unwinding, and resource leak prevention.
- `patterns/`: Architectural constructs, single-writer state isolation, finite state machines, and clean asynchronous lifecycles.

## 2. Dynamic Discovery
Specialized engineering SOPs reside in categorized subdirectories. Inspect domain contents on-demand via `Glob("skills/techne/<category>/*.md")` and `Read` the required SOP directly.

## 3. Skill Promotion & Storage
To internalize new external skills or persist reusable engineering patterns:
1. Follow the public SOP `skills/public/skill-internalization.md`.
2. Write newly internalized skills to the appropriate category directory in either `~/.logox-ts/skills/techne/` (user global) or `.logox/skills/techne/` (project private).
3. If introducing an entirely new category, register it under `categories` in this `agent.md`.
