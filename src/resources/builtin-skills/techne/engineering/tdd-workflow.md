---
name: tdd-workflow
description: Strict red-green-refactor test-driven development cycle and regression pinning SOP
actors: [techne]
---

# TDD Workflow SOP (严格红绿测试驱动开发流)

## 1. Phase 1: Red (Failing Test First)
- Write the minimal test that specifies the expected behavior.
- Run the test suite and watch it fail with the expected error.
- A test that passes before code is written is invalid or tautological.

## 2. Phase 2: Green (Minimal Implementation)
- Write only the code required to make the failing test pass.
- Resist adding speculative features, premature abstractions, or config knobs.
- Run test and watch it turn green.

## 3. Phase 3: Refactor
- Eliminate duplicate logic, tighten interface types, and ensure zero descriptor leaks.
- Re-run full test suite after refactoring.
