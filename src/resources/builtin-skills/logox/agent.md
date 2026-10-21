---
name: logox-skills-signpost
description: Director Logox orchestration, decomposition, and multi-agent coordination taxonomy
categories:
  workflows: End-to-end feature delivery, root-cause bug resolution, and architectural refactoring
---

# Director Logox Skill Taxonomy & Evolution Guidelines

## 1. Domain Boundaries
- `workflows/`: Orchestration protocols for feature assembly, root-cause diagnosis, safe codebase refactoring, and multi-source research.

## 2. Dynamic Discovery
Specialized workflow SOPs reside in categorized subdirectories. Inspect workflow contents on-demand via `Glob("skills/logox/<category>/*.md")` and `Read` the required SOP directly.

## 3. Skill Promotion & Storage
To internalize new external skills or persist reusable coordination workflows:
1. Follow the public SOP `skills/public/skill-internalization.md`.
2. Write newly internalized skills to the appropriate category directory in either `~/.logox-ts/skills/logox/` (user global) or `.logox/skills/logox/` (project private).
3. If introducing an entirely new category, register it under `categories` in this `agent.md`.
