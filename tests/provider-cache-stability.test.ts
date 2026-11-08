import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createTestApplication as createApplication} from './runtime-fixture.js';
import {loadConfig} from '../src/config/config.js';
import {createProvider, openaiMessages} from '../src/providers/http.js';
import type {ModelMessage} from '../src/runtime/messages.js';

type Step = {reasoning?: string; text?: string; call?: {id: string; name: string; args: unknown}};
function sse(step: Step): Response {
  const chunk = (delta: unknown, finish?: string) => 'data: ' + JSON.stringify({choices: [{delta, ...(finish ? {finish_reason: finish} : {})}]}) + '\n\n';
  let body = '';
  if (step.reasoning) body += chunk({reasoning_content: step.reasoning});
  if (step.text) body += chunk({content: step.text});
  if (step.call) body += chunk({tool_calls: [{index: 0, id: step.call.id, function: {name: step.call.name, arguments: JSON.stringify(step.call.args)}}]}, 'tool_calls');
  else body += chunk({}, 'stop');
  body += 'data: ' + JSON.stringify({choices: [], usage: {prompt_tokens: 10, completion_tokens: 5}}) + '\n\ndata: [DONE]\n\n';
  return new Response(body, {status: 200, headers: {'content-type': 'text/event-stream'}});
}
/** Runs a real actor through several tool turns and returns every request body the transport serialized. */
async function capture(settings: Partial<Parameters<typeof createProvider>[0]>, steps: Step[]) {
  const bodies: string[] = [];
  const queue = [...steps];
  const fetcher = (async (_url: unknown, init: {body?: unknown}) => {
    bodies.push(String(init.body));
    return sse(queue.shift() ?? {text: 'done'});
  }) as unknown as typeof fetch;
  const provider = createProvider({kind: 'openai_compat', baseUrl: 'https://gateway.example/v1', model: 'test', key: 'k',
    temperature: 0.2, maxTokens: 1000, timeoutMs: 5000, ...settings}, fetcher);
  const cwd = await mkdtemp(join(tmpdir(), 'logox-cache-'));
  const config = await loadConfig(cwd, {permissions: {mode: 'default'}, provider: {model: 'test', context_window: 131072}}, {}, cwd, cwd);
  const app = await createApplication({cwd, resourceOptions: {home: cwd, boundary: cwd}, sessionId: 'cache', config, provider});
  try {
    await app.ensemble.dispatch('techne', 'build the page').done;
    return bodies.map(body => JSON.parse(body) as {messages: unknown[]; tools?: unknown[]} & Record<string, unknown>);
  } finally {await app.close(); await rm(cwd, {recursive: true, force: true});}
}
const glob = (id: string): NonNullable<Step['call']> => ({id, name: 'glob', args: {pattern: '*.nothing'}});

test('consecutive OpenAI Chat requests keep every earlier byte and only append new turns', async () => {
  const bodies = await capture({}, [
    {reasoning: 'plan one', text: '⏵ Reading the brief\nLooking around.', call: glob('g1')},
    {reasoning: 'plan two', text: 'Still looking.', call: glob('g2')},
    {reasoning: 'plan three', text: '⏵ Building the page', call: glob('g3')},
    {text: 'done'},
  ]);
  assert.ok(bodies.length >= 4, 'at least four model requests were serialized');
  for (let index = 1; index < bodies.length; index++) {
    const previous = bodies[index - 1]!, next = bodies[index]!;
    assert.equal(JSON.stringify(next.tools), JSON.stringify(previous.tools), 'the tools array is identical');
    assert.equal(JSON.stringify(next.messages[0]), JSON.stringify(previous.messages[0]), 'the system message is identical');
    // The ensemble roster rides on the tail of a request only, so the stable history ends before it.
    const stable = (messages: unknown[]) => JSON.stringify(messages.slice(0, previous.messages.length - 1));
    assert.ok(stable(next.messages).startsWith(stable(previous.messages).slice(0, -1)), 'request ' + index + ' starts with the bytes of request ' + (index - 1));
  }
});
test('prompt_cache_key is stable per session and actor, and only sent where the provider accepts it', async () => {
  const official = await capture({baseUrl: 'https://api.openai.com/v1'}, [{text: '⏵ Start\nLooking.', call: glob('g1')}, {call: glob('g2')}, {text: 'done'}]);
  const keys = official.map(body => body.prompt_cache_key);
  assert.ok(keys.length >= 3);
  assert.match(String(keys[0]), /^logox-[0-9a-f]{32}$/);
  assert.equal(new Set(keys).size, 1, 'one key for every request of the actor');
  const gateway = await capture({}, [{call: glob('g1')}, {text: 'done'}]);
  assert.ok(gateway.every(body => !('prompt_cache_key' in body)), 'unknown gateways never see the field');
  const optedIn = await capture({promptCacheKey: true}, [{call: glob('g1')}, {text: 'done'}]);
  assert.ok(optedIn.every(body => typeof body.prompt_cache_key === 'string'));
  const optedOut = await capture({baseUrl: 'https://api.openai.com/v1', promptCacheKey: false}, [{call: glob('g1')}, {text: 'done'}]);
  assert.ok(optedOut.every(body => !('prompt_cache_key' in body)));
});

test('with images under the cap, a new screenshot never rewrites earlier messages', () => {
  const image = {mimeType: 'image/png', data: 'AAAA'};
  const history = (count: number): ModelMessage[] => Array.from({length: count}, (_, index) => [
    {role: 'assistant', text: '', toolCalls: [{id: 'c' + index, name: 'Read', arguments: '{}'}]},
    {role: 'tool', callId: 'c' + index, name: 'Read', text: 'shot ' + index, isError: false, images: [image]},
  ] as ModelMessage[]).flat();
  let previous = JSON.stringify(openaiMessages(history(1), false, true));
  let rewrites = 0;
  for (let count = 2; count <= 12; count++) {
    const next = JSON.stringify(openaiMessages(history(count), false, true));
    // The request grows by one tool exchange; the earlier bytes must survive.
    const stable = next.startsWith(previous.slice(0, -1));
    if (!stable) rewrites++;
    previous = next;
  }
  assert.equal(rewrites, 0, 'no sliding window: every earlier byte survives each new screenshot');
  assert.equal(JSON.stringify(openaiMessages(history(12), false, true)).split('"type":"image_url"').length - 1, 12, 'all twelve images stay inline');
});
