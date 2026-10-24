# Module: Runtime & Continuous Execution (`src/runtime/`)

## 1. Scope
- **Owns**: Continuous execution loop, optional activity labels (`UpdateTaskProgress`), step duration timing, immutable `RuntimeStore` snapshots, and dual-write session transcript contracts.
- **Does not own**: UI terminal rendering (owned by `src/tui/`), multi-actor queue coordination (owned by `src/actors/`).

## 2. Start Here (Task Router)
| If investigating... | Start at... | Then check... |
|---|---|---|
| Natural while(true) loop convergence or stop conditions | `kernel/agent.ts` | `max_iterations = 0` and `stopReason` |
| Optional current-activity labels and legacy progress snapshots | `task-progress.ts:TaskProgress` | `contracts.ts:currentTaskProgress()` and `UpdateTaskProgress` |
| Step timing, thinking duration, or elapsed clocks | `steps.ts:Steps` | `stepSchema` and `animation.step` |
| Immutable store snapshots or event subscription | `store.ts:RuntimeStore` | `activities.ts` and `messages.ts` |
| Input origin attribution (human, director, subagent) | `provenance.ts` | `taskOriginSchema` in `contracts.ts` |
| Queue versus Steer or durable notification metadata | `delivery.ts` | `actors/delivery-queue.ts` and Journal receipt metadata |

## 3. Hard Boundaries
- **Continuous Natural Execution**:
  - `max_iterations = 0` (unlimited, while(true) natural convergence).
  - Tasks terminate strictly when the goal is achieved or when cancelled by user/director. No artificial 50-turn blocking popups.
- **Dual-Write Session Transcripts**:
  - Session history maintains a clean dual-write hierarchy under `state/sessions/<sessionId>/`:
    `director.jsonl`, `tasks.json`, `events.json`, `README.md`, `subagents/<actor>.jsonl`.
- **Round Closure**: Normal completion delivers text and terminal `_FinishRound` metadata. Successful receipts require no further model request; mixed terminal/business batches execute no side effects. A single metadata-only correction preserves prior text and completed effects; cancellation and failures retain their real outcome.
- **Activity Visibility**: `UpdateTaskProgress` optionally replaces `{label, detail?}` for the current activity. It does not manage plans, terminal status, acceptance or recovery progress. Legacy milestones stay readable; new steps do not inherit stage metadata. New turns start empty; only explicit resume inherits a label.
- **Boundary Messages**: Admission is durable before acknowledgment; model history is appended only at consumption. Human steering retains human provenance, while Actor packets remain data. Await pending admission at closure and recheck before provider requests/retries. Delivery receipts are not task acceptance; restart does not replay tools or retarget bound input.
- **Immutable State Snapshots**:
  - `RuntimeStore` maintains deep-frozen snapshots (`immutable()`). Modifying store arrays in-place is forbidden; state transitions produce new snapshots.

## 4. Integration Points
```text
kernel/agent.ts (runs execution loop)
  → runtime/task-progress.ts (manages optional activity labels)
  → runtime/steps.ts (tracks step durations)
  → runtime/store.ts (publishes immutable snapshots)
  → store/journal.ts (dual-writes transcripts to disk)
```

## 5. Verification
- **Targeted Test Suite**:
  - `tests/task-progress.test.ts`: Activity labels, legacy compatibility, explicit resume and cancellation races.
  - `tests/runtime-steps.test.ts`: Duration calculation, group timing, and step state.
  - `tests/agent.test.ts`: Agent loop convergence and tool dispatch.
- **Fast Run Command**:
  ```bash
  node --test dist/tests/task-progress.test.js dist/tests/progress-lifecycle.test.js dist/tests/runtime-steps.test.js dist/tests/finish-round.test.js
  ```

## 6. Known Gaps
- Scripted tests exercise closure races and recovery; real model compliance with the finalizer contract still requires authorized live checks.
