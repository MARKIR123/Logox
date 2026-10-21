# Module: Runtime & Continuous Execution (`src/runtime/`)

## 1. Scope
- **Owns**: Continuous execution loop, macro milestone tracking (`UpdateTaskProgress`), step duration timing, immutable `RuntimeStore` snapshots, and dual-write session transcript contracts.
- **Does not own**: UI terminal rendering (owned by `src/tui/`), multi-actor queue coordination (owned by `src/actors/`).

## 2. Start Here (Task Router)
| If investigating... | Start at... | Then check... |
|---|---|---|
| Natural while(true) loop convergence or stop conditions | `kernel/agent.ts` | `max_iterations = 0` and `stopReason` |
| Macro progress milestones and roadmap banner | `task-progress.ts:TaskProgress` | `UpdateTaskProgress` tool calls |
| Step timing, thinking duration, or elapsed clocks | `steps.ts:Steps` | `stepSchema` and `animation.step` |
| Immutable store snapshots or event subscription | `store.ts:RuntimeStore` | `activities.ts` and `messages.ts` |
| Input origin attribution (human, director, subagent) | `provenance.ts` | `taskOriginSchema` in `contracts.ts` |

## 3. Hard Boundaries
- **Continuous Natural Execution**:
  - `max_iterations = 0` (unlimited, while(true) natural convergence).
  - Tasks terminate strictly when the goal is achieved or when cancelled by user/director. No artificial 50-turn blocking popups.
- **Dual-Write Session Transcripts**:
  - Session history maintains a clean dual-write hierarchy under `state/sessions/<sessionId>/`:
    `director.jsonl`, `tasks.json`, `events.json`, `README.md`, `subagents/<actor>.jsonl`.
- **Immutable State Snapshots**:
  - `RuntimeStore` maintains deep-frozen snapshots (`immutable()`). Modifying store arrays in-place is forbidden; state transitions produce new snapshots.

## 4. Integration Points
```text
kernel/agent.ts (runs execution loop)
  → runtime/task-progress.ts (manages milestone states)
  → runtime/steps.ts (tracks step durations)
  → runtime/store.ts (publishes immutable snapshots)
  → store/journal.ts (dual-writes transcripts to disk)
```

## 5. Verification
- **Targeted Test Suite**:
  - `tests/task-progress.test.ts`: Milestone phases, status updates, and progress tools.
  - `tests/runtime-steps.test.ts`: Duration calculation, group timing, and step state.
  - `tests/agent.test.ts`: Agent loop convergence and tool dispatch.
- **Fast Run Command**:
  ```bash
  node --test dist/tests/task-progress.test.js dist/tests/runtime-steps.test.js
  ```
