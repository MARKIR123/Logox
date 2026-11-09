import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadConfig, modelSettings, matchesModelPattern} from '../src/config/config.js';
import {createProvider, openaiMessages} from '../src/providers/http.js';
import {resolveProviderCapabilities} from '../src/providers/capabilities.js';
import {ProviderRegistry} from '../src/providers/registry.js';
import {AuthStorage} from '../src/providers/auth.js';

async function settingsFor(provider: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'logox-kinds-'));
  try {
    const config = await loadConfig(root, {provider, ...extra}, {}, root, root);
    return {config, settings: modelSettings(config, {})};
  } finally {await rm(root, {recursive: true, force: true});}
}
const sse = (events: unknown[]) => events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('');

test('model_kinds: the antigravity preset routes claude-* to Anthropic, other models stay OpenAI-compatible', async () => {
  const claude = (await settingsFor({name: 'antigravity', model: 'claude-opus-5-5-medium'})).settings;
  assert.equal(claude.kind, 'anthropic');
  assert.equal(claude.providerKind, 'openai_compat');
  assert.equal(claude.thinkingProtocol, 'anthropic-adaptive');
  assert.ok(claude.thinkingLevels?.includes('max'));
  const gemini = (await settingsFor({name: 'antigravity', model: 'gemini-3.8-flash-high'})).settings;
  assert.equal(gemini.kind, 'openai_compat');
  assert.equal(gemini.thinkingProtocol, 'reasoning-effort');
  assert.equal((await settingsFor({name: 'antigravity', model: 'CLAUDE-sonnet-4-6'})).settings.kind, 'anthropic', 'patterns ignore case');
  assert.ok(matchesModelPattern('claude-*', 'claude-x') && !matchesModelPattern('claude-*', 'x-claude-x') && matchesModelPattern('a.b', 'a.b') && !matchesModelPattern('a.b', 'axb'));
});

test('model_kinds: user config overrides the preset; a pinned kind or a foreign endpoint disables the preset route', async () => {
  assert.equal((await settingsFor({name: 'antigravity', model: 'claude-opus-5-5', model_kinds: {}})).settings.kind, 'openai_compat', 'empty table opts out');
  assert.equal((await settingsFor({name: 'antigravity', model: 'gemini-x', model_kinds: {'gemini-*': 'anthropic'}})).settings.kind, 'anthropic');
  assert.equal((await settingsFor({name: 'antigravity', model: 'claude-opus-5-5', kind: 'openai_compat'})).settings.kind, 'openai_compat', 'explicit kind pins the provider');
  assert.equal((await settingsFor({name: 'antigravity', model: 'claude-opus-5-5', base_url: 'http://example.test/v1'})).settings.kind, 'openai_compat', 'preset route is for the preset endpoint');
  const work = {providers: {work: {kind: 'openai_compat', base_url: 'http://127.0.0.1:9/v1', model_kinds: {'claude-*': 'anthropic'}}}};
  assert.equal((await settingsFor({name: 'work', model: 'claude-3'}, work)).settings.kind, 'anthropic');
  assert.equal((await settingsFor({name: 'work', model: 'other'}, work)).settings.kind, 'openai_compat');
  assert.equal((await settingsFor({name: 'deepseek', model: 'claude-x'})).settings.kind, 'openai_compat', 'other presets are unaffected');
});

test('model_kinds: capabilities follow the resolved kind', async () => {
  const claude = resolveProviderCapabilities((await settingsFor({name: 'antigravity', model: 'claude-opus-5-5'})).settings);
  assert.equal(claude.caching, 'anthropic');
  assert.equal(claude.appendOnlyHistory, true);
  const gemini = resolveProviderCapabilities((await settingsFor({name: 'antigravity', model: 'gemini-3.8-flash'})).settings);
  assert.equal(gemini.caching, 'none');
  assert.equal(gemini.appendOnlyHistory, undefined);
});

test('model_kinds: requests hit /messages with an Anthropic body for claude and /chat/completions for gemini', async () => {
  const seen: Array<{url: string; headers: Record<string, string>; body: Record<string, unknown>}> = [];
  const fetcher: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    seen.push({url: String(url), headers: init?.headers as Record<string, string>, body});
    if (String(url).endsWith('/messages')) return new Response(sse([
      {type: 'message_start', message: {usage: {input_tokens: 10, cache_read_input_tokens: 4, cache_creation_input_tokens: 2}}},
      {type: 'content_block_start', index: 0, content_block: {type: 'thinking', thinking: ''}},
      {type: 'content_block_delta', index: 0, delta: {type: 'thinking_delta', thinking: 'plan'}},
      {type: 'content_block_delta', index: 0, delta: {type: 'signature_delta', signature: 'sig-1'}},
      {type: 'content_block_start', index: 1, content_block: {type: 'text', text: ''}},
      {type: 'content_block_delta', index: 1, delta: {type: 'text_delta', text: 'answer'}},
      {type: 'content_block_start', index: 2, content_block: {type: 'tool_use', id: 'toolu_vrtx_1', name: 'Echo', input: {}}},
      {type: 'content_block_delta', index: 2, delta: {type: 'input_json_delta', partial_json: '{"text":"hi"}'}},
      {type: 'message_delta', delta: {stop_reason: 'tool_use'}, usage: {output_tokens: 5}},
    ]));
    return new Response(sse([{choices: [{delta: {content: 'ok'}, finish_reason: 'stop'}], usage: {prompt_tokens: 3, completion_tokens: 1}}]));
  };
  const request = {system: 'sys', messages: [{role: 'user' as const, text: 'hi'}], tools: [{name: 'Echo', description: 'echo', parameters: {type: 'object', properties: {}}}], maxTokens: 4096};
  const claude = await createProvider((await settingsFor({name: 'antigravity', model: 'claude-opus-5-5-medium'})).settings, fetcher).respond(request, () => {}, new AbortController().signal);
  assert.equal(seen[0]?.url, 'http://127.0.0.1:8045/v1/messages');
  assert.equal(seen[0]?.headers['anthropic-version'], '2023-06-01');
  assert.equal(seen[0]?.headers.authorization, undefined);
  assert.equal(seen[0]?.body.model, 'claude-opus-5-5-medium');
  assert.deepEqual(seen[0]?.body.thinking, {type: 'adaptive'});
  assert.ok(Array.isArray(seen[0]?.body.system) && JSON.stringify(seen[0]?.body.system).includes('cache_control'));
  assert.ok(!('stream_options' in (seen[0]?.body ?? {})));
  assert.equal(claude.message.text, 'answer');
  assert.equal(claude.message.reasoning, 'plan');
  assert.equal(claude.message.signature, 'sig-1');
  assert.equal(claude.message.toolCalls?.[0]?.id, 'toolu_vrtx_1');
  assert.equal(claude.stop, 'tools');
  assert.deepEqual(claude.usage, {input: 16, output: 5, cacheRead: 4, cacheWrite: 2});
  await createProvider((await settingsFor({name: 'antigravity', model: 'gemini-3.8-flash'})).settings, fetcher).respond(request, () => {}, new AbortController().signal);
  assert.equal(seen[1]?.url, 'http://127.0.0.1:8045/v1/chat/completions');
  assert.ok(Array.isArray(seen[1]?.body.messages));
});

test('model_kinds: model listing and capacity use the right protocol per model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-kinds-reg-'));
  try {
    const urls: string[] = [];
    const config = await loadConfig(root, {provider: {name: 'antigravity', model: 'claude-opus-5-5'}}, {}, root, root);
    const registry = new ProviderRegistry(config, {}, async url => {urls.push(String(url)); return Response.json({data: [{id: 'claude-opus-5-5'}, {id: 'gemini-3.8-flash'}]});}, new AuthStorage(join(root, 'auth.json')));
    assert.deepEqual(await registry.models(), ['claude-opus-5-5', 'gemini-3.8-flash']);
    assert.deepEqual(urls, ['http://127.0.0.1:8045/v1/models']);
    assert.equal(registry.selection().kind, 'anthropic');
    assert.equal(registry.capacity('antigravity', 'claude-opus-5-5').maxImages, 100, 'images follow the Anthropic limit');
    assert.equal(registry.capacity('antigravity', 'gemini-3.8-flash').maxImages, undefined);
    assert.notEqual(registry.capacity('antigravity', 'claude-opus-5-5').identity, registry.capacity('antigravity', 'gemini-3.8-flash').identity);
    await registry.close();
  } finally {await rm(root, {recursive: true, force: true});}
});

test('reasoning replay: reasoning-effort gateways get none, DeepSeek and unprotocoled gateways keep it', async () => {
  const history = [{role: 'user' as const, text: 'q'}, {role: 'assistant' as const, text: '', reasoning: 'mislabeled answer', toolCalls: [{id: 'c1', name: 'Echo', arguments: '{}'}]}];
  const assistant = (messages: ReturnType<typeof openaiMessages>) => messages.find(message => message.role === 'assistant') as Record<string, unknown>;
  assert.equal('reasoning_content' in assistant(openaiMessages(history, false, true, false)), false);
  assert.equal(assistant(openaiMessages(history, true, true, false)).reasoning_content, '', 'DeepSeek still needs the field, never the stale text');
  assert.equal(assistant(openaiMessages(history, false, true)).reasoning_content, 'mislabeled answer');
  const bodies: Array<{messages: Array<Record<string, unknown>>}> = [];
  const fetcher: typeof fetch = async (_url, init) => {bodies.push(JSON.parse(String(init?.body))); return new Response(sse([{choices: [{delta: {content: 'ok'}, finish_reason: 'stop'}]}]));};
  const request = {system: 's', messages: history, tools: [], maxTokens: 512};
  await createProvider((await settingsFor({name: 'antigravity', model: 'gemini-3.8-flash'})).settings, fetcher).respond(request, () => {}, new AbortController().signal);
  assert.ok(!('reasoning_content' in bodies[0]!.messages[2]!));
  await createProvider((await settingsFor({name: 'deepseek', model: 'deepseek-flash'})).settings, fetcher).respond(request, () => {}, new AbortController().signal);
  assert.equal(bodies[1]!.messages[2]!.reasoning_content, 'mislabeled answer');
});
