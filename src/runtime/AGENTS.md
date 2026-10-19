# Module: Runtime & Continuous Execution (`src/runtime/`)

## 1. Quick Route (核心文件导航)
- `contracts.ts`: Core data schemas (`activitySchema`, `stepSchema`, `interactionInputSchema`, `taskOriginSchema`).
- `store.ts`: `RuntimeStore` managing immutable snapshots of activities, interactions, and messages.
- `activities.ts`: Activity status updates and lifecycle transitions.
- `messages.ts`: Model message contracts (`user`, `assistant`, `tool`), tool calls, and message normalization.
- `provenance.ts`: Input provenance attribution (`human`, `director`, `actor`, `collaboration`, `collaboration_interrupt`).
- `task-progress.ts`: Macro progress milestone tracking (`UpdateTaskProgress` tool implementation).
- `steps.ts`: Step timing and elapsed duration calculations.

## 2. Invariants (刚性边界与底线)
- **Continuous Natural Execution**:
  - `max_iterations = 0` (unlimited, while(true) natural convergence).
  - Tasks terminate strictly when the goal is achieved, when stop conditions are met, or when cancelled by user/director. No artificial 50-turn blocking popups.
- **Dual-Write Session Transcripts**:
  - Session history maintains a clean dual-write hierarchy under `state/sessions/<sessionId>/`:
    - `director.jsonl`: Director conversation log.
    - `tasks.json`: Subagent tasks and status ledger.
    - `events.json`: System notices and environment updates.
    - `README.md`: Session index overview.
    - `subagents/<actor>.jsonl`: Individual subagent execution logs.
- **Immutable State Snapshots**:
  - RuntimeStore maintains deep-frozen snapshots (`immutable()`). Modifying store arrays in-place is forbidden; transitions produce incremented revisions.

## 3. Cross-Reference (关联路标)
- Actor dispatch & collaboration: [`../actors/AGENTS.md`](../actors/AGENTS.md)
- Provider streaming & response parsing: [`../providers/AGENTS.md`](../providers/AGENTS.md)
- Architectural rationale & design history: [`../../docs/`](../../docs/)
