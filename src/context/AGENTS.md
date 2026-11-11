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
| Change what `_FinishRound` carries | `../tools/protocol/_FinishRoundTool/_FinishRoundTool.ts:finishRoundSchema` | `round-memory.ts:normalizeFinishRound()`, `round-memory.ts:extractRoundMemory()` |
| Change a runtime-written round body or its marker | `round-memory.ts:runtimeRoundSummary()` | `round-memory.ts:ROUND_MARKERS`, `../store/journal.ts:Journal.finishRecord()` |
| Change hidden-pair replay | `round-memory.ts:omitInternalToolPairs()` | `../tools/protocol/_FinishRoundTool/_FinishRoundTool.ts:finishRoundPolicy` |
| Change role memory focus | `contracts.ts:memoryFocusInstruction()` | `src/actors/profiles/<id>/compression.md` |
| Keep discovery or environment across compaction | `continuity.ts:retainRuntimeContext()` | `contracts.ts:contextStateSchema`, `../tools/discovery.ts` |
| Change conversation-language detection or its environment line | `language.ts:detectConversationLanguage()` | `environment.ts:formatEnvironment()`, `../application.ts` (`requestBase`), `../prompts/runtime/environment.ts:conversationLanguage()` |
| Token estimates and usage anchors | `budget.ts:estimateRequest()` | `usage.ts:UsageLedger` |
| Per-turn usage and cost stored in the session ledger | `manager.ts:ContextManager.turnUsage()` | `src/runtime/messages.ts:turnUsageSchema`, `cost.ts:turnUsageOf()` (also priced onto Automa `message` events and the session-level `usage.jsonl` lines for summary and approval calls, written in `src/application.ts`), `src/kernel/agent.ts` (`turnUsage`), `scripts/score-session.mjs` |
| Restart, rollback or physical line references | `../store/journal.ts:Journal.sourceLines()` | `contracts.ts:RoundRecord` source hashes |

## 3. Common Changes
### Change retention or watermarks
1. Global defaults live in `../config/config.ts:contextPolicySchema` (`keep_recent_rounds`, `keep_recent_tools`, `keep_index_lines`, `reserve_tokens`, `high_watermark_ratio`, `low_watermark_ratio`, `task_end_floor_ratio`, `compact_accept_ratio`, `max_budget_tokens`, `target_budget_tokens`). Add new policy keys there; `parseActor()` rejects context keys not in that shape.
2. Per-actor override: `../actors/services.ts:ActorServices.policy()` merges the actor's `context` over config (Director uses config as is). Shipped defaults are set in `../actors/builtins.ts:role()` and the fallbacks in `../actors/definitions.ts:parseActorProfile()`.
3. Threshold math is only in `budget.ts:watermarks()`; `manager.ts:prepare()` reads `policy.keep_recent_rounds` and `policy.keep_recent_tools`. Actors (not Director) fold closed rounds only at a real task end (`manager.ts:ContextManager.taskEnd()`, called by `../actors/ensemble.ts` for `director`/`human` inputs only) or above the high watermark; starting a new activity never forces compaction. A task end is skipped below `task_end_floor_ratio` (default 0.5, `budget.ts:TASK_END_FLOOR_RATIO`) of the high watermark and its candidate is discarded silently unless it is at most `compact_accept_ratio` (default 0.75, `budget.ts:COMPACT_ACCEPT_RATIO`) of the original estimate.
- Tests: `tests/context.test.ts`, `tests/actor-context.test.ts`.

### Add a field to round memory
1. Add the argument to `../tools/protocol/_FinishRoundTool/_FinishRoundTool.ts:finishRoundSchema` and describe it in `../tools/protocol/_FinishRoundTool/prompt.ts`. Arguments are lenient: give it a token cap next to `FINISH_ROUND_SUMMARY_TOKENS` and handle it in `round-memory.ts:normalizeFinishRound()` (truncate, never reject).
2. Add the camelCase field to `round-memory.ts:roundMemorySchema` (the preprocess step still joins old records) and map it in `extractRoundMemory()`.
3. Provide the runtime value in `../store/journal.ts:Journal.finishRecord()` (`round-memory.ts:runtimeRoundSummary()`).
4. Render it in `manager.ts` only if it belongs in the index. The index has four fixed fields (`formatRoundIndex()`: `T<ordinal>|<title>|<summary>|<start>-<end>`; status is a bracket marker opening the summary), so another one changes `ROUND_SUMMARY_CONTRACT` in `../prompts/charter.ts` and every role's `src/actors/profiles/<id>/compression.md`.
- Tests: `tests/round-memory.test.ts`, `tests/finish-round.test.ts`, `tests/actor-compression-contracts.test.ts`.

### Change a role's memory focus
1. Edit `src/actors/profiles/<id>/compression.md` (the common contract stays in `../prompts/charter.ts`; focus only adds priorities).
2. Update the matching hash in `../actors/compression-migration.ts:shippedFingerprints`, otherwise installed unchanged copies are never refreshed.
- Tests: `tests/actor-compression-contracts.test.ts`.

## 4. Hard Boundaries
- **Context readings and cost are honest about their source**: `ContextManager.observe()` records the provider-reported size of each response (`estimated: false`); `restoreReading()` rebuilds a resumed window's reading as an estimate; `invalidatePrefix()` only marks readings estimated (it never clears another actor's). Prices come through the single `cost.ts:modelPrice` lookup (configured prices today; a synced model table plugs in there); a missing cache rate bills as input and marks the figure partial, and unpriced models show no cost. Enforced by `tests/status-data.test.ts`, `tests/status-live.test.ts`.
- **Cache writes are priced by lifetime**: `UsageRecord.cacheWrite1h` (from Anthropic `cache_creation.ephemeral_1h_input_tokens`) is billed at `cache_write_1h` (default 2x `input`), the remaining `cacheWrite` at the 5-minute `cache_write` rate. Cache keep-alive calls are recorded as category `keepalive` and listed per actor by `scripts/score-session.mjs`. Enforced by `tests/provider-cache-retention.test.ts`, `tests/session-scorer.test.ts`.
- **Raw journals are append-only**: compaction never rewrites or deletes ledger lines; references are one-based inclusive physical ranges in the authoritative ledger, not the readable mirror. Enforced by `tests/round-memory.test.ts`, `tests/context.test.ts`.
- **Request-only notes never survive compaction**: `continuity.ts:retainRuntimeContext()` skips transient context kinds (`recovery`); the answered ones are filtered out of requests by `src/kernel/agent.ts`. Compaction fork prefixes are built from the unfiltered ledger view. Enforced by `tests/transient-notes.test.ts`.
- **`_FinishRound` pairs vanish together** before repair, budgeting and serialization, except on an append-only protocol (`appendOnlyHistory` in `src/providers/capabilities.ts`), where removing them would invalidate replayed thinking; business tool pairs stay paired. Enforced by `tests/round-memory.test.ts`, `tests/finish-round.test.ts`.
- **Compaction resets the prompt cache, so it is rare and goes all the way down**: once over the high watermark (the larger of window minus reserve and `high_watermark_ratio` of the window), one pass reaches the low watermark. Actors additionally fold closed rounds at a real task end (Director assignment or human task), subject to the 50% floor and the 75% benefit gate; collaboration and wake activities never trigger it. Enforced by `tests/actor-context.test.ts`, `tests/actor-collaboration.test.ts`. The newest `keep_index_lines` folded rounds stay as index lines; only older history becomes a model overview of at most about 4000 tokens. Enforced by `tests/context-compaction-v2.test.ts`.
- **Summaries are asked at the end of the real conversation** (`manager.ts:ContextManager.prepare()` builds the fork from the uncompacted request) so they reuse its cached prefix; a different summary model or a failure falls back to chunked summarization or runtime extraction. Enforced by `tests/context-compaction-v2.test.ts`.
- **Thinking from before a compaction is never sent again** (`contracts.ts:contextStateSchema`, `thinkingCut`): its signature bound the history that compaction replaced. Text and tool calls stay. Enforced by `tests/context-compaction-v2.test.ts`.
- **Images leave history only through saved decisions**: every image has a file path from creation (`ImageBlock.path`, `src/kernel/scratchpad.ts:saveToolImages()`); archived tool results and everything below `contextStateSchema.imageCut` show `[image: <path>]` text (`images.ts:imagesAsText()`), and `imageCut` is written in one batch when a request exceeds `ModelCapacity.maxImages` (down to half) or after `ContextManager.downgradeImages()`. Enforced by `tests/image-history.test.ts`.
- **A round is one record over a contiguous ledger range, usually one activity**, never every injected user message. A Director round stays open while its dispatched work is open: the activities that continue it carry `roundId` (the first activity's id, `../store/journal.ts:entrySchema`) on their user entry, `manager.ts:splitRounds()` merges them into one group, and `Journal.finishRecord()` writes the single record from the first entry to the last. A companion activity started by a teammate's message is no round: it extends the latest same-root record (`RoundPlacement` `absorb`, memory unchanged) or writes a short `[reply]` record. Ordinals are the next number after the highest saved one and after every round the raw ledger opened before it; a rewritten record keeps its ordinal. Enforced by `tests/round-boundaries.test.ts`, `tests/round-memory.test.ts`.
- **Missing or invalid metadata keeps raw working content** and never invents verification. Records the runtime writes open with `[interrupted]` (user or Director stop), `[failed]`, `[runtime]` (completed without a usable `_FinishRound`) or `[reply]` (teammate-started activity) and list only ledger facts (changed files, last Shell exit status). Records saved with `outcome` / `verification` / `carryForward` still load: `round-memory.ts:roundMemorySchema` joins them into `summary` on read and never rewrites the file. Enforced by `tests/round-memory.test.ts`. Enforced by `tests/finish-round.test.ts`, `tests/round-memory.test.ts`.
- **Discovery pairs and the latest environment snapshot survive compaction**: original successful LoadTools pairs are retained, never fabricated or archived. Enforced by `tests/tool-disclosure-context.test.ts`.
- **Conversation language comes only from human-authored input** (`role: user`, `inputKind: human`); tool output, actor reports and Director briefings never set it. It rides the environment snapshot (`language`), so changes are `environment-change` deltas and actors share the session value. Enforced by `tests/conversation-language.test.ts`.
- **Budget estimates**: charge eager and actually expanded contracts once; exclude image base64 on full and incremental paths; an anchor is valid only for the same model, rules, tools and prefix. Enforced by `tests/tool-disclosure-context.test.ts`, `tests/context.test.ts`.
- **Titles and summaries skip persona micro-action lines**: a leading line wrapped in `（…）`, `(…)` or `【…】` never becomes a round title or opens a delivered report (`contracts.ts:titleLine`, `contracts.ts:stripLeadingActionLines`); `_FinishRound` title and summary overflow is truncated by estimated tokens, 30 and 200, with `…` (`budget.ts:truncateToTokens`). Enforced by `tests/context-titles.test.ts`.
- **Reports are not indexes**: task reports are separate full deliveries; round memory only stores them separately. Enforced by `tests/round-memory.test.ts`, `tests/finish-round.test.ts`.
- **One memory contract, one resident focus per role request**: Enforced by `tests/actor-compression-contracts.test.ts`.
- **Memory is historical data, not authority** to widen permissions or promote hypotheses to verified facts. *Unenforced* (prompt text only).

## 5. Dependencies
- **Depends on**: `src/store/journal.ts` (ledgers, sidecars), `src/runtime/` (messages, context updates), `src/tools/protocol/` (`_FinishRound`), `src/tools/discovery.ts` (discovery names), `src/prompts/` (summary and memo instructions), `src/config/` (policy schema).
- **Used by**: `src/kernel/agent.ts` (`ContextManager.prepare()` before each request), `src/application.ts` (manager construction, manual compaction), `src/actors/ensemble.ts` (round closure through `finishRecord()`), `src/store/journal.ts` (`extractRoundMemory()`).

## 6. Verification & Gaps
- Fast run: `node --test dist/tests/context*.test.js dist/tests/actor-context.test.js dist/tests/round-memory.test.js dist/tests/round-boundaries.test.js dist/tests/finish-round.test.js dist/tests/tool-disclosure-context.test.js dist/tests/actor-compression-contracts.test.js`
- Not covered offline: live vendor/model compliance for compaction and `_FinishRound`.
- Legacy summaries are conservative compatibility data; retrieve original evidence before treating claims as verified.
