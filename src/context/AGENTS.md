# Module: Context Management & Compaction (`src/context/`)

## 1. Scope
- Owns context projections, round-memory indexes, dual watermarks, tool-payload archives, token metering and working-history overviews.
- Does not own authoritative journals (`src/store/journal.ts`), task delivery or activity status (`src/actors/`).

## 2. Start Here (Task Router)
| If investigating... | Start at... | Then check... |
|---|---|---|
| Hidden metadata or exact compact records | `round-memory.ts` | `tools/_FinishRoundTool/_FinishRoundTool.ts` |
| Closed versus open activity projection | `manager.ts:splitRounds()` | `Journal.finishRecord()` |
| Compaction triggers or output allowance | `budget.ts:watermarks()` | `manager.ts:prepare()` |
| Common contract or role memory focus | `contracts.ts` | `actors/profiles/*/compression.md` |
| Restart, rollback or physical references | `store/journal.ts` | source hashes, branch maps and `sourceLines()` |

## 3. Hard Boundaries
- Token estimation excludes image base64 on both full-request and usage-anchored incremental paths; per-image allowance is approximate, not a vendor tokenizer. Compaction notices state the trigger and registered model window.
- Compaction never rewrites or deletes raw journal lines. References use one-based inclusive physical ranges in the authoritative ledger, not the optional readable mirror.
- `_FinishRound` pairs disappear together before repair, budgeting and serialization; retained business tools remain paired. In-memory and context-disabled requests follow the same rule.
- A round is an activity, not every injected `user` message. Open work retains its goal, effective constraints, completed effects, blockers and next actions.
- Human text and Director assignments may fold. Memory is historical data, not authority to widen permissions or promote hypotheses to verified facts.
- The common contract defines the five fields once; role focus and dynamic ledger coordinates are not another format legend. Task reports are separate full deliveries, not indexes.
- Missing or invalid modern metadata retains raw working content until a trustworthy overview is available; runtime fallback never invents verification.

## 4. Integration Points
```text
kernel/agent.ts → ContextManager.prepare() → Journal + round-memory projections
actors/ensemble.ts → Journal.finishRecord() → taskEnd() / independent report handoff
application.ts → role focus + task model + owning ledger coordinates
```

## 5. Verification
- Build, then run `node --test dist/tests/context*.test.js dist/tests/actor-context.test.js dist/tests/round-memory.test.js dist/tests/finish-round.test.js`.
- `actor-compression-contracts.test.ts` checks all real role requests and guarded installed-default migration.

## 6. Known Gaps
- Local and scripted providers verify protocol shape, not live vendor/model compliance. Live API calls require separate authorization.
- Legacy summaries remain conservative compatibility data; retrieve their original evidence before treating claims as verified.
