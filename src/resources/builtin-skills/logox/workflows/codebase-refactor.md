---
name: codebase-refactor
description: Architecture decoupling, dependency topology mapping & safe refactoring SOP
actors: [logox]
---

# Codebase Refactor SOP (安全重构与架构解耦流)

## 1. Topology Mapping
- Aletheia inspects all inbound and outbound call sites across the target module using `Grep` and `Glob`.
- Map public exported signatures and existing unit test coverage.

## 2. Refactoring Boundary Formulation
- Identify interface seams: extract pure functions, decouple network or filesystem dependencies, and apply single-writer / state-machine patterns.
- Keep file sizes focused (< 400 lines per file). Split by responsibility, not technical layer.

## 3. Execution & Verification (Techne)
- Execute changes task-by-task.
- Run typecheck and test suite after every file modification to catch breaks immediately.
- Preserve backward-compatible aliases if public APIs are consumed externally.
