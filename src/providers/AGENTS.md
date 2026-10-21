# Module: Providers & Model Dispatch (`src/providers/`)

## 1. Scope
- **Owns**: Provider registry, model pool cache (`~/.logox-ts/models-store.json`), Undici HTTP transport with local proxy auto-probing, authentication storage (`~/.logox-ts/auth.json`), OpenAI Responses API streaming, and network error unwrapping.
- **Does not own**: Higher-level model picker UI (owned by `src/application.ts` and `src/tui/`).

## 2. Start Here (Task Router)
| If investigating... | Start at... | Then check... |
|---|---|---|
| Model selection, discovery, or offline cache | `model-pool.ts:ModelPool` | `~/.logox-ts/models-store.json` |
| Connection drops, proxy timeout, or TLS errors | `transport.ts:createHttpTransport()` | `error-format.ts:formatNetworkError()` |
| ChatGPT OAuth login or token auto-refresh | `oauth.ts:refreshOpenAIToken()` | `auth.ts:AuthStorage` (`~/.logox-ts/auth.json`) |
| Streaming SSE parsing or Responses API | `http.ts:createProvider()` | `responsesInput()` and event parsing loops |
| Model capacity, context windows, or thinking protocols | `registry.ts:capacity()` | `model-capacities.ts` and `src/config/config.ts` |

## 3. Hard Boundaries
- **OpenAI Dual-Auth Routing**:
  - API Key (`sk-...`): routed to standard OpenAI Chat Completions or Responses API.
  - ChatGPT Subscription OAuth (`chatgpt.tokens.use.direct` scope): **MUST be routed to OpenAI Responses API (`/v1/responses`)** with `store: false` and `stream: true`. Never downgrade to non-streaming.
- **Zero Raw "fetch failed"**: Network errors MUST be formatted via `formatNetworkError()`, unwrapping cause chains (`ECONNREFUSED`, `TIMEOUT`, proxy port).
- **Smart Local Proxy Probing**: If configured proxy port is refused, transport auto-probes local ports `[7898, 7890, 7897, 10808, 10809]` to heal port-drift automatically.

## 4. Integration Points
```text
application.ts (binds ProviderRegistry & ModelPool)
  → kernel/agent.ts (invokes provider.respond() per turn)
  → providers/http.ts (manages SSE event stream & tool calls)
  → providers/transport.ts (manages Undici connections & proxy fallback)
```

## 5. Verification
- **Targeted Test Suite**:
  - `tests/providers.test.ts`: SSE streaming, connection checks, Responses API.
  - `tests/provider-recovery.test.ts`: Transient network interruption and retry recovery.
  - `tests/model-preferences-usage.test.ts`: Model preferences, thinking effort tiers, and usage ledgers.
- **Fast Run Command**:
  ```bash
  node --test dist/tests/providers*.test.js dist/tests/provider-*.test.js dist/tests/model-preferences-usage.test.js
  ```
