# Module: Runtime, Kernel & Session Store (`src/runtime/`, `src/kernel/`, `src/store/`)

## 1. Scope
- **Owns**: Immutable `RuntimeStore` snapshots and their Zod contracts (`contracts.ts`), activity labels (`task-progress.ts`), step clocks (`steps.ts`), input provenance and delivery schemas (`provenance.ts`, `delivery.ts`), host context messages (`context-updates.ts`), system event schemas (`system-events.ts`); the `src/kernel/` agent loop, execution recovery and scratchpad paths; the `src/store/` session persistence (journal, sessions, file locks, atomic replace). `kernel/` and `store/` have no signposts of their own and inherit this one.
- **Does not own**: Terminal rendering ([`src/tui/AGENTS.md`](../tui/AGENTS.md)); actor queues, delivery admission and dispatch ([`src/actors/AGENTS.md`](../actors/AGENTS.md)); context projection and compaction ([`src/context/AGENTS.md`](../context/AGENTS.md)); permission decisions ([`src/permissions/AGENTS.md`](../permissions/AGENTS.md)).
- **Design rationale**: [docs/modules/system-history.md](../../docs/modules/system-history.md) (system events, presentation, environment changes).

## 2. Start Here
| If you need to... | Start at | Then check |
|---|---|---|
| Follow one model round trip, stop conditions or `_FinishRound` closure | `src/kernel/agent.ts:createAgent()` | `src/kernel/execution-recovery.ts:ExecutionRecoveryError`, `src/tools/protocol/_FinishRoundTool/_FinishRoundTool.ts` |
| Change activity labels (`UpdateTaskProgress`) | `task-progress.ts:TaskProgress` | `contracts.ts:activityProgressSchema`, `contracts.ts:currentTaskProgress()` |
| Fix step timing, Thinking groups or tool clocks | `steps.ts:Steps` | `contracts.ts:stepSchema`, `steps.ts:stepElapsed()` |
| Change what a snapshot contains | `contracts.ts:RuntimeSnapshot` | `store.ts:RuntimeStore`, `contracts.ts:immutable()`, `activities.ts:Activities` |
| Change who an input came from | `provenance.ts:inputKind()` | `contracts.ts:taskOriginSchema`, `provenance.ts:inputMessage()` |
| Queue vs steer, durable delivery metadata | `delivery.ts:deliverySchema` | `src/actors/delivery-queue.ts:DeliveryQueue`, `src/store/journal.ts:Journal.saveDeliveries()` |
| Environment or capability deltas for the model | `context-updates.ts:runtimeContextMessageSchema` | `src/kernel/agent.ts` (`appendUpdate`), `src/context/continuity.ts` |
| Notices, errors, panels outside the model ledger | `system-events.ts:systemEventSchema` | `src/store/system-history.ts:SystemHistory.emit()`, `src/application.ts` (`notice()`, `receipt()`) |
| Session files, transcripts, task checkpoints | `src/store/journal.ts:Journal` | `Journal.checkpoint()`, `Journal.append()`, `Journal.appendSystem()` |
| Session list, resume, leases, delete | `src/store/sessions.ts:SessionManager` | `src/store/session-trash.ts:SessionTrash` |
| Cross-process lock or atomic write | `src/store/file-lock.ts:withFileLock()` | `src/store/replace-file.ts:replaceFile()` |
| Scratchpad directory or 32 KB output offload | `src/kernel/scratchpad.ts:getScratchpadDir()` | `src/kernel/scratchpad.ts:maybePersistLargeOutput()` |

## 3. Common Changes
### Add a system event kind or presentation
1. Add the value to `system-events.ts:systemEventSchema` (`kind`) or `systemPresentationSchema`. `Message.systemEventKind` and `systemPresentation` in `contracts.ts` derive from these types.
2. Emit it through `src/store/system-history.ts:SystemHistory.emit()` (its `kind` parameter is typed from the schema), usually via `notice()` or `receipt()` in `src/application.ts`.
3. A new presentation needs a consumer: `src/tui/app.tsx` handles `status` and `welcome`; `isTimelineMessage()` and `src/tui/timeline/stage.ts` decide timeline visibility. Absent metadata must keep legacy rendering.
- Tests: `tests/system-history-presentation.test.ts`, `tests/system-history.test.ts`.

### Add a host context message kind
1. Add the kind to `context-updates.ts:runtimeContextMessageSchema`; add a `superRefine` check if it carries required `data`.
2. Create it only with `createRuntimeContextMessage()` and append it through `appendUpdate` in `src/kernel/agent.ts`. Non-environment kinds must carry `data.activityId` (and a `slot`) to survive restore.
3. Decide restore behavior in `src/context/continuity.ts` (kinds other than `environment-*` and `capability-change` are kept only for the current activity, keyed by `slot`), then check budget in `src/context/budget.ts` and the encoders in `src/providers/http.ts` and `src/providers/disclosure/`.
- Tests: `tests/runtime-context-updates.test.ts`, `tests/tool-disclosure-context.test.ts`.

### Add a delivery kind
1. Add the value to `delivery.ts:deliveryKindSchema` and an entry to `deliveryPriority` (a `Record<DeliveryKind, number>`, so typecheck fails until you do).
2. Route it in `src/actors/delivery-queue.ts:DeliveryQueue` (only `human_steer` is grouped alone; all other kinds are coordination).
3. Producers: `src/actors/ensemble.ts` and `src/actors/services.ts`; persistence is automatic through `Journal.saveDeliveries()` (parsed with `deliverySchema`).
- Tests: `tests/message-delivery.test.ts`, `tests/human-input-delivery.test.ts`.

## 4. Hard Boundaries
- **Host context is typed, hidden and never authorization**: `role: 'context'` messages are persisted before request preparation and rendered as application context, never as a human request. Enforced by `tests/runtime-context-updates.test.ts`.
- **A waiting Director cannot poll**: while companions run, a Read, Glob or Grep repeating an earlier identical call and result gets a note, and the third repeat in a run leaves only `_FinishRound` on the next request (`src/kernel/tool-pacing.ts:ToolPacing`); new input restores the tools. An empty reply then ends the round instead of triggering `no_delivery` recovery. Enforced by `tests/tool-pacing.test.ts`.
- **`SendMessage` type `ask` keeps a task open, never blocks work**: the call returns at once. An actor closing its round is first told to answer what it owes (twice at most, `ASK_CLOSE_REMINDERS` in `src/kernel/agent.ts`), then parks with no model requests (`src/kernel/peer-wait.ts:PeerWait`) until a `reply` or other message arrives. There is no time limit while the recipient runs. When the recipient's run ends, however it ended, the asker is told to stop waiting (`src/runtime/asks.ts:AskBoard`). Actors parked in a cycle are detected and one is released so it can answer. The Director asks but never parks. Enforced by `tests/send-message-ask.test.ts`.
- **The ensemble snapshot holds only the current state**: a `snapshot` context message goes last on one request and is never stored. The exception is the Anthropic protocol (`src/providers/capabilities.ts`, `appendOnlyHistory`), where the API binds replayed thinking to every earlier message, so deleting one is a history edit: there it is appended as a normal record, only when it changed. Enforced by `tests/director-facts.test.ts`.
- **A polling companion loses its tools, not its task**: past three repeats it parks until a teammate finishes or a message arrives. Enforced by `tests/send-message-ask.test.ts`.
- **One Automa reminder per run**: six consecutive read-only results append a single note when `Automa` is offered, never while the Director is waiting. Enforced by `tests/tool-pacing.test.ts`.
- **Round closure through `_FinishRound`**: successful receipts need no further request; mixed terminal/business batches execute no side effects; one metadata-only correction preserves prior text; cancellation and failure keep their real outcome. Enforced by `tests/finish-round.test.ts`.
- **A deliberate stop is told to the model, once, by name**: when the stop reason is `user` (Esc) or `director_cancel` (CancelActor), cut-off tool results use `prompts/runtime/interruption.ts:USER_INTERRUPTED_TOOL_TEXT` / `DIRECTOR_INTERRUPTED_TOOL_TEXT` and the run's ledger gets one hidden `interruption` context message (`actors/ensemble.ts:stopNotice()`, appended before the round closes; never a timeline row); the round title becomes `Interrupted by user` / `Stopped by Director` (`context/contracts.ts:deliberateStopLabel()`). `shutdown` and restart recovery (`runtime/messages.ts` texts) keep the generic wording and add no marker. Enforced by `tests/user-interrupt.test.ts`.
- **Activity labels are optional and not status**: `UpdateTaskProgress` replaces only `{label, detail?}`; new turns start empty and only explicit resume inherits a label; legacy milestones stay readable and are never rewritten. Enforced by `tests/task-progress.test.ts`, `tests/progress-lifecycle.test.ts`.
- **Admission is durable before acknowledgment; history is appended only at consumption**: human steering keeps human provenance, actor packets stay data, stale targets are rejected, restart does not replay. Enforced by `tests/message-delivery.test.ts`, `tests/human-input-delivery.test.ts`.
- **System event metadata is optional and strict**: presentation is separate from kind and model input; only explicit non-timeline routes are hidden; restore marks replay without rewriting raw events. Enforced by `tests/system-history-presentation.test.ts`.
- **Raw journals are append-only and system events never enter model history**: Enforced by `tests/system-history.test.ts`.
- **Snapshots are deep-frozen; transitions produce new objects**: partially enforced by `tests/task-progress.test.ts` (frozen progress snapshot); store-wide freezing is *Unenforced*.
- **Step clocks exclude queue and nested waiting time**: Enforced by `tests/runtime-steps.test.ts`.
- **`max_iterations = 0` means no iteration cap**: the loop asks to continue only when `options.iterations > 0`. *Unenforced* (tests pass explicit caps).
- **Session tree layout** `state/sessions/<sessionId>/` with `director.jsonl`, `tasks.json`, `events.json`, `deliveries.json`, `README.md`, `subagents/<actor>.jsonl`: written by `Journal`. *Unenforced*; only the `events.json` mirror is asserted in `tests/system-history-presentation.test.ts`.

## 5. Dependencies
- **Depends on**: `src/tools/` (`UpdateTaskProgressTool` schema, `_FinishRoundTool`, `src/tools/ui-format.ts` titles), `src/actors/` (`ActorContext` type), `src/context/` (round memory during `Journal.finish()`), `src/prompts/runtime/` (recovery and scratchpad text), `src/providers/` (`Provider` calls from the loop).
- **Used by**: `src/actors/` (activities, deliveries, journal checkpoints), `src/tui/` (snapshots and system messages), `src/application.ts` (store, journal, sessions), `src/context/` (journal ledger ranges), `src/permissions/` (scratchpad path check).

## 6. Verification & Gaps
- Fast run: `node --test dist/tests/task-progress.test.js dist/tests/progress-lifecycle.test.js dist/tests/runtime-steps.test.js dist/tests/finish-round.test.js dist/tests/runtime-context-updates.test.js dist/tests/message-delivery.test.js dist/tests/human-input-delivery.test.js dist/tests/system-history*.test.js dist/tests/agent.test.js dist/tests/session*.test.js dist/tests/state-file-lock.test.js dist/tests/replace-file.test.js`
- Not covered offline: real model compliance with the finalizer contract; multi-process `.lock-v2` contention under heavy write load; very long continuous loops.
