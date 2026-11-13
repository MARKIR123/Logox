import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProviderRegistry} from '../src/providers/registry.js';
import {loadConfig} from '../src/config/config.js';
import {CustomProviderStorage} from '../src/providers/custom-storage.js';
import {AuthStorage} from '../src/providers/auth.js';
import type {Delta} from '../src/runtime/messages.js';

test('ProviderRegistry includes openai in presets and identifies reasoning models', async () => {
  const config = await loadConfig(process.cwd(), {provider: {name: 'deepseek', model: 'fixture'}}, {});
  const registry = new ProviderRegistry(config, {});
  assert.ok(registry.templateNames().includes('openai'), 'templates should contain openai');
  assert.ok(!registry.names().includes('openai'), 'an unconfigured template is not a provider');

  const settings = await registry.candidate('openai', 'o1').settings(false);
  assert.equal(settings.baseUrl, 'https://api.openai.com/v1');
  assert.equal(settings.kind, 'openai_compat');
  assert.equal(settings.thinkingProtocol, 'reasoning-effort');
});

test('ProviderRegistry merges custom providers from CustomProviderStorage', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'logox-reg-test-'));
  try {
    const customStorage = new CustomProviderStorage(join(tempDir, 'custom-providers.json'));
    const authStorage = new AuthStorage(join(tempDir, 'auth.json'));
    await customStorage.save({name: 'my-vllm', base_url: 'http://127.0.0.1:8000/v1', kind: 'openai_compat'});

    const config = await loadConfig(process.cwd(), {}, {});
    const registry = new ProviderRegistry(config, process.env, fetch, authStorage, customStorage);
    await registry.syncCustom();

    assert.ok(registry.names().includes('my-vllm'), 'custom provider should appear in names()');
    const settings = await registry.candidate('my-vllm', 'llama3').settings(false);
    assert.equal(settings.baseUrl, 'http://127.0.0.1:8000/v1');
    assert.equal(settings.kind, 'openai_compat');
  } finally {
    await rm(tempDir, {recursive: true, force: true});
  }
});

import {createProvider as createReasoningProvider} from '../src/providers/http.js';

function sse(...frames: unknown[]) {
  return new Response(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join('') + 'data: [DONE]\n\n', {headers: {'content-type': 'text/event-stream'}});
}
async function reasoningTurn(baseUrl: string, key: string, respond: () => Response, api?: 'responses', stream = true) {
  const bodies: Array<Record<string, any>> = [];
  const fetcher: typeof fetch = async (_url, init) => {bodies.push(JSON.parse(String(init?.body))); return respond();};
  const provider = createReasoningProvider({kind: 'openai_compat', baseUrl, model: 'gpt-6.1-sol', key, temperature: 0, maxTokens: 100, timeoutMs: 2000,
    ...(api ? {api} : {}), thinkingEffort: 'high'} as never, fetcher);
  const deltas: Array<{kind: string; text: string}> = [];
  const tools: Array<Extract<Delta, {kind: 'tool'}>> = [];
  const turn = await provider.respond({system: '', messages: [{role: 'user', text: 'hi'}], tools: [], stream}, delta => {if (delta.kind === 'tool') tools.push(delta); else deltas.push(delta);}, new AbortController().signal);
  return {turn, deltas, tools, bodies};
}

test('Responses requests ask for reasoning summaries only on the official endpoint', async () => {
  const done = () => sse({type: 'response.completed', response: {status: 'completed'}});
  const official = await reasoningTurn('https://api.openai.com/v1', 'oauth-token', done);
  assert.deepEqual(official.bodies[0]!.reasoning, {effort: 'high', summary: 'auto'});
  const gateway = await reasoningTurn('https://gateway.example/v1', 'k', done, 'responses');
  assert.deepEqual(gateway.bodies[0]!.reasoning, {effort: 'high'});
});

test('Responses reasoning summary deltas stream as thinking with part breaks', async () => {
  const {turn, deltas} = await reasoningTurn('https://api.openai.com/v1', 'oauth-token', () => sse(
    {type: 'response.output_item.added', output_index: 0, item: {type: 'reasoning', id: 'rs_1'}},
    {type: 'response.reasoning_summary_part.added', output_index: 0, summary_index: 0},
    {type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'Check files'},
    {type: 'response.reasoning_summary_part.added', output_index: 0, summary_index: 1},
    {type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'Then edit'},
    {type: 'response.output_item.done', output_index: 0, item: {type: 'reasoning', id: 'rs_1', summary: [{type: 'summary_text', text: 'Check files'}, {type: 'summary_text', text: 'Then edit'}]}},
    {type: 'response.output_text.delta', output_index: 1, delta: 'done'},
    {type: 'response.completed', response: {status: 'completed'}}));
  assert.equal(turn.message.reasoning, 'Check files\n\nThen edit');
  assert.equal(turn.message.text, 'done');
  assert.ok(deltas.some(d => d.kind === 'reasoning'));
});

test('Responses reasoning items without deltas still surface their summary', async () => {
  const streamed = await reasoningTurn('https://api.openai.com/v1', 'oauth-token', () => sse(
    {type: 'response.output_item.done', output_index: 0, item: {type: 'reasoning', summary: [{type: 'summary_text', text: 'Plan A'}, {type: 'summary_text', text: 'Plan B'}]}},
    {type: 'response.completed', response: {status: 'completed'}}));
  assert.equal(streamed.turn.message.reasoning, 'Plan A\n\nPlan B');
  const plain = await reasoningTurn('https://gateway.example/v1', 'k', () => Response.json({status: 'completed', output: [
    {type: 'reasoning', summary: [{type: 'summary_text', text: 'Weighed options'}], encrypted_content: 'abc'},
    {type: 'message', content: [{type: 'output_text', text: 'ok'}]}]}), 'responses', false);
  assert.equal(plain.turn.message.reasoning, 'Weighed options');
  assert.equal(plain.turn.message.text, 'ok');
});

test('Chat Completions gateways: reasoning_content, reasoning, thinking and reasoning_details all become thinking', async () => {
  for (const [field, value, expected] of [
    ['reasoning_content', 'a', 'a'], ['reasoning', 'b', 'b'], ['thinking', 'c', 'c'],
    ['reasoning_details', [{type: 'reasoning.text', text: 'd1'}, {type: 'reasoning.summary', summary: 'd2'}], 'd1d2'],
  ] as const) {
    const streamed = await reasoningTurn('https://gateway.example/v1', 'k', () => sse(
      {choices: [{delta: {[field]: value}}]}, {choices: [{delta: {content: 'x'}, finish_reason: 'stop'}]}));
    assert.equal(streamed.turn.message.reasoning, expected, 'stream ' + field);
    const plain = await reasoningTurn('https://gateway.example/v1', 'k', () => Response.json({choices: [{message: {content: 'x', [field]: value}, finish_reason: 'stop'}]}), undefined, false);
    assert.equal(plain.turn.message.reasoning, expected, 'plain ' + field);
  }
});
