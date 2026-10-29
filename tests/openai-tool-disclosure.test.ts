import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createProvider, openaiMessages} from '../src/providers/http.js';
import {createApplication} from '../src/application.js';
import {loadConfig, type ModelSettings} from '../src/config/config.js';
import type {ModelMessage} from '../src/runtime/messages.js';

// Protocol reference: https://developers.openai.com/api/docs/guides/tools-tool-search
const settings = {kind: 'openai_compat', baseUrl: 'https://fixture.invalid/v1', model: 'chosen-model', key: 'sk-fixture',
  temperature: 0.2, maxTokens: 1024, timeoutMs: 1000, toolDiscovery: 'openai-responses'} as ModelSettings;
const search = {type: 'tool_search_call', id: 'item-search', execution: 'client', call_id: 'call-search', status: 'completed', arguments: {names: ['_GitStatus', 'ListActors']}};
const final = {type: 'function_call', call_id: 'call-finish', name: '_FinishRound', arguments: JSON.stringify({title: 'Loaded contracts', verification: null, carry_forward: []})};
const sse = (frames: unknown[]) => new Response(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join(''), {headers: {'content-type': 'text/event-stream'}});

test('client tool-search calls decode from non-stream Responses without model substitution or invented IDs', async () => {
  const requests: Array<{url: string; body: Record<string, any>}> = [];
  const provider = createProvider(settings, async (url, init) => {
    requests.push({url: String(url), body: JSON.parse(String(init?.body))});
    return Response.json({status: 'completed', output: [search], usage: {input_tokens: 100, output_tokens: 5, input_tokens_details: {cached_tokens: 30}}});
  });
  const turn = await provider.respond({system: 'Rules', messages: [{role: 'user', text: 'Load names'}], tools: [], stream: false}, () => {}, new AbortController().signal);
  assert.match(requests[0]!.url, /\/responses$/);
  assert.equal(requests[0]!.body.model, 'chosen-model'); assert.equal(requests[0]!.body.stream, false);
  assert.deepEqual(turn.message.toolCalls, [{id: 'call-search', name: 'LoadTools', kind: 'tool-search', arguments: JSON.stringify(search.arguments)}]);
  assert.equal(turn.stop, 'tools'); assert.deepEqual(turn.usage, {input: 100, output: 5, cacheRead: 30});
  const invalid = createProvider(settings, async () => Response.json({status: 'completed', output: [{...search, call_id: null}]}));
  await assert.rejects(invalid.respond({system: 'Rules', messages: [], tools: [], stream: false}, () => {}, new AbortController().signal), /call_id/);
  for (const call_id of [null, undefined, '', 7]) {
    const streamed = createProvider(settings, async () => sse([{type: 'response.output_item.done', output_index: 0, item: {...search, call_id}},
      {type: 'response.completed', response: {status: 'completed'}}]));
    await assert.rejects(streamed.respond({system: 'Rules', messages: [], tools: []}, () => {}, new AbortController().signal), /call_id/);
  }
  const missingCompletion = createProvider(settings, async () => sse([{type: 'response.output_item.added', output_index: 0, item: {...search, call_id: undefined}},
    {type: 'response.completed', response: {status: 'completed'}}]));
  await assert.rejects(missingCompletion.respond({system: 'Rules', messages: [], tools: []}, () => {}, new AbortController().signal), /call_id/);
  const duplicate = createProvider(settings, async () => sse([{type: 'response.output_item.done', output_index: 0, item: search},
    {type: 'response.output_item.done', output_index: 1, item: search}, {type: 'response.completed', response: {status: 'completed'}}]));
  await assert.rejects(duplicate.respond({system: 'Rules', messages: [], tools: []}, () => {}, new AbortController().signal), /call_id/);
});

test('SSE client search outputs contain full selected definitions and original IDs alongside ordinary tool pairs', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-openai-disclosure-'));
  const requests: Array<Record<string, any>> = [];
  await writeFile(join(cwd, 'evidence.txt'), 'Existing evidence');
  const provider = createProvider(settings, async (url, init) => {
    assert.match(String(url), /\/responses$/);
    requests.push(JSON.parse(String(init?.body)));
    if (requests.length === 1) return sse([
      {type: 'response.output_item.added', output_index: 0, item: {...search, status: 'in_progress', arguments: {}}},
      {type: 'response.output_item.done', output_index: 0, item: search},
      {type: 'response.output_item.added', output_index: 1, item: {type: 'function_call', call_id: 'call-read', name: 'Read'}},
      {type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"file_'},
      {type: 'response.output_item.done', output_index: 1, item: {type: 'function_call', call_id: 'call-read', name: 'Read', arguments: '{"file_path":"evidence.txt"}'}},
      {type: 'response.completed', response: {status: 'completed', usage: {input_tokens: 100, output_tokens: 10, input_tokens_details: {cached_tokens: 20}}}},
    ]);
    return sse([{type: 'response.output_text.delta', delta: 'Loaded contracts; evidence preserved.'},
      {type: 'response.output_item.done', output_index: 1, item: {...final, call_id: 'finish-' + requests.length}}, {type: 'response.completed', response: {status: 'completed'}}]);
  });
  const config = await loadConfig(cwd, {provider: {model: 'fixture', context_window: 131072}}, {}, cwd, cwd);
  const app = await createApplication({cwd, sessionId: 's', config, provider, env: {}, authPath: join(cwd, 'auth.json'), resourceOptions: {home: cwd, boundary: cwd}});
  try {
    const task = app.ensemble.dispatch('logox', 'Load tools and read existing evidence.', 'direct', {inputKind: 'human'}); await task.done;
    assert.equal(app.store.activities.get('s', task.activityId)?.status, 'completed');
    assert.equal(requests.length, 2);
    const first = requests[0]!, second = requests[1]!;
    assert.ok(first.tools.some((tool: any) => tool.type === 'tool_search' && tool.execution === 'client' && tool.parameters.properties.names));
    assert.ok(!first.tools.some((tool: any) => tool.name === 'LoadTools' || tool.name === '_GitStatus'));
    const output = second.input.find((item: any) => item.type === 'tool_search_output');
    assert.equal(output.call_id, 'call-search'); assert.equal(output.execution, 'client'); assert.equal(output.status, 'completed');
    assert.deepEqual(output.tools.map((tool: any) => tool.name).sort(), ['ListActors', '_GitStatus']);
    assert.ok(output.tools.every((tool: any) => tool.parameters.type === 'object'));
    assert.ok(second.input.some((item: any) => item.type === 'tool_search_call' && item.call_id === 'call-search'));
    assert.ok(second.input.some((item: any) => item.type === 'function_call_output' && item.call_id === 'call-read' && item.output.includes('Existing evidence')));
    assert.equal(second.instructions, first.instructions);
    await app.ensemble.dispatch('logox', 'Continue without loading again.', 'direct', {inputKind: 'human'}).done;
    assert.equal(requests.length, 3);
    assert.ok(requests[2]!.input.some((item: any) => item.type === 'tool_search_output' && item.call_id === 'call-search'));
    assert.equal(await readFile(join(cwd, 'evidence.txt'), 'utf8'), 'Existing evidence');
  } finally {await app.close(); await rm(cwd, {recursive: true, force: true});}
});

test('OAuth remains streaming Responses while API-key auto mode retains Chat routing and chosen models', async () => {
  for (const [key, model, endpoint] of [['oauth-fixture', 'gpt-4o', '/responses'], ['sk-fixture', 'gpt-5.4', '/chat/completions']] as const) {
    const provider = createProvider({...settings, baseUrl: 'https://api.openai.com/v1', key, model, toolDiscovery: 'auto'}, async (url, init) => {
      assert.ok(String(url).endsWith(endpoint));
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, model);
      if (key.startsWith('oauth-')) {assert.equal(body.stream, true); assert.equal(body.store, false); return sse([{type: 'response.completed', response: {status: 'completed'}}]);}
      assert.equal(body.stream, undefined); return Response.json({choices: [{message: {content: 'Done'}, finish_reason: 'stop'}]});
    });
    await provider.respond({system: 'Rules', messages: [], tools: [], stream: false}, () => {}, new AbortController().signal);
  }
});

test('incomplete native discovery batches execute no writes or schema discoveries', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-search-incomplete-'));
  let count = 0;
  const provider = createProvider(settings, async () => ++count === 1 ? sse([
    {type: 'response.output_item.done', output_index: 0, item: search},
    {type: 'response.output_item.done', output_index: 1, item: {type: 'function_call', call_id: 'write', name: 'Write', arguments: '{"file_path":"never.txt","content":"bad"}'}},
    {type: 'response.incomplete', response: {status: 'incomplete'}},
  ]) : sse([{type: 'response.output_text.delta', delta: 'Incomplete batch was not executed.'},
    {type: 'response.output_item.done', output_index: 0, item: final}, {type: 'response.completed', response: {status: 'completed'}}]));
  const config = await loadConfig(cwd, {provider: {model: 'fixture', context_window: 131072}, permissions: {mode: 'creative'}}, {}, cwd, cwd);
  const app = await createApplication({cwd, sessionId: 's', config, provider, env: {}, authPath: join(cwd, 'auth.json'), resourceOptions: {home: cwd, boundary: cwd}});
  try {
    const task = app.ensemble.dispatch('logox', 'Inspect without unverified effects.', 'direct', {inputKind: 'human'}); await task.done;
    assert.equal(app.store.activities.get('s', task.activityId)?.status, 'completed');
    assert.equal(count, 2);
    await assert.rejects(readFile(join(cwd, 'never.txt')), {code: 'ENOENT'});
    const results = (await app.journal.load('s', 'logox')).flatMap(entry => entry.message?.role === 'tool' && entry.message.name !== '_FinishRound' ? [entry.message] : []);
    assert.equal(results.length, 2); assert.ok(results.every(result => result.isError && !result.discoveredTools));
  } finally {await app.close(); await rm(cwd, {recursive: true, force: true});}
});

test('canonical discovered pairs translate to ordinary Chat without native fields or side effects', () => {
  const history: ModelMessage[] = [{role: 'assistant', text: '', toolCalls: [{id: 'original', name: 'LoadTools', arguments: '{"names":["_GitStatus"]}', kind: 'tool-search'}]},
    {role: 'tool', name: 'LoadTools', callId: 'original', text: 'Loaded: _GitStatus', isError: false, discoveredTools: ['_GitStatus']}];
  const json = JSON.stringify(openaiMessages(history));
  assert.match(json, /original/); assert.match(json, /_GitStatus/);
  assert.ok(!/tool_search_output|tool_search_call|tool_reference|defer_loading|cache_control/.test(json));
});
