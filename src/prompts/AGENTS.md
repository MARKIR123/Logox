# Module: Cross-Cutting Prompts & Assembly (`src/prompts/`)

## 1. Scope
- **Owns**: Static and conditional system-prompt sections, their grouping by category, and the assembly order that keeps a stable cacheable prefix.
- **Does not own**: Tool descriptions (`src/tools/<Tool>/prompt.ts`), skills (`src/resources/builtin-skills/`), actor personas (`src/actors/profiles/`), permission-review prompts (`src/permissions/guard.ts`).

## 2. Start Here (Task Router)
| If investigating... | Start at... | Then check... |
|---|---|---|
| Static/dynamic order or cache prefix | `boundary.ts:composeBaseSystemPrompt()` | `PromptSection.zone` and `composeRuntimeSystemPrompt()` |
| Execution charter, tool rules, optional activity labels, round summary | `charter.ts` | `ROUND_SUMMARY_CONTRACT` and `TASK_PROGRESS_RULE` |
| Inter-actor etiquette or role-specific collaboration | `collaboration/index.ts:collaborationFor()` | `common.ts`, `director.ts`, `actor.ts` |
| Task report or pending handoff | `collaboration/reporting.ts` | `src/kernel/agent.ts` conditional delivery |
| Compaction memo (separate request) | `compaction.ts` | `src/context/manager.ts:mergeMemo()` |
| Working directory, scratchpad, vision, recovery | `runtime/` | `src/application.ts` and `src/kernel/agent.ts` |
| Conditional Director facts, wake-up and recovery handoffs | `runtime/director.ts` | `actors/facts.ts`, `actors/services.ts` and per-request application assembly |

## 3. Hard Boundaries
- **Fixed Static Order**: persona → memory focus → environment → scratchpad → tool rules → charter → collaboration → user/project guidelines. Same role and session must keep the same set and order.
- **Append-Only Dynamic Sections**: vision, optional current-activity label, recovery, task report, handoff and relevant Director facts are appended after the static prefix; never insert or reorder static sections per request. Director facts are absent, not replaced by an empty roster, when no relevant work/events exist.
- **Single Source**: `ROUND_SUMMARY_CONTRACT` lives only in `charter.ts`; `TASK_REPORT_CONTRACT` and `HANDOFF_NOTICE` live only in `collaboration/reporting.ts`; `HISTORY_MEMO_INSTRUCTION` lives only in `compaction.ts`.
- **No Persona Process Rules**: personas keep identity, personality, domain stance, and voice; tool names, collaboration flows, report formats, verification SOPs, and scratchpad rules belong here.
- **Private `.ts` Convention**: files under `src/prompts/` are package-owned team rules; users edit `.md` assets in `~/.logox/actors` and `~/.logox/skills`.

## 4. Integration Points
```text
kernel/agent.ts:agentRequestBase() → composeBaseSystemPrompt()
application.ts:requestBase() → memory focus + per-request environment suffix
kernel/agent.ts → composeRuntimeSystemPrompt() (vision/progress/recovery/report)
context/manager.ts → composeBaseSystemPrompt(includeSummary=false) / mergeMemo()
```

## 5. Verification
- `tests/prompt-architecture.test.ts`: structure, unique sources, static zone order, profile bootstrap, `config.yaml` wiring.
- `tests/prompts.test.ts`: persona decoupling and assembly order.
- `tests/actor-compression-contracts.test.ts`: one memory contract and one role focus per request.
- Fast run:
  ```bash
  node --test dist/tests/prompt-architecture.test.js dist/tests/prompts.test.js dist/tests/actor-compression-contracts.test.js
  ```

## 6. Known Gaps
- Anthropic explicit `cache_control` breakpoints are not implemented yet; only prefix-order stability is guaranteed.
- `persona.zh.md` Chinese translations have not yet been re-synced with the stripped English personas.
