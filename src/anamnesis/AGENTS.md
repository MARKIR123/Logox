# Module: Anamnesis (`src/anamnesis/`)

## 1. Scope
- **Owns**: The idle lifecycle and single-flight rule (`service.ts:Anamnesis`), what one run does (`runner.ts:AnamnesisRunner`), the transcript and new-material rules (`transcript.ts`), watermarks (`watermark.ts:WatermarkStore`), memory records (`memory.ts:MemoryStore`), dream operations (`operations.ts:applyOperations()`), model resolution (`model.ts:resolveModel()`) and the two run prompts (`prompts.ts`).
- **Does not own**: The memory prompt section text (`../prompts/memory.ts:MEMORY_SECTION`); the wiring, switches and interval (`../app/anamnesis.ts:createAnamnesis()`); the card drawing ([`src/tui/AGENTS.md`](../tui/AGENTS.md)); the write exemption for memory folders ([`src/permissions/AGENTS.md`](../permissions/AGENTS.md)); usage metering ([`src/context/AGENTS.md`](../context/AGENTS.md)).
- **Design rationale**: [docs/USAGE.md](../../docs/USAGE.md) (Anamnesis section), [docs/modules/README.md](../../docs/modules/README.md).

## 2. Start Here
| If you need to... | Start at | Then check |
|---|---|---|
| Change when a recap or dream starts | `service.ts:Anamnesis.tick()` | `../app/anamnesis.ts:createAnamnesis()` (thresholds, switches, interval) |
| Change what the model reads | `transcript.ts:buildTranscript()` | `runner.ts:recapMessage()`, `runner.ts:dreamMessage()` |
| Change a prompt | `prompts.ts:RECAP_SYSTEM_PROMPT` | `prompts.ts:DREAM_SYSTEM_PROMPT` |
| Change how a dream answer is applied | `operations.ts:applyOperations()` | `operations.ts:looksSecret()`, `memory.ts:memoryRecordSchema` |
| Change the card text | `service.ts:RUNNING_STAGE` | `operations.ts:dreamStage()`, `runner.ts:splitRecap()` |
| Change the model rule | `model.ts:resolveModel()` | `../actors/actor-models-storage.ts` |
| Call it from a command page | `../app/anamnesis.ts:createAnamnesis()` (`api`) | `../application.ts` (`anamnesis`) |
| Change `/anamnesis` (arguments, rows, values, record list and page, model picker) | `../commands/anamnesis-page.ts:createAnamnesisCommand()` | `../app/submit.ts` (the `/anamnesis` branch), `../commands.ts:commandCatalog`, `tests/anamnesis-command.test.tsx` |

## 3. Common Changes
### Add an operation kind to the dream
1. Extend `operations.ts:operationSchema`, apply it in `applyOperations()` and describe it in `prompts.ts:DREAM_SYSTEM_PROMPT` (prompt text is cache-irrelevant here).
2. Show it in `operations.ts:dreamDetail()`.
- Tests: `tests/anamnesis-memory.test.ts`, `tests/anamnesis-runner.test.ts`.

## 4. Hard Boundaries
- **A run applies nothing until the model answered, and an aborted run applies nothing**: user activity aborts it and removes its card (the next idle period starts a fresh run with a fresh card; a close does the same); memory writes (each atomic) and the watermark come after the answer. Enforced by `tests/anamnesis-runner.test.ts`, `tests/anamnesis.test.ts`.
- **One run at a time, never while the foreground works**; `runNow` refuses with an error, the automatic trigger waits. A failed run is not retried before the next idle period. Enforced by `tests/anamnesis.test.ts`.
- **Watermarks live beside the journals** (`state/sessions/<sessionId>/anamnesis.json`), one per kind; a restart does not review covered material and an unreadable answer does not move them. Enforced by `tests/anamnesis-runner.test.ts`.
- **Model answers are data**: at most 6 operations, invalid ones and anything that looks like a secret are dropped, a `user` record always goes to the user folder, a missing record is never deleted. Enforced by `tests/anamnesis-memory.test.ts`.
- **No silent model substitution**: a binding whose provider is gone or has no credentials fails with `Anamnesis has no usable model (<provider>/<model>). Choose one under /anamnesis.`; the id `anamnesis` is a binding key, never an actor. Enforced by `tests/anamnesis-runner.test.ts`, `tests/anamnesis-app.test.ts`.
- **The prompt section is read once per session and on `/reload`**, so records saved mid-session do not change the prompt prefix. Enforced by `tests/anamnesis-app.test.ts`.
- **`/anamnesis` is built from the existing surfaces**: rows are a picker (`current` empty, `focus` keeps the row just changed), the record list is a picker whose rows take two lines (`PickerItem.detail`), a record is a page whose tab carries `actions` (`d` and the footer) and uses the page confirmation, and Esc goes back one level through `CommandSurfaces.openPicker`'s `back` argument and `PageActions.onBack`. Opening the page is a submit, so it stops a run in flight. Enforced by `tests/anamnesis-command.test.tsx`.
- **An automatic dream with nothing to save leaves no card**; the card is placed by `createdAt`. Enforced by `tests/anamnesis.test.ts`, `tests/stage-anamnesis.test.ts`.

## 5. Dependencies
- **Depends on**: `src/runtime/` (store, activities), `src/store/journal.ts`, `src/config/model-preferences.ts` (`StateFile`), `src/actors/actor-models-storage.ts`, `src/providers/registry.ts`.
- **Used by**: `src/app/anamnesis.ts`, `src/application.ts`, `src/demo.ts`.

## 6. Verification & Gaps
- Fast run: `node --test dist/tests/anamnesis*.test.js dist/tests/stage-anamnesis.test.js`
- Also: `node --test dist/tests/anamnesis-command.test.js` for the `/anamnesis` page (keyboard and mouse).
- Not covered offline: the quality of real recaps and dreams, live provider behaviour with an effort on the binding.
