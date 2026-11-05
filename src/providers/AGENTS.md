# Module: Providers & Model Dispatch (`src/providers/`)

## 1. Scope
- **Owns**: `ProviderRegistry` (selection, per-request auth, capacity), `createProvider()` wire encoding and streaming for OpenAI Chat, OpenAI Responses and Anthropic Messages, the Undici transport with proxy handling, `ModelPool` discovery cache, the per-endpoint AIMD request gate (`request-gate.ts`), `AuthStorage` / `CustomProviderStorage`, OpenAI OAuth, native tool-disclosure codecs (`disclosure/`), and network error formatting.
- **Does not own**: Provider presets, `modelSettings()` and thinking-protocol inference (`src/config/config.ts`, see [`src/config/AGENTS.md`](../config/AGENTS.md)); retry budgeting and recovery policy (`src/kernel/agent.ts`, `src/actors/recovery.ts`); the model picker and login panels (`src/tui/`, `src/application.ts`); tool metadata and the deferred directory ([`src/tools/AGENTS.md`](../tools/AGENTS.md)).
- **Design rationale**: [docs/modules/task-models.md](../../docs/modules/task-models.md) (model selection and switching); [docs/USAGE.md](../../docs/USAGE.md) (providers, network, tool discovery).

## 2. Start Here
| If you need to... | Start at | Then check |
|---|---|---|
| Change what is sent to a model or how a stream is parsed | `http.ts:createProvider()` | `http.ts:openaiMessages()`, `http.ts:anthropicMessages()`, `http.ts:responsesInput()` |
| Classify an HTTP or transport failure | `http.ts:providerFailure()` | `http.ts:isProviderInterruption()`, `http.ts:ProviderError` |
| Limit concurrent requests or slow down on HTTP 429/529 | `request-gate.ts:RequestGate` | `registry.ts:ProviderRegistry.gateFor()`, `http.ts:isRateLimitFailure()`, `http.ts:parseRetryAfter()` |
| Fix connection drops, proxy or TLS | `transport.ts:createHttpTransport()` | `error-format.ts:formatNetworkError()` |
| Resolve context window or max output | `registry.ts:ProviderRegistry.capacity()` | `model-capacities.ts:modelCapacities` |
| Resolve credentials, switch provider, list models | `registry.ts:ProviderRegistry.select()` | `registry.ts:ProviderRegistry.modelsFor()`, `auth.ts:AuthStorage` |
| Model list cache and shorthand | `model-pool.ts:ModelPool` | `~/.logox/models-store.json` |
| ChatGPT OAuth login or refresh | `oauth.ts:startOpenAiOAuth()` | `oauth.ts:refreshOpenAIToken()`, `login.ts:LoginFlow` |
| Custom endpoints or importing external credentials | `custom-storage.ts:CustomProviderStorage` | `credential-import.ts`, `registry.ts:ProviderRegistry.syncCustom()` |
| Native tool disclosure support | `capabilities.ts:resolveProviderCapabilities()` | `disclosure/anthropic.ts`, `disclosure/openai.ts`, `registry.ts:ProviderRegistry.provider()` |
| Token usage fields per vendor | `http.ts:createProvider()` (usage schema near `cache_read_input_tokens`) | `src/context/usage.ts` |

## 3. Common Changes
### Add a built-in provider preset
1. Add an entry to `src/config/config.ts:presets` (`kind`, `base_url`, optional `api_key_env`). `ProviderRegistry.names()` and the login catalog in `src/application.ts` read `presets`, so no registry change is needed.
2. If it needs a default model or a thinking protocol, extend `modelSettings()` in `src/config/config.ts` (protocol inference must match `kind`, or it throws).
3. Add known windows to `model-capacities.ts:baseCapacities` (key `<provider>/<model>`; `openai-compatible/*` entries are mirrored to `openai/*`).
4. List it in the provider table of `docs/USAGE.md` and in `config.example.toml` if it has user-facing keys.
- Tests: `tests/providers.test.ts` (antigravity preset case), `tests/openai-provider.test.ts`, `tests/config.test.ts`.

### Add or correct a model's capacity
1. Edit `model-capacities.ts:baseCapacities` with `{window, maxOutput}`.
2. Precedence in `ProviderRegistry.capacity()` is `[provider]` config, then `[models."provider/model"]`, then live metadata learned by `modelsFor()`, then built-in table, then name heuristics. Users override without code changes.
- Tests: `tests/providers.test.ts`, `tests/context.test.ts` (capacity consumers).

### Change a network error or retry notice
1. User-visible transport text comes from `http.ts:transportFailure()` (`[Network] ...` titles, code table `transportReasons`) and `error-format.ts:formatNetworkError()`; keep it one short English line.
2. The retry notice is emitted in `src/application.ts` (`retryProvider`) and `src/kernel/agent.ts` (`context.report('Network retry', ...)`); the budget is `kernel.max_retries` in `src/config/config.ts`.
3. Whether an error is retried is decided by `http.ts:isProviderInterruption()` (temporary errors in `connection` or `stream` phase) and `ProviderError.category`; quota, auth and protocol errors must not be retried blindly.
- Tests: `tests/error-format.test.ts`, `tests/provider-recovery.test.ts`, `tests/network-recovery.test.ts`, `tests/providers.test.ts`.

### Allow native tool disclosure for a model
1. Add the exact model id to `capabilities.ts:anthropicModels` (official `https://api.anthropic.com/v1` only), or adjust the Responses condition for OpenAI OAuth. Users on other endpoints opt in with `tool_discovery`.
2. Change codecs only in `disclosure/anthropic.ts` or `disclosure/openai.ts`; the `LoadTools` wire shape stays in `createProvider()`.
- Tests: `tests/anthropic-tool-disclosure.test.ts`, `tests/openai-tool-disclosure.test.ts`.

## 4. Hard Boundaries
- **ChatGPT OAuth always uses streaming Responses** (`/responses`, `store: false`, `stream: true`); API-key auto mode keeps Chat Completions and is not switched to Responses to gain discovery. Enforced by `tests/openai-tool-disclosure.test.ts` and `tests/providers.test.ts` (Responses stays streaming).
- **Reasoning reaches the store as thinking**: Responses requests add `reasoning.summary: 'auto'` only on the official `https://api.openai.com/v1` endpoint (gateways may reject it); `response.reasoning_summary_text.delta`, reasoning items in `output_item.done` / non-streaming output, and Chat `reasoning_content` / `reasoning` / `thinking` / `reasoning_details` are all parsed. Enforced by `tests/openai-provider.test.ts`.
- **Native discovery requires an exact official endpoint and model, or an explicit `tool_discovery`**; unknown compatible endpoints stay ordinary tools and no capability probe is sent. *Unenforced*.
- **Native identity is never invented**: Responses client search keeps the original `call_id`; malformed, duplicate or incomplete search identities are protocol errors; truncated batches execute no tools. Enforced by `tests/openai-tool-disclosure.test.ts`, `tests/anthropic-tool-disclosure.test.ts`.
- **Usage accounting differs per vendor**: Anthropic total input = uncached + cache-read + cache-created; OpenAI `input_tokens` already includes cached input. Enforced by `tests/anthropic-tool-disclosure.test.ts`, `tests/model-preferences-usage.test.ts`. Fixtures do not prove remote cache hits.
- **Network failures never surface raw `fetch failed`**: causes are unwrapped to a public code (`ECONNREFUSED`, timeout, DNS) and request data is not echoed. Enforced by `tests/error-format.test.ts`, `tests/providers.test.ts`.
- **Credentials are read at request time and never stored in selection data**: switching provider clears the old endpoint and auth. Enforced by `tests/providers.test.ts`, `tests/provider-lifecycle.test.ts`.
- **Every model `respond` goes through one `RequestGate` per normalized base URL** (shared with `candidate()` registries; max 16 in flight, halved on 429/529/`rate_limit_error`/`overloaded_error`, never retries, keyed without credentials). `check()` and `/models` listing bypass it. Rate-limit errors carry `diagnostic.status` and optional `diagnostic.retryAfterMs`. Enforced by `tests/provider-request-gate.test.ts`.
- **Local proxy auto-probe**: when the configured proxy port refuses, `transport.ts` probes `7898, 7890, 7897, 10808, 10809` on `127.0.0.1`. *Unenforced*.
- **The transport never modifies global fetch, dispatcher or environment**: *Unenforced*.

## 5. Dependencies
- **Depends on**: `src/config/` (`modelSettings()`, `presets`, thinking effort types), `src/runtime/` (`Provider`, `ModelMessage`, runtime context codecs), `src/context/` (`ModelCapacity`), `src/tools/protocol/LoadToolsTool/prompt.ts` (disclosure wording), `undici`.
- **Used by**: `src/application.ts` (registry, pool, login catalog), `src/kernel/agent.ts` (`provider.respond()` per round), `src/actors/` (task models, recovery, management), `src/tui/login/` (login flow), `src/cli.tsx` (`--list-models`, `--check-config`).

## 6. Verification & Gaps
- Fast run: `node --test dist/tests/providers.test.js dist/tests/provider-*.test.js dist/tests/openai-*.test.js dist/tests/anthropic-tool-disclosure.test.js dist/tests/network-*.test.js dist/tests/error-format.test.js dist/tests/model-pool.test.js dist/tests/model-preferences-usage.test.js dist/tests/oauth-login.test.js dist/tests/custom-storage.test.js dist/tests/credential-import.test.js`
- Not covered offline: live vendor streaming and prompt-cache hits; DeepSeek reasoning effort behavior; interactive OAuth in a real browser; real proxy port drift.
- Auto allowlists are intentionally conservative; unlisted compatible models need explicit `tool_discovery`.
