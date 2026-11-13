# Module: Prompts & Assembly (`src/prompts/`)

## 1. Scope
- **Owns**: The six-topic system composer (`boundary.ts`), shared execution rules (`charter.ts`), shared collaboration and task-report contracts (`collaboration/`), the history-memo instruction (`compaction.ts`), and typed host-message texts (`runtime/`).
- **Does not own**: Role-owned assets (persona, execution, collaboration and compression Markdown files) in `src/actors/profiles/<id>/` ([`src/actors/AGENTS.md`](../actors/AGENTS.md)); tool descriptions beside each tool ([`src/tools/AGENTS.md`](../tools/AGENTS.md)); history compaction mechanics ([`src/context/AGENTS.md`](../context/AGENTS.md)).
- **Design rationale**: [docs/modules/context.md](../../docs/modules/context.md) (system prompt and tool disclosure).

## 2. Start Here
| If you need to... | Start at | Then check |
|---|---|---|
| See topic order, section owner or cache stability | `boundary.ts:composeActorSystemPrompt()` | `boundary.ts:PromptSection` |
| See how a request assembles its prompt | `../kernel/agent.ts:agentRequestBase()` | `boundary.ts:composeBaseSystemPrompt()` |
| Change shared execution, status-line, vision or round-memory text | `charter.ts:SHARED_EXECUTION_RULES` | `src/actors/profiles/<id>/execution.md`, `src/actors/profiles/<id>/compression.md` |
| Change peer messaging etiquette | `collaboration/common.ts` | `collaboration/index.ts:TEAM_COLLABORATION`, `src/actors/profiles/<id>/collaboration.md` |
| Change rules for every non-Director actor | `collaboration/companion.ts:COMPANION_COLLABORATION` | `collaboration/index.ts:collaborationFor()` |
| Change the formal task-report contract | `collaboration/reporting.ts:TASK_REPORT_CONTRACT` | `../context/round-memory.ts:TaskDelivery`, `runtime/director.ts:RUNTIME_RECORD_LABELS` |
| Change Director wake-up or recovery wording | `runtime/director.ts` | `runtime/recovery.ts`, `../actors/services.ts` |
| Change the live environment or restriction text | `runtime/environment.ts` | `../runtime/context-updates.ts`, `../application.ts` |
| Change history summarization instructions | `compaction.ts:HISTORY_MEMO_INSTRUCTION` | `../context/manager.ts:mergeMemo()` |

## 3. Common Changes
### Change a shared rule
1. Edit the constant in `charter.ts` (`SHARED_EXECUTION_RULES`, `ROUND_SUMMARY_CONTRACT`), `collaboration/common.ts` (one constant per rule, joined in `collaboration/index.ts:TEAM_COLLABORATION`) or `collaboration/companion.ts`. State each rule once: the language rule lives only in `SHARED_EXECUTION_RULES`, and the Playwright procedure lives in the `browser-screenshot` skill.
2. Keep each file under 16 KiB and each constant defined exactly once.
3. If the rule restates a persona line, delete it from `src/actors/profiles/<id>/persona.md`; personas hold identity and voice only.
4. Prompt text is cache-prefix bytes: any edit invalidates cached prefixes for every actor.
- Tests: `tests/prompt-architecture.test.ts` (single sources, file size), `tests/prompts.test.ts`.

### Add a section inside an existing topic
1. Add an optional field to `boundary.ts:ActorSystemPromptInput` and `BasePromptOptions`, and pass it through `composeBaseSystemPrompt()`.
2. Call `add(name, topic, owner, text, stability)` in `composeActorSystemPrompt()` at the position that keeps the cache-stable order (fixed text above `boundary.ts:PROMPT_CACHE_BOUNDARY`, what can change below it, environment last).
3. Supply the value from `../kernel/agent.ts:agentRequestBase()`.
4. Update the expected section-name list in the test.
- Tests: `tests/prompt-architecture.test.ts` (exact section order), `tests/prompt-composition.test.ts`, `tests/prompt-disclosure-integration.test.ts`.

### Add a typed host message (live update)
1. Put the English text constant in `runtime/` (`environment.ts` for request context, `director.ts` for Director wake-ups).
2. Emit it from the caller (see `../application.ts`) as a typed message through `../runtime/context-updates.ts:createRuntimeContextMessage()`; never rewrite the system prompt.
- Tests: `tests/runtime-context-updates.test.ts`, `tests/prompts.test.ts`.

## 4. Hard Boundaries
- **Exactly six topics, ordered by how likely they are to change**: Persona, Execution Rules, Team Collaboration, then `boundary.ts:PROMPT_CACHE_BOUNDARY`, then Project Guidelines, Tools & Skills, Current Environment. Everything above the boundary is fixed text. Nested headings are demoted (`nested()`) and cannot add a seventh. Enforced by `tests/prompt-composition.test.ts`, `tests/prompt-disclosure-integration.test.ts`.
- **Companion layer**: `collaboration/index.ts:collaborationFor(ownerId)` returns team rules for every actor and appends `COMPANION_COLLABORATION` for every actor except `logox` (crafted and dynamic actors are companions). The composer receives `ownerId` from `../kernel/agent.ts:agentRequestBase()`. Enforced by `tests/prompts.test.ts`.
- **One source per shared contract**: `ROUND_SUMMARY_CONTRACT`, `TASK_REPORT_CONTRACT` and `HISTORY_MEMO_INSTRUCTION` are each defined once. Enforced by `tests/prompt-architecture.test.ts`.
- **Personas do not repeat tool names or collaboration workflow**: Enforced by `tests/prompts.test.ts`, `tests/prompt-composition.test.ts`.
- **Live changes never rewrite the system prompt**: runtime facts are typed history messages; the system tail holds only the original baseline. Enforced by `tests/prompts.test.ts`, `tests/runtime-context-updates.test.ts`.
- **Report mode follows Director dispatch provenance**, not text claiming it. Enforced by `tests/finish-round.test.ts`.
- **Tools & Skills is a discovery location only**: native parameter schemas are not system prose, and guidelines never mix into skill discovery. Enforced by `tests/prompt-composition.test.ts`, `tests/prompt-disclosure-integration.test.ts`.
- **Prompt text and tool descriptions are English**; user guideline contents stay user-authored. *Unenforced*.

## 5. Dependencies
- **Depends on**: nothing except the import-free leaf `src/runtime/director-id.ts` (`isDirector()`); this is otherwise a leaf of pure constants and one composer.
- **Used by**: `src/kernel/agent.ts` (system composition), `src/application.ts` (restriction and handoff text), `src/actors/services.ts` (Director wake texts), `src/context/contracts.ts` (round-summary and memo instructions), `src/kernel/execution-recovery.ts` (recovery wording).

## 6. Verification & Gaps
- Fast run: `node --test dist/tests/prompt*.test.js dist/tests/actor-compression-contracts.test.js dist/tests/runtime-context-updates.test.js`
- Not covered offline: stable bytes and local cache markers do not prove remote cache hits or signed-thinking compliance.
- `src/actors/profiles/<id>/persona.zh.md` is not a runtime source and is not synchronized with the English role split.
- Section names, in order: `persona`, `shared_execution`, `round_memory`, `memory_focus`, `role_execution`, `collaboration`, `role_collaboration`, `guidelines`, `tools`, `skills`, `environment`. Shared rules come before the role rules that build on them, and the memory focus follows the memory contract it refines.
