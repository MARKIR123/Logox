# Module: Actors & Ensemble (`src/actors/`)

## 1. Scope
- **Owns**: Actor definitions (`persona.md`, `config.yaml`, `compression.md`), `ActorCatalog`, `EnsembleRuntime` task queue, `SendMessage` messaging, `CancelActor`, `ListActors`, and `.logox/bulletin.md`.
- **Does not own**: Single-agent LLM loop execution (owned by `src/kernel/agent.ts`), TUI card rendering (owned by `src/tui/`).

## 2. Start Here (Task Router)
| If investigating... | Start at... | Then check... |
|---|---|---|
| Subagent task dispatching or queuing | `ensemble.ts:Ensemble.dispatch()` | `pump()` execution loop and `TaskOrigin` |
| Inter-agent messaging or tool interruption | `collaboration.ts:SendMessage` | `ensemble.ts:injectTaskMessage()` |
| Subagent cancellation or stuck tool termination | `services.ts:executeCancelActor()` | `cancelActor()` in `ensemble.ts` |
| Actor default model persistence across restarts | `actor-models-storage.ts` | `~/.logox-ts/actor-models.json` |
| Actor persona discovery and loading | `catalog.ts:ActorCatalog` | `profiles/*/` and `definitions.ts` |

## 3. Hard Boundaries
- **Single-Writer Safety**: Only one designated actor (typically Techne) writes to a production file during an implementation round. Reviewers (Aletheia, Kalon) produce reports, never competing write handles.
- **Zero Card Fragmentation**: Messages sent via `SendMessage` (both `mode: "interrupt"` and `mode: "queue"`) MUST be injected directly into the active activity context without opening redundant cards.
- **Persistence Boundary**: Actor model configurations are user-scoped and MUST be persisted to `~/.logox-ts/actor-models.json`, surviving across sessions and restarts.
- **Strictly English Interface**: All internal receipts, error diagnostics, and status lines must be 100% English.

## 4. Integration Points
```text
application.ts (binds ActorServices & Ensemble)
  → kernel/agent.ts (runs Director / Subagent loops)
  → actors/collaboration.ts (delivers mid-turn SendMessage & Director feedback)
  → store/journal.ts (persists director.jsonl and subagents/<actor>.jsonl)
```

## 5. Verification
- **Targeted Test Suite**:
  - `tests/ensemble.test.ts`: Ensemble dispatch queue, pump, and lifecycle.
  - `tests/actor-collaboration-enhancements.test.ts`: ListActors, CancelActor, bulletin, SendMessage.
  - `tests/actor-recovery.test.ts`: Remodeling, timeout recovery, and retry budgets.
- **Fast Run Command**:
  ```bash
  node --test dist/tests/actor*.test.js dist/tests/ensemble.test.js
  ```
