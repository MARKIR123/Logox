# Module: Context Management & Compaction (`src/context/`)

## 1. Scope
- **Owns**: Context window estimation, dual-watermark round compaction, tool payload disk archiving, four-pillar English summary contracts, token expenditure metering (`TokenMeter`, `UsageLedger`).
- **Does not own**: Raw message journal persistence (owned by `src/store/journal.ts`), activity lifecycle state (owned by `src/runtime/`).

## 2. Start Here (Task Router)
| If investigating... | Start at... | Then check... |
|---|---|---|
| Compaction triggers too early/late | `budget.ts:watermarks()` | Capacity window and `reserve_tokens` |
| Actor forgets past round results | `manager.ts:projected()` | Actor retention policy (`keep_recent_rounds`) |
| Corrupted context view on restart | `manager.ts:prepare()` | Source hashes and archived tool payloads in `journal.ts` |
| Heavy tool payload archiving | `manager.ts:archiveTools()` | Token threshold in `estimateText()` (>= 256 tokens) |
| Round summary schema violations | `contracts.ts:summaryInstruction` | Four-pillar punch list constraints |

## 3. Hard Boundaries
- **Non-Destructive Compaction**: Compaction folds message projections and archives heavy payloads to disk; it MUST NEVER mutate or delete raw journal entries.
- **Four-Pillar English Punch List**: Round summaries must strictly conform to the 4-pillar punch list under 250 words (`Exports & Changes`, `Decisions & Boundaries`, `Verification`, `Missing/Next`). Zero narrative reasoning recounts.
- **Tool Pairing Integrity**: Normalized projections must preserve valid tool call and result pairing; pruning must never produce orphaned tool results.

## 4. Integration Points
```text
application.ts (instantiates ContextManager)
  → kernel/agent.ts (calls prepare() prior to model dispatch)
  → actors/ensemble.ts (calls taskEnd() upon activity completion)
  → store/journal.ts (persists context state and tool archive artifacts)
```

## 5. Verification
- **Targeted Test Suite**:
  - `tests/context.test.ts`: Projections, archiving, watermark triggers, long tasks.
  - `tests/context-extra.test.ts`: Manual compaction and provider-specific boundaries.
  - `tests/actor-context.test.ts`: Actor retention divergence and task closure.
- **Fast Run Command**:
  ```bash
  node --test dist/tests/context*.test.js dist/tests/actor-context.test.js
  ```
