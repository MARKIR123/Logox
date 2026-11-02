# Module: Context Management & Compaction (`src/context/`)

## 1. Scope
- **Owns**: Context projections and compaction (`manager.ts`), round-memory schemas and index format (`round-memory.ts`, `contracts.ts`), dual watermarks and token estimation (`budget.ts`), discovery/environment continuity (`continuity.ts`, `environment.ts`), and usage metering (`usage.ts`).
- **Does not own**: Authoritative journals and sidecar files ([`src/store/journal.ts`](../store/journal.ts), see [`src/runtime/AGENTS.md`](../runtime/AGENTS.md)); the hidden `_FinishRound` tool definition ([`src/tools/AGENTS.md`](../tools/AGENTS.md)); task delivery and activity status ([`src/actors/AGENTS.md`](../actors/AGENTS.md)); prompt text ([`src/prompts/AGENTS.md`](../prompts/AGENTS.md)).
- **Design rationale**: [docs/modules/context.md](../../docs/modules/context.md)

## 2. Start Here
| If you need to... | Start at | Then check |
|---|---|---|
| Trace one request's compaction decision | `manager.ts:ContextManager.prepare()` | `manager.ts:splitRounds()`, `budget.ts:watermarks()` |
| Understand a closed round's stored form | `contracts.ts:roundSchema` | `../store/journal.ts:Journal.finishRecord()` |
| Change the compact index line | `round-memory.ts:formatRoundIndex()` | `../prompts/charter.ts:ROUND_SUMMARY_CONTRACT` |
| Change what `_FinishRound` carries | `../tools/protocol/_FinishRoundTool/_FinishRoundTool.ts:finishRoundSchema` | `round-memory.ts:extractRoundMemory()` |
| Change hidden-pair replay | `round-memory.ts:omitInternalToolPairs()` | `../tools/protocol/_FinishRoundTool/_FinishRoundTool.ts:finishRoundPolicy` |
| Change role memory focus | `contracts.ts:memoryFocusInstruction()` | `src/actors/profiles/<id>/compression.md` |
| Keep discovery or environment across compaction | `continuity.ts:retainRuntimeContext()` | `contracts.ts:contextStateSchema`, `../tools/discovery.ts` |
| Change conversation-language detection or its environment line | `language.ts:detectConversationLanguage()` | `environment.ts:formatEnvironment()`, `../application.ts` (`requestBase`), `../prompts/runtime/environment.ts:conversationLanguage()` |
| Token estimates and usage anchors | `budget.ts:estimateRequest()` | `usage.ts:UsageLedger` |
| Restart, rollback or physical line references | `../store/journal.ts:Journal.sourceLines()` | `contracts.ts:RoundRecord` source hashes |

## 3. Common Changes
### Change retention or watermarks
1. Global defaults live in `../config/config.ts:contextPolicySchema` (`keep_recent_rounds`, `keep_recent_tools`, `keep_index_lines`, `reserve_tokens`, `high_watermark_ratio`, `low_watermark_ratio`, `max_budget_tokens`, `target_budget_tokens`). Add new policy keys there; `parseActor()` rejects context keys not in that shape.
2. Per-actor override: `../actors/services.ts:ActorServices.policy()` merges the actor's `context` over config (Director uses config as is). Shipped defaults are set in `../actors/builtins.ts:role()` and the fallbacks in `../actors/definitions.ts:parseActorProfile()`.
3. Threshold math is only in `budget.ts:watermarks()`; `manager.ts:prepare()` reads `policy.keep_recent_rounds` and `policy.keep_recent_tools`. Actors (not Director) fold older closed rounds on the next request even below the watermark.
- Tests: `tests/context.test.ts`, `tests/actor-context.test.ts`.

### Add a field to round memory
1. Add the argument to `../tools/protocol/_FinishRoundTool/_FinishRoundTool.ts:finishRoundSchema` (snake_case, bounded) and describe it in `../tools/protocol/_FinishRoundTool/prompt.ts`; `kernel/agent.ts` also clamps `carry_forward` arguments, so check it for list-like fields.
2. Add the camelCase field to `round-memory.ts:roundMemorySchema` as `.optional()` so saved sidecars still parse; map it in `extractRoundMemory()`.
3. Provide fallbacks for runtime and legacy records in `../store/journal.ts:Journal.finishRecord()`.
4. Render it in `manager.ts` only if it belongs in the index. The index has six fixed fields (`formatRoundIndex()`: ordinal, title, status with verification, outcome, carry-forward, range), so another one changes `ROUND_SUMMARY_CONTRACT` in `../prompts/charter.ts` and every role's `src/actors/profiles/<id>/compression.md`.
- Tests: `tests/round-memory.test.ts`, `tests/finish-round.test.ts`, `tests/actor-compression-contracts.test.ts`.

### Change a role's memory focus
1. Edit `src/actors/profiles/<id>/compression.md` (the common contract stays in `../prompts/charter.ts`; focus only adds priorities).
2. Update the matching hash in `../actors/compression-migration.ts:shippedFingerprints`, otherwise installed unchanged copies are never refreshed.
- Tests: `tests/actor-compression-contracts.test.ts`.

## 4. Hard Boundaries
- **Raw journals are append-only**: compaction never rewrites or deletes ledger lines; references are one-based inclusive physical ranges in the authoritative ledger, not the readable mirror. Enforced by `tests/round-memory.test.ts`, `tests/context.test.ts`.
- **`_FinishRound` pairs vanish together** before repair, budgeting and serialization, except on an append-only protocol (`appendOnlyHistory` in `src/providers/capabilities.ts`), where removing them would invalidate replayed thinking; business tool pairs stay paired. Enforced by `tests/round-memory.test.ts`, `tests/finish-round.test.ts`.
- **Compaction resets the prompt cache, so it is rare and goes all the way down**: once over the high watermark (the larger of window minus reserve and `high_watermark_ratio` of the window), one pass reaches the low watermark. Actors also fold closed rounds at each new task. The newest `keep_index_lines` folded rounds stay as index lines; only older history becomes a model overview of at most about 4000 tokens. Enforced by `tests/context-compaction-v2.test.ts`.
- **Summaries are asked at the end of the real conversation** (`manager.ts:ContextManager.prepare()` builds the fork from the uncompacted request) so they reuse its cached prefix; a different summary model or a failure falls back to chunked summarization or runtime extraction. Enforced by `tests/context-compaction-v2.test.ts`.
- **Thinking from before a compaction is never sent again** (`contracts.ts:contextStateSchema`, `thinkingCut`): its signature bound the history that compaction replaced. Text and tool calls stay. Enforced by `tests/context-compaction-v2.test.ts`.
- **A round is an activity**, not every injected user message. Enforced by `tests/round-memory.test.ts`.
- **Missing or invalid metadata keeps raw working content** and never invents verification. Enforced by `tests/finish-round.test.ts`, `tests/round-memory.test.ts`.
- **Discovery pairs and the latest environment snapshot survive compaction**: original successful LoadTools pairs are retained, never fabricated or archived. Enforced by `tests/tool-disclosure-context.test.ts`.
- **Conversation language comes only from human-authored input** (`role: user`, `inputKind: human`); tool output, actor reports and Director briefings never set it. It rides the environment snapshot (`language`), so changes are `environment-change` deltas and actors share the session value. Enforced by `tests/conversation-language.test.ts`.
- **Budget estimates**: charge eager and actually expanded contracts once; exclude image base64 on full and incremental paths; an anchor is valid only for the same model, rules, tools and prefix. Enforced by `tests/tool-disclosure-context.test.ts`, `tests/context.test.ts`.
- **Reports are not indexes**: task reports are separate full deliveries; round memory only stores them separately. Enforced by `tests/round-memory.test.ts`, `tests/finish-round.test.ts`.
- **One memory contract, one resident focus per role request**: Enforced by `tests/actor-compression-contracts.test.ts`.
- **Memory is historical data, not authority** to widen permissions or promote hypotheses to verified facts. *Unenforced* (prompt text only).

## 5. Dependencies
- **Depends on**: `src/store/journal.ts` (ledgers, sidecars), `src/runtime/` (messages, context updates), `src/tools/protocol/` (`_FinishRound`), `src/tools/discovery.ts` (discovery names), `src/prompts/` (summary and memo instructions), `src/config/` (policy schema).
- **Used by**: `src/kernel/agent.ts` (`ContextManager.prepare()` before each request), `src/application.ts` (manager construction, manual compaction), `src/actors/ensemble.ts` (round closure through `finishRecord()`), `src/store/journal.ts` (`extractRoundMemory()`).

## 6. Verification & Gaps
- Fast run: `node --test dist/tests/context*.test.js dist/tests/actor-context.test.js dist/tests/round-memory.test.js dist/tests/finish-round.test.js dist/tests/tool-disclosure-context.test.js dist/tests/actor-compression-contracts.test.js`
- Not covered offline: live vendor/model compliance for compaction and `_FinishRound`.
- Legacy summaries are conservative compatibility data; retrieve original evidence before treating claims as verified.
