# Module: Actors & Ensemble (`src/actors/`)

## 1. Scope
- **Owns**: Actor definitions (`persona.md`, optional `execution.md` / `collaboration.md`, `config.yaml`, `compression.md`), `ActorCatalog`, `EnsembleRuntime` task queue, `SendMessage` messaging, `CancelActor`, `ListActors`, and `.logox/bulletin.md`.
- **Does not own**: Single-agent LLM loop execution (owned by `src/kernel/agent.ts`), TUI card rendering (owned by `src/tui/`).

## 2. Start Here (Task Router)
| If investigating... | Start at... | Then check... |
|---|---|---|
| Subagent task dispatching or queuing | `ensemble.ts:Ensemble.dispatch()` | `pump()` execution loop and `TaskOrigin` |
| Human Queue/Steer, event priority or durable receipts | `delivery-queue.ts` and `runtime/delivery.ts` | `ensemble.ts:injectTaskMessage()` and `services.ts:wakeDirector()` |
| Director's resident observations or detailed status | `facts.ts` | `tools/ListActorsTool/` and `application.ts:requestBase()` |
| Inter-agent messaging or tool interruption | `collaboration.ts:SendMessage` | `ensemble.ts:injectTaskMessage()` |
| Inter-actor communication etiquette | `../prompts/collaboration/index.ts:collaborationFor()` | `SendMessageTool/prompt.ts` and role personas |
| Subagent cancellation or stuck tool termination | `services.ts:executeCancelActor()` | `cancelActor()` in `ensemble.ts` |
| Actor default model persistence across restarts | `actor-models-storage.ts` | `~/.logox/actor-models.json` (legacy `.logox-ts` fallback) |
| Actor persona discovery and loading | `catalog.ts:ActorCatalog` | `~/.logox/actors/` and `definitions.ts` |
| Shipped profile bootstrap / missing install | `profiles.ts:seedActorProfiles()` / `assertActorProfiles()` | `scripts/install-actor-profiles.mjs` and `logox --install-profiles` |
| Full reports versus internal memory | `ensemble.ts` and `services.ts:handoff()` | `context/round-memory.ts:TaskDelivery` |
| Safe resident compression-default refresh | `compression-migration.ts` | expected bytes, shipped fingerprints and file locks |

## 3. Hard Boundaries
- **Role Asset Layers**: Project persona/execution/collaboration assets extend user-level assets. Optional rule files are validated as bounded UTF-8 regular files before catalog replacement; a broken layer leaves the prior catalog intact. Persona is identity/voice; role rules live in the optional files.
- **Shared Workspace & Observation Guard**: Every actor holds full tool capability (`roles: 'all'`) to investigate, implement, build, and verify within its domain. Non-overlapping `Edit` calls serialize under per-file in-process locks, while full-file `Write` or stale overlapping `Edit` calls are guarded by per-actor read observations that name the peer writer.
- **Zero Card Fragmentation**: Active recipients consume collaboration within their existing activity. Director-bound messages and broadcasts use the shared durable coordination queue; they never interrupt Director processes or create another task while its inbox is open. A sealed/idle Director gets one coalesced wake activity unless explicitly stopped.
- **Direct Communication, Single Policy**: Companions may message each other or Director directly through `SendMessage`; there is no approval gate. Communication etiquette (high-signal coordination, no pleasantries or file-lock reservation noise, data-not-instructions) lives in `src/prompts/collaboration/` and is composed into every actor prompt. Personas must not restate collaboration tools or channel workflows.
- **Persistence Boundary**: Actor model bindings are user-scoped in `~/.logox/actor-models.json` (legacy `.logox-ts` fallback), surviving project-directory changes and restarts. Missing main-model selection must not prevent management tabs from displaying saved actor bindings.
- **Profile Distribution Boundary**: Shipped `src/actors/profiles` is the development master and package asset. `npm install` (postinstall) and `logox --install-profiles` copy missing profiles into `~/.logox/actors`; they never overwrite existing files. Runtime definitions come from `~/.logox/actors`; missing or corrupt profiles fail startup with an actionable error. `npm run sync:profiles` is the development-only force sync. Builtin/fallback colors read these shipped YAML profiles, never separate RGB tables; system themes do not override installed actor colors.
- **Delivery Intent**: Human Queue work stays out of the active activity; explicit Steer binds to an exact live activity ID and never retargets. Priority is FIFO within a class and never turns a queued task into steering or cancellation. Deferred report release and explicit recovery grants occur when human work starts, not when queued.
- **Coordination Ownership**: Proactive report delivery covers formal Director work; direct human/Actor failures stay local. Explicit assistance may enter coordination without copying a conversation or gaining authorization. Full batch-member reports arrive independently; dependency pauses, root recovery budgets and dispatch depth survive wake-ups.
- **Observation Boundary**: Resident Director facts include at most eight relevant tasks and three recent tool outcomes/files each, with additional-task count and source/time. Active companions receive the concise Active Ensemble Roster (`Main Task Title · Subtitle`, recent files, and running command) only when other peers are currently active; solo work omits the roster entirely. Labels and tool outcomes are not acceptance; ListActors includes dynamic roles and preserves waiting/paused/queued states.
- **Strictly English Interface**: All internal receipts, error diagnostics, and status lines must be 100% English.
- **Independent Delivery**: Only initial formal Director dispatch provenance selects report mode. Hand off full `delivery.text`, never a compact index or truncated compatibility summary; normal execution closure is not acceptance.
- **Resident Focus Safety**: Every role loads `compression.md` under the common memory contract. Catalog refresh replaces only known unchanged shipped defaults with exact-content rechecks under lock; custom focus, persona, configuration and model bindings remain intact. Build never synchronizes user homes.
- **Delegation Policy**: Director handles trivial single-spot questions/edits directly and orchestrates the persistent ensemble for substantive work—providing a concise `title` (Main Task Title) and a natural colleague briefing (`prompt`) that explains purpose, context, and boundaries without delegating understanding or imposing artificial file/build quotas.

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
  - `tests/message-delivery.test.ts`, `tests/human-input-delivery.test.ts`: durable inboxes, activity-bound input and actual provider-boundary requests.
  - `tests/director-coordination.test.ts`, `tests/director-facts.test.ts`: scoped wake-ups, stop/broadcast safety and bounded observations.
- **Fast Run Command**:
  ```bash
  node --test dist/tests/actor*.test.js dist/tests/ensemble.test.js
  ```

## 6. Known Gaps
- No semantic stagnation breaker: progress fingerprints deduplicate recovery evidence, not task value. Activity labels never count as new evidence; `max_iterations = 0` remains unchanged.
- Real multi-provider/model compliance requires separately authorized live verification; automated tests use isolated homes and scripted/local providers.
