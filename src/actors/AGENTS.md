# Module: Actors & Ensemble (`src/actors/`)

## 1. Scope
- **Owns**: Actor definitions and profile loading (`definitions.ts`, `catalog.ts`, `builtins.ts`, `profiles.ts`), the `EnsembleRuntime` task queue, actor-facing service tools (`services.ts`), `SendMessage` routing (`collaboration.ts`), the durable delivery queue, Director facts, recovery budgets, per-actor model bindings, and `.logox/bulletin.md`.
- **Does not own**: The single-agent LLM loop ([`src/kernel/agent.ts`](../kernel/agent.ts), see [`src/runtime/AGENTS.md`](../runtime/AGENTS.md)); tool schemas, registry and per-file edit observation (`src/tools/snapshots.ts`, [`src/tools/AGENTS.md`](../tools/AGENTS.md)); shared collaboration prompt text ([`src/prompts/AGENTS.md`](../prompts/AGENTS.md)); round memory ([`src/context/AGENTS.md`](../context/AGENTS.md)); card rendering ([`src/tui/AGENTS.md`](../tui/AGENTS.md)).
- **Design rationale**: [docs/modules/actors.md](../../docs/modules/actors.md)

## 2. Start Here
| If you need to... | Start at | Then check |
|---|---|---|
| Trace dispatch, queueing or cancellation | `ensemble.ts:EnsembleRuntime.dispatch()` | `ensemble.ts:EnsembleRuntime.cancelActor()`, `TaskOrigin` |
| Trace an actor-facing tool call | `services.ts:ActorServices.execute()` | `services.ts:serviceTools`, `services.ts:executeCancelActor` |
| Trace `SendMessage` routing and interruption | `collaboration.ts:Collaboration.execute()` | `ensemble.ts:EnsembleRuntime.injectTaskMessage()` |
| Change Queue/Steer priority or durable receipts | `../runtime/delivery.ts:deliveryPriority` | `delivery-queue.ts:DeliveryQueue.drain()`, `services.ts:wakeDirector()` |
| Change what the Director or peers observe | `facts.ts:directorFacts()` | `facts.ts:activeEnsembleRoster()`, `services.ts:executeListActors`, `application.ts:requestBase()` |
| Change recovery, stop gates or retry budgets | `recovery.ts` | `../kernel/execution-recovery.ts`, `services.ts:handoff()` |
| Change how profiles are discovered, merged or validated | `catalog.ts:ActorCatalog.reload()` | `definitions.ts:mergeActorPromptLayer()`, `definitions.ts:parseActorProfile()` |
| Fix a missing or corrupt shipped profile at startup | `profiles.ts:assertActorProfiles()` | `profiles.ts:seedActorProfiles()`, `scripts/install-actor-profiles.mjs` |
| Persist an actor's default model | `actor-models-storage.ts` | `management.ts`, `~/.logox/actor-models.json` |
| Refresh a shipped `compression.md` default | `compression-migration.ts:refreshShippedCompression()` | `compression-migration.ts:shippedFingerprints` |
| Bulletin board | `bulletin.ts:appendProjectBulletin()` | `../prompts/collaboration/common.ts:BULLETIN` |

## 3. Common Changes
### Add a built-in actor
1. Create `profiles/<id>/` with `config.yaml`, `persona.md` and `compression.md`; `execution.md` and `collaboration.md` are optional. Model it on `profiles/techne/`. The build copies the whole directory (`scripts/copy-actor-profiles.mjs`).
2. Add a `role('<id>', ...)` entry to `builtins.ts:builtinActors`. The last-but-one argument is `keep_recent_tools`; the last is the skill list.
3. Add the id to `profiles.ts:BUILTIN_ACTOR_IDS` so seeding and `assertActorProfiles()` include it.
4. Add a `cast` entry in `ensemble.ts`; `ActorId` is derived from its keys.
5. Add the SHA-256 of the new `compression.md` (CRLF normalized to LF) to `compression-migration.ts:shippedFingerprints`. Without it `refreshShippedCompression()` always returns `preserved`.
6. Run `npm run sync:profiles` to force the development copy into `~/.logox/actors`.
- Tests: `tests/actor-color-source.test.ts` (asserts the builtin id list), `tests/prompt-architecture.test.ts` (asserts the seeded id list), `tests/actor-compression-contracts.test.ts`.

### Add a field to the actor definition
1. Add it to `definitions.ts:actorDefinitionSchema` (a `z.strictObject`, so unknown keys are rejected). Optional fields stay `.optional()`.
2. For a snake_case YAML key, add the alias-to-camelCase block in both `parseActor()` and `parseActorProfile()`; the two blocks are duplicated, not shared.
3. If the field is layered text, add it to `mergeActorPromptLayer()`; user, then project, assets append to the shipped base.
4. `serializeActor()` follows the schema. Surface the field in `management.ts` (the actor detail text) only if users should see it.
5. If `builtins.ts:role()` should set it, pass it through there too.
- Example: `activity_verbs` (`definitions.ts:actorDefinitionSchema`) holds Gerund-slash-Past pools per tool-group category; missing categories fall back to `src/tui/timeline/group-row.ts:defaultActivityVerbs`.
- Example: `automa` (`src/tools/orchestration/AutomaTool/preset.ts:automaProfileSchema`) holds the swarm name, presets and worker model; when it is missing the actor gets `src/tools/orchestration/AutomaTool/preset.ts:DEFAULT_AUTOMA_PROFILE`, which is read-only. Installed copies in `~/.logox/actors` gain it only after `npm run sync:profiles`.
- Tests: `tests/actor-definitions.test.ts`, `tests/prompt-composition.test.ts`.

### Change delivery kind or priority
1. Edit `deliveryKindSchema` and `deliveryPriority` in `../runtime/delivery.ts`. The record is typed `Record<DeliveryKind, number>`, so a new kind fails typecheck until ranked.
2. Both `delivery-queue.ts:DeliveryQueue.drain()` and `services.ts:wakeDirector()` sort pending items by it; equal priority stays FIFO.
3. Check the boundary consumers in `ensemble.ts:injectTaskMessage()` and `services.ts:handoff()`.
- Tests: `tests/message-delivery.test.ts`, `tests/director-coordination.test.ts`, `tests/human-input-delivery.test.ts`.

### Add an actor-facing service tool
Follow "Add a built-in tool" in [`src/tools/AGENTS.md`](../tools/AGENTS.md), step 7. The actors-side part: add the tool name to `services.ts:serviceTools` and a branch in `ActorServices.execute()`. `SendMessage` is the exception: `collaboration.ts:Collaboration.tools()` exposes it and `execute()` serializes calls through a promise tail.
- Tests: `tests/actor-collaboration-enhancements.test.ts`, `tests/actor-collaboration.test.ts`.

## 4. Hard Boundaries
- **Role asset layers**: project persona, execution and collaboration files append to user-level ones; an invalid optional file leaves the previous catalog intact. Enforced by `tests/prompt-composition.test.ts`, `tests/actor-definitions.test.ts`.
- **No extra cards for coordination**: active recipients take messages inside their current activity; Director-bound messages and broadcasts use the durable queue and never interrupt Director processes or open a second Director task (an idle Director gets one coalesced wake). Enforced by `tests/director-coordination.test.ts`, `tests/actor-collaboration-enhancements.test.ts`.
- **Delivery intent**: Human Queue work stays out of the active activity; Steer binds to an exact activity id and never retargets; FIFO within a priority class. Enforced by `tests/message-delivery.test.ts`, `tests/human-input-delivery.test.ts`.
- **Reports are independent and full**: only formal Director dispatch selects report mode, and the full `delivery.text` is handed off, never a compact index. Enforced by `tests/finish-round.test.ts`, `tests/message-delivery.test.ts`.
- **Failure ownership**: direct human-to-Actor failures stay local; stop gates, root recovery budgets and dispatch depth survive wake-ups and restart. Enforced by `tests/actor-recovery.test.ts`, `tests/director-coordination.test.ts`.
- **Bounded observations**: Director facts are a snapshot of at most eight tasks with only id, owner, status, title and self-reported subtitle, sent through `src/kernel/agent.ts:AgentRequestBase` (also used for the peers' roster) so that only the current state is in context wherever the protocol allows it, see `src/runtime/AGENTS.md`; detail lives in `ListActors` and `ReadActor`; the roster appears only when peers are active; labels and tool completion are never acceptance. Enforced by `tests/director-facts.test.ts`.
- **`persona.zh.md` mirrors `persona.md`**: it is the user-facing Chinese reference and is not loaded at runtime; any edit to `persona.md` must be mirrored there. *Unenforced*.
- **Personas never restate collaboration tools or channel workflow**: shared etiquette lives in `src/prompts/collaboration/`. Enforced by `tests/prompts.test.ts`.
- **Model bindings are user-scoped** in `~/.logox/actor-models.json` and survive project changes; a missing main model must not hide saved bindings. Enforced by `tests/fresh-directory-models.test.ts`.
- **Profiles seed missing-only**: `seedActorProfiles()` and `--install-profiles` never overwrite user files; only `npm run sync:profiles` forces. Enforced by `tests/prompt-architecture.test.ts`. Builtin colors come from shipped YAML, never RGB tables or themes: `tests/actor-color-source.test.ts`.
- **Shipped `compression.md` refresh is exact-match only**: custom focus, persona, config and bindings stay byte-identical. Enforced by `tests/actor-compression-contracts.test.ts`.
- **File ownership is a nudge, not a lock**: `Actor` tasks may carry `files`; `services.ts:ActorServices.execute()` stores them as `ownedFiles` on the activity (via `TaskOrigin`), live while it is queued, running, waiting or paused. `../tools/ownership.ts:overreach()` finds another actor's owner and `../tools/index.ts:Tools.withOverreachNote()` appends one note per (editor, file, activity); `facts.ts:activeEnsembleRoster()` shows `owns:` per peer. Edits are never blocked. Enforced by `tests/tool-ownership.test.ts`.
- **Structured brief and `after` sequencing**: `Actor` tasks may carry `deliverables`, `owns`, `interfaces`, `acceptance`, `verified` and `after` (`../tools/orchestration/ActorTool/ActorTool.ts:taskSpecSchema`). `services.ts:ActorServices.execute()` appends `../tools/orchestration/ActorTool/brief.ts:renderBrief()` to the prompt, merges `owns` and legacy `files` into `ownedFiles`, resolves `after` through `services.ts:ActorServices.resolveAfter()` (actor id or activity id; unknown ids, self references and cycles are rejected) and stores activity ids on `TaskOrigin.after`. `ensemble.ts:EnsembleRuntime.releaseDependencies()` keeps the task `queued` with stage `Waiting on <Name>` until every dependency ends, then prepends their full reports to the prompt; a dependency that failed or was stopped keeps the task from ever starting (the failed batch pauses it, a resume cancels it). Enforced by `tests/actor-brief.test.ts`.
- **No hidden queue jumpers**: a collaboration message for an actor whose Director-dispatched task has not started (held by `after`, a paused batch or a busy slot) folds into that queued task (`ensemble.ts:EnsembleRuntime.foldIntoQueued()`) instead of opening a second activity that would run first and hold the actor's slot; a ready task behind its actor's current activity shows `Waiting on <Name>'s current task` (`ensemble.ts:EnsembleRuntime.markBusy()`). Enforced by `tests/actor-brief.test.ts`.
- **Dispatch briefing**: Director supplies a concise `title` and a natural colleague `prompt`, with no task-book headers or file/build quotas. Partially enforced by `tests/director-facts.test.ts` (no headers); the quota rule is *Unenforced* (prompt text only).

## 5. Dependencies
- **Depends on**: `src/runtime/` (store, delivery schema), `src/store/` (journal, `withFileLock`), `src/tools/` (service tool definitions, `SendMessageTool`), `src/config/` (`contextPolicySchema`), `src/context/` (`TaskDelivery`).
- **Used by**: `src/application.ts` (binds `ActorServices` and the ensemble), `src/kernel/agent.ts` (builtin lookup, inbox drain), `src/tui/` (actor cards, pills, colors), `src/context/manager.ts` (per-actor policy via `ActorServices.policy()`).

## 6. Verification & Gaps
- Fast run: `node --test dist/tests/actor*.test.js dist/tests/ensemble.test.js dist/tests/message-delivery.test.js dist/tests/human-input-delivery.test.js dist/tests/director-*.test.js dist/tests/fresh-directory-models.test.js`
- No semantic stagnation breaker: progress fingerprints dedupe recovery evidence, not task value.
- Not covered offline: multi-provider and model compliance for actors.
