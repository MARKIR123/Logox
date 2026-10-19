# Module: Actors & Ensemble (`src/actors/`)

## 1. Quick Route (核心文件导航)
- `definitions.ts`: Actor identity schemas, YAML frontmatter parser, and color derivation.
- `catalog.ts`: ActorCatalog loader scanning builtin, user, and project-level actor definitions.
- `actor-models-storage.ts`: Thread-safe persistence of actor default models in `~/.logox-ts/actor-models.json`.
- `ensemble.ts`: EnsembleRuntime execution engine, task queue, `StopReason`, `cancelActor()`, and `interruptTask()`.
- `collaboration.ts`: Inter-agent messaging tool `SendMessage` (supporting `mode: "interrupt"` and `to: "all"` broadcast).
- `services.ts`: ActorServices bridging ActorCatalog, Ensemble, permissions, and tools (`ListActors`, `CancelActor`).
- `bulletin.ts`: Project bulletin board (`.logox/bulletin.md`) initialization and experience appending.
- `profiles/*/`: Built-in actor definitions (`logox`, `techne`, `kalon`, `aletheia`).

## 2. Invariants (刚性边界与底线)
- **Single-Writer Rule**: Only one designated actor (typically Techne) writes to a production file during an implementation round. Reviewers (Aletheia, Kalon) produce reports, never competing write handles.
- **Zero Card Fragmentation**: Interventions via `SendMessage({ mode: 'interrupt' })` MUST be injected directly into the active activity context without opening a redundant queued actor card.
- **Persistence Boundary**: Actor model configurations are user-scoped and MUST be persisted to `~/.logox-ts/actor-models.json`, surviving across sessions, projects, and restarts.
- **Strictly English Receipts**: All tool receipts, error messages, and coordination records must be 100% English.

## 3. Entry Points & Key Workflows
- **Dispatch**: Director Logox calls `Actor({ tasks: [...] })` -> `EnsembleRuntime.dispatch()` -> queued in `queue` -> executed by `pump()`.
- **Intervention**: Director Logox calls `SendMessage({ to, message, mode: 'interrupt' })` -> `EnsembleRuntime.interruptTask()` -> cancels blocked tool and injects message into running activity.
- **Cancel**: Director Logox calls `CancelActor({ actor, scope: 'tool' | 'activity', reason })` -> surgical tool kill or round termination.
- **Notice**: On subagent activity completion/failure, Runtime automatically delivers a lightweight Idle Notice to Logox unless cancelled by Director.

## 4. Cross-Reference (关联路标)
- Runtime engine & store: [`../runtime/AGENTS.md`](../runtime/AGENTS.md)
- Available tools & execution: [`../tools/AGENTS.md`](../tools/AGENTS.md)
- TUI card presentation: [`../tui/AGENTS.md`](../tui/AGENTS.md)
- Architectural rationale & design history: [`../../docs/`](../../docs/)
