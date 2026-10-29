# Test Suite Navigation & Verification Map (`tests/`)

## 1. Scope

This signpost routes verification for runtime, tool UI, providers, actors and storage. Use targeted groups while implementing, then run full regression before completion.

## 2. Start Here (Task Router)

| Subsystem Domain | Targeted Test Files | Fast Run Command (~1-3s) |
|---|---|---|
| **Context & Compaction** | `context.test.ts`<br>`context-extra.test.ts`<br>`actor-context.test.ts` | `node --test dist/tests/context*.test.js dist/tests/actor-context.test.js` |
| **Providers & Network** | `providers.test.ts`<br>`provider-lifecycle.test.ts`<br>`provider-recovery.test.ts`<br>`network-transport.test.ts`<br>`openai-provider.test.ts`<br>`model-preferences-usage.test.ts` | `node --test dist/tests/providers*.test.js dist/tests/provider-*.test.js dist/tests/network-*.test.js dist/tests/openai-*.test.js dist/tests/model-preferences-usage.test.js` |
| **Actors & Ensemble** | `ensemble.test.ts`<br>`actor-definitions.test.ts`<br>`actor-collaboration*.test.ts`<br>`actor-recovery.test.ts`<br>`actors-integration.test.ts`<br>`task-models.test.ts`<br>`task-progress.test.ts`<br>`progress-lifecycle.test.ts`<br>`message-delivery.test.ts`<br>`human-input-delivery.test.ts`<br>`director-coordination.test.ts`<br>`director-facts.test.ts` | `node --test dist/tests/actor*.test.js dist/tests/ensemble.test.js dist/tests/task-*.test.js dist/tests/progress-lifecycle.test.js dist/tests/*delivery.test.js dist/tests/director-*.test.js` |
| **Tools & Execution** | `tools-claude-alignment.test.ts`<br>`tool-contract-accuracy.test.ts`<br>`subagent-efficiency-vision.test.ts` | `node --test dist/tests/tools-*.test.js dist/tests/tool-contract-accuracy.test.js dist/tests/subagent-efficiency-vision.test.js` |
| **Permissions & Sandbox** | `permissions.test.ts`<br>`permission-modes.test.ts`<br>`creative-reading.test.ts` | `node --test dist/tests/permission*.test.js dist/tests/creative-reading.test.js` |
| **Terminal UI (TUI)** | `tui*.test.tsx`<br>`terminal*.test.tsx`<br>`stage*.test.ts`<br>`thinking-groups.test.ts`<br>`app.test.tsx`<br>`command-panels.test.tsx`<br>`input-queue-ui.test.tsx` | `node --test dist/tests/tui*.test.js dist/tests/terminal*.test.js dist/tests/stage*.test.js dist/tests/thinking-groups.test.js dist/tests/input-queue-ui.test.js` |
| **Sessions & Leases** | `sessions.test.ts`<br>`session-leases.test.ts`<br>`session-lifecycle.test.ts`<br>`session-integration.test.ts`<br>`state-file-lock.test.ts` | `node --test dist/tests/session*.test.js dist/tests/state-file-lock.test.js` |
| **Resources & Skills** | `resources.test.ts`<br>`hierarchical-skills.test.ts`<br>`extensions.test.ts` | `node --test dist/tests/resources.test.js dist/tests/hierarchical-skills.test.js dist/tests/extensions.test.js` |
| **Prompt & Native Disclosure** | `prompt-disclosure-integration.test.ts`<br>`tool-disclosure-context.test.ts`<br>`runtime-context-updates.test.ts`<br>`anthropic-tool-disclosure.test.ts`<br>`openai-tool-disclosure.test.ts` | `node --test dist/tests/*disclosure*.test.js dist/tests/runtime-context-updates.test.js` |
| **Prompts & Documentation** | `prompt-architecture.test.ts`<br>`prompts.test.ts`<br>`docs.test.ts`<br>`actor-compression-contracts.test.ts` | `node --test dist/tests/prompt-architecture.test.js dist/tests/prompts.test.js dist/tests/docs.test.js dist/tests/actor-compression-contracts.test.js` |

---

## 3. Hard Boundaries

- Isolate homes and credentials; fake/local providers only. No API credits are spent implicitly.
- Ephemeral files belong in isolated temporary roots with deterministic cleanup. Servers use dynamic ports.
- Delivery regressions inspect actual provider requests and persisted receipts, not only queue/card creation. Exercise pending admission, finalizer sealing, context preparation, retry, stale targets, broadcasts after stop and preserved root budgets.
- Raw journals remain append-only. Tests must distinguish authoritative records from UI and model projections.
- Production finalizer enforcement is never weakened for fixtures; `runtime-fixture.ts` adapts only legacy successful scripted turns. Raw lifecycle and wire tests bypass it.

## 4. Integration Points

- Build emits executable tests under `dist/tests/` and distribution assets without touching user homes.
- `finish-round.test.ts`, `round-memory.test.ts`, `tool-ui.test.ts`, and `actor-compression-contracts.test.ts` cover terminal closure, indexes, visibility, and safe installed defaults.

## 5. Verification

- **Fast Multi-Threaded Test Suite**:
  ```bash
  node --test --test-concurrency=4 dist/tests/*.test.js
  ```
- **Typecheck & Documentation Integrity Check**:
  ```bash
  npm run check
  ```
- **Build TypeScript & Copy Actor Profiles**:
  ```bash
  npm run build
  ```

---

### Test Authoring Rules

1. **Home Directory Sandbox Isolation**:
   - Tests that invoke `loadConfig()` or `createApplication()` MUST pass `resourceOptions: {home: tempCwd, boundary: tempCwd}`.
   - Never allow tests to read or mutate the real user's `~/.logox-ts/` or `~/.logox/`.
2. **Ephemeral Directory Cleanup**:
   - Always create isolated test roots using `mkdtemp(join(tmpdir(), 'logox-test-'))`.
   - Wrap cleanup in `finally { await rm(tempCwd, {recursive: true, force: true}); }`.
3. **No Hardcoded Server Ports**:
   - Always bind test HTTP servers to dynamic ports using `server.listen(0, '127.0.0.1')` to prevent EADDRINUSE collisions during parallel execution.
4. **Deterministic Teardown**:
   - In `finally` blocks, close all HTTP servers (`server.closeAllConnections(); server.close()`) and kill spawned child processes to avoid hanging test runners.

## 6. Known Gaps

- Live provider/model compliance and real-terminal visual acceptance require separate authorized runs. A passing fixture suite does not certify them.
