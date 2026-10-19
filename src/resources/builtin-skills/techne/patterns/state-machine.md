---
name: state-machine
description: Explicit finite state machine modeling, legal transition matrices & lifecycle constraints
actors: [techne]
---

# State Machine Pattern SOP (显式状态机与阶段流转模式)

## 1. Explicit State Enums
- Never model complex lifecycles with loose boolean flags (`isLoading`, `isFailed`, `isDone`).
- Define explicit discriminated state unions:
  `type State = 'idle' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';`

## 2. Transition Guard Matrices
- State transitions must be validated against a legal transition table.
- Terminal states (`completed`, `failed`, `cancelled`) are permanent sinks; transitions out of terminal states are strictly rejected.

## 3. Atomic State Publication
- State transitions update in a single immutable assignment, notifying subscribers once.
