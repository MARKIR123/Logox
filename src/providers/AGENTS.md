# Module: Providers & Model Dispatch (`src/providers/`)

## 1. Quick Route (核心文件导航)
- `registry.ts`: ProviderRegistry, provider resolution, capacity inference, and health `check()`.
- `model-pool.ts`: Global model pool, offline disk cache `~/.logox-ts/models-store.json`, 0ms sync hydration (`loadCacheSync()`).
- `auth.ts`: AuthStorage for `~/.logox-ts/auth.json` supporting discriminated union `api_key` and `oauth`.
- `custom-storage.ts`: CustomProviderStorage for `~/.logox-ts/custom-providers.json`.
- `oauth.ts`: OpenAI browser PKCE login on port 1455 and `refreshOpenAIToken()`.
- `transport.ts`: Undici `createHttpTransport()` with smart local proxy probing and UTF-8 BOM stripping.
- `http.ts`: Provider HTTP client, OpenAI Responses API streaming (`/v1/responses`), and thinking protocols.
- `error-format.ts`: `formatNetworkError()` and `formatDetailedError()` unwrapping cause chains.
- `model-capacities.ts`: Builtin capacities, window limits, and thinking protocol capabilities.

## 2. Invariants (刚性边界与底线)
- **OpenAI Dual-Auth Routing**:
  - API Key (`sk-...`): routed to standard OpenAI Chat Completions or Responses API.
  - ChatGPT Subscription OAuth (`chatgpt.tokens.use.direct` scope): **MUST be routed to OpenAI Responses API (`/v1/responses`)**. Direct `/v1/chat/completions` is rejected by OpenAI access enforcement with 401.
  - ChatGPT Subscription OAuth requests MUST specify `store: false` and `stream: true`.
  - Supported models for ChatGPT subscription include next-gen reasoning models (`gpt-6.1-sol`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`). Legacy models like `gpt-4o` are rejected by OpenAI Codex backend.
- **Token Auto-Refresh**: If an OAuth token expires in < 3 minutes, `settingsFor()` automatically refreshes it via `https://auth.openai.com/api/accounts/oauth/token` using the issued `clientId`.
- **Zero Raw "fetch failed"**: Network errors MUST be formatted via `formatNetworkError()`, unwrapping `ECONNREFUSED`, `TIMEOUT`, URL, and proxy details.
- **Smart Local Proxy Probing**: If configured proxy `127.0.0.1:PORT` is refused, transport auto-probes local ports `[7898, 7890, 7897, 10808, 10809]` to heal port-drift automatically.

## 3. Entry Points & Key Workflows
- **Model Selection**: `/model [actor] [model]` -> resolved synchronously via `ModelPool.snapshot()` without network query.
- **Login**: `/login` -> `LoginFlow` -> API key or OAuth PKCE on port 1455 -> saved to `~/.logox-ts/auth.json`.
- **Turn Execution**: `createProvider(settings, fetcher).respond(request, onDelta, signal)` -> SSE streaming -> tool calls & thinking deltas.

## 4. Cross-Reference (关联路标)
- Actor services & model bindings: [`../actors/AGENTS.md`](../actors/AGENTS.md)
- Configuration & thinking tiers: [`../config/`](../config/)
- Architectural rationale & design history: [`../../docs/`](../../docs/)
