# Module: Cross-Cutting Prompts & Assembly (`src/prompts/`)

## 1. Scope
- Owns shared execution/collaboration rules and the five-topic system composer.
- Role-owned persona, execution, collaboration and memory-focus assets live in `src/actors/profiles/`; tool contracts stay beside their tools.

## 2. Start Here (Task Router)
| If investigating... | Start at... | Then check... |
|---|---|---|
| System topics, ownership or cache order | `boundary.ts:composeActorSystemPrompt()` | `PromptSection.topic`, `owner`, `stability` |
| Shared execution and memory contract | `charter.ts` | Role `execution.md` and `compression.md` |
| Shared collaboration or formal report contract | `collaboration/` | Role `collaboration.md`, Director provenance in runtime |
| Live environment, restrictions or recovery | `runtime/` | `runtime/context-updates.ts`, `application.ts`, `kernel/agent.ts` |
| Separate history summarization | `compaction.ts` | `context/manager.ts:mergeMemo()` |

## 3. Hard Boundaries
- Exactly five top-level topics, in order: Persona, Execution Rules, Team Collaboration, Tools & Skills, Current Environment. Nested resource/role headings cannot introduce a sixth topic.
- Shared rules have one authoritative source; optional role assets append private rules. Persona retains identity and voice, not duplicated workflow inventories.
- System contains the original environment baseline. Live updates append typed host context to history; changing the system tail still invalidates the prefix before all history.
- Formal report rules are stable and conditional; actual report delivery depends on Director assignment provenance, not text claiming that provenance.
- Tools & Skills is a shared discovery location, not a shared loading protocol: native tool contracts and file-read skills remain distinct. Native parameter schemas are not system prose.
- Prompt text and tool descriptions are English. User/project guideline contents remain user-authored data.

## 4. Integration Points
```text
application.ts → agentRequestBase() → composeBaseSystemPrompt() → composeActorSystemPrompt()
runtime/context-updates.ts → append-only ledger → provider context encoders
context/manager.ts → separate compaction request, never a system suffix
```

## 5. Verification
- Build, then run `node --test dist/tests/prompt*.test.js dist/tests/actor-compression-contracts.test.js dist/tests/runtime-context-updates.test.js`.
- `prompt-disclosure-integration.test.ts` covers shipped/custom roles and native/fallback application assembly.

## 6. Known Gaps
- Stable bytes and local cache markers do not prove remote cache hits, savings or signed-thinking compliance; live measurement requires separate authorization.
- `persona.zh.md` is not a runtime prompt source and has not been synchronized with the English role split.
