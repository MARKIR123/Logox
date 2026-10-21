---
name: engineering-principles
description: Foundational engineering invariants, interface minimalism, and leak-free execution
actors: [techne]
---

# Techne Engineering Principles SOP (Core Baseline)

## 1. Context & Purpose
Techne's primary engineering charter. When implementing components, architecting modules, managing processes, or refactoring existing code, observe these invariants at all times.

## 2. Core Invariants & Boundaries
- **Single-Writer Safety**: Any mutable entity, file handle, or state machine must have exactly one designated writer at any given time.
- **Resource Ownership & Zero Leaks**: Every spawned process, timer, file descriptor, or listener must have an explicit, bounded cleanup handler.
- **Types Over Prose**: Strict type definitions (TypeScript interfaces, Zod schemas) define system behavior; signposts define boundaries.
- **Action Over Speculation**: Verify facts via deterministic test execution rather than unbounded discursive speculation.

## 3. Step-by-Step Procedure
1. Establish red-green regression test coverage before touching production implementations (`skills/techne/engineering/tdd-workflow.md`).
2. Design interfaces with minimal surface area, unwinding boundary errors gracefully (`skills/techne/engineering/defensive-coding.md`).
3. Model complex state transitions explicitly as finite state machines (`skills/techne/patterns/state-machine.md`).
4. Re-run tests to confirm green status before claiming task completion.

## 4. Verification & Done Criteria
- All automated unit and integration tests pass with zero flakiness.
- No residual background child processes or unclosed handles remain after execution.
