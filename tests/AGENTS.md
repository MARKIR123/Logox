# Test Suite Navigation & Verification Map (`tests/`)

This document guides AI agents on test taxonomy, domain-specific test groups, and rapid verification workflows.
Instead of running the entire 380+ test suite, run the targeted group command for the subsystem you modified.

---

## 1. Domain Test Groups & Fast Verification Commands

| Subsystem Domain | Targeted Test Files | Fast Run Command (~1-3s) |
|---|---|---|
| **Context & Compaction** | `context.test.ts`<br>`context-extra.test.ts`<br>`actor-context.test.ts` | `node --test dist/tests/context*.test.js dist/tests/actor-context.test.js` |
| **Providers & Network** | `providers.test.ts`<br>`provider-lifecycle.test.ts`<br>`provider-recovery.test.ts`<br>`network-transport.test.ts`<br>`openai-provider.test.ts`<br>`model-preferences-usage.test.ts` | `node --test dist/tests/providers*.test.js dist/tests/provider-*.test.js dist/tests/network-*.test.js dist/tests/openai-*.test.js dist/tests/model-preferences-usage.test.js` |
| **Actors & Ensemble** | `ensemble.test.ts`<br>`actor-definitions.test.ts`<br>`actor-collaboration*.test.ts`<br>`actor-recovery.test.ts`<br>`actors-integration.test.ts`<br>`task-models.test.ts`<br>`task-progress.test.ts` | `node --test dist/tests/actor*.test.js dist/tests/ensemble.test.js dist/tests/task-*.test.js` |
| **Tools & Execution** | `tools-claude-alignment.test.ts`<br>`subagent-efficiency-vision.test.ts` | `node --test dist/tests/tools-*.test.js dist/tests/subagent-efficiency-vision.test.js` |
| **Permissions & Sandbox** | `permissions.test.ts`<br>`permission-modes.test.ts`<br>`creative-reading.test.ts` | `node --test dist/tests/permission*.test.js dist/tests/creative-reading.test.js` |
| **Terminal UI (TUI)** | `tui*.test.tsx`<br>`terminal*.test.tsx`<br>`stage*.test.ts`<br>`thinking-groups.test.ts`<br>`app.test.tsx`<br>`command-panels.test.tsx` | `node --test dist/tests/tui*.test.js dist/tests/terminal*.test.js dist/tests/stage*.test.js dist/tests/thinking-groups.test.js` |
| **Sessions & Leases** | `sessions.test.ts`<br>`session-leases.test.ts`<br>`session-lifecycle.test.ts`<br>`session-integration.test.ts`<br>`state-file-lock.test.ts` | `node --test dist/tests/session*.test.js dist/tests/state-file-lock.test.js` |
| **Resources & Skills** | `resources.test.ts`<br>`hierarchical-skills.test.ts`<br>`extensions.test.ts`<br>`docs.test.ts` | `node --test dist/tests/resources.test.js dist/tests/hierarchical-skills.test.js dist/tests/extensions.test.js` |

---

## 2. Full Regression & Check Commands

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

## 3. Test Invariants & Authoring Rules

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
