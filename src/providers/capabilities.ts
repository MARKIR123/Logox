import type {ModelSettings} from '../config/config.js';
import type {ProviderCapabilities} from '../runtime/messages.js';

export const FALLBACK_CAPABILITIES: ProviderCapabilities = Object.freeze({toolDiscovery: 'none', runtimeInstructions: 'meta-user', caching: 'none'});
// Exact official endpoint/model allowlist; unknown aliases and compatible proxies require an explicit assertion.
// Source (checked 2026-10-26): https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool
const anthropicModels = new Set(['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-5-5', 'claude-sonnet-5-5']);
export function resolveProviderCapabilities(settings: ModelSettings): ProviderCapabilities {
  const declared = settings.toolDiscovery ?? 'auto';
  if (declared === 'anthropic' && settings.kind !== 'anthropic') throw new Error('Anthropic tool discovery requires the Anthropic message protocol.');
  if (declared === 'openai-responses' && settings.kind !== 'openai_compat') throw new Error('OpenAI Responses discovery requires the OpenAI protocol.');
  const official = settings.baseUrl.replace(/\/$/, '') === 'https://api.anthropic.com/v1';
  // API-key auto mode must not change Chat routing to obtain discovery.
  // https://developers.openai.com/api/docs/guides/tools-tool-search: gpt-5.4+ on Responses.
  const responses = settings.baseUrl.replace(/\/$/, '') === 'https://api.openai.com/v1' &&
    (settings.key.startsWith('eyJ') || settings.key.startsWith('oauth-')) && settings.model === 'gpt-5.4';
  const toolDiscovery = declared === 'auto' ? official && settings.kind === 'anthropic' && anthropicModels.has(settings.model) ? 'anthropic'
    : responses && settings.kind === 'openai_compat' ? 'openai-responses' : 'none' : declared;
  return {toolDiscovery, runtimeInstructions: 'meta-user', caching: settings.kind === 'anthropic' && (official || declared === 'anthropic') ? 'anthropic' : 'none'};
}
