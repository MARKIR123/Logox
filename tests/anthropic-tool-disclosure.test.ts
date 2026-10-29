import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../src/application.js';
import {createProvider} from '../src/providers/http.js';
import {loadConfig, type ModelSettings} from '../src/config/config.js';

test('loading cannot authorize a deferred write in its producing batch', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-load-write-batch-'));
  await mkdir(join(cwd, '.logox'));
  await writeFile(join(cwd, '.logox', 'tools.json'), JSON.stringify({Write: {loading: 'deferred'}}));
  const bodies: Array<Record<string, any>> = [];
  const settings = {kind: 'anthropic', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', key: '', temperature: 0.2, maxTokens: 512, timeoutMs: 1000, toolDiscovery: 'anthropic'} as ModelSettings;
  const provider = createProvider(settings, async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    const calls = bodies.length === 1 ? [
      {type: 'tool_use', id: 'load', name: 'LoadTools', input: {names: ['Write']}},
      {type: 'tool_use', id: 'write', name: 'Write', input: {file_path: 'never.txt', content: 'must not write'}},
    ] : [{type: 'text', text: 'No write was executed.'}, {type: 'tool_use', id: 'done', name: '_FinishRound', input: {title: 'Protected write', verification: null, carry_forward: []}}];
    return new Response([...calls.map((content_block, index) => ({type: 'content_block_start', index, content_block})),
      {type: 'message_delta', delta: {stop_reason: 'tool_use'}}, {type: 'message_stop'}].map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join(''), {headers: {'content-type': 'text/event-stream'}});
  });
  const config = await loadConfig(cwd, {provider: {model: 'fixture', context_window: 131072}, permissions: {mode: 'creative'}}, {}, cwd, cwd);
  const app = await createApplication({cwd, sessionId: 's', config, provider, env: {}, authPath: join(cwd, 'auth.json'), resourceOptions: {home: cwd, boundary: cwd}});
  try {
    const task = app.ensemble.dispatch('logox', 'Load and inspect writing.', 'direct', {inputKind: 'human'}); await task.done;
    assert.equal(bodies.length, 2);
    await assert.rejects(readFile(join(cwd, 'never.txt')), {code: 'ENOENT'});
    assert.ok(bodies.every(body => !body.tools.some((tool: any) => tool.name === 'Write')));
    assert.ok(!JSON.stringify(bodies[1]!.messages).includes('tool_reference'));
  } finally {await app.close(); await rm(cwd, {recursive: true, force: true});}
});

test('native Anthropic loading carries actual references while eager tools and system bytes stay stable', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-anthropic-disclosure-'));
  const bodies: Array<Record<string, any>> = [];
  const settings = {kind: 'anthropic', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', key: '', temperature: 0.2, maxTokens: 512, timeoutMs: 1000, toolDiscovery: 'anthropic'} as ModelSettings;
  const provider = createProvider(settings, async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    const loading = bodies.length === 1;
    const call = {type: 'tool_use', id: loading ? 'load-real' : 'finish-real', name: loading ? 'LoadTools' : '_FinishRound',
      input: loading ? {names: ['_GitStatus']} : {title: 'Loaded tool', verification: null, carry_forward: []}};
    const frames = [{type: 'message_start', message: {usage: {input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30}}},
      ...(!loading ? [{type: 'content_block_start', index: 0, content_block: {type: 'text', text: 'Loaded, without running Git.'}}] : []),
      {type: 'content_block_start', index: 1, content_block: call},
      {type: 'message_delta', delta: {stop_reason: 'tool_use'}, usage: {output_tokens: 5}}, {type: 'message_stop'}];
    return new Response(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join(''), {headers: {'content-type': 'text/event-stream'}});
  });
  const config = await loadConfig(cwd, {provider: {model: 'fixture', context_window: 131072}}, {}, cwd, cwd);
  const app = await createApplication({cwd, sessionId: 's', config, provider, env: {}, authPath: join(cwd, 'auth.json'), resourceOptions: {home: cwd, boundary: cwd}});
  try {
    const task = app.ensemble.dispatch('logox', 'Load Git inspection, but do not execute it.', 'direct', {inputKind: 'human'});
    await task.done;
    assert.equal(app.store.activities.get('s', task.activityId)?.status, 'completed');
    assert.equal(bodies.length, 2);
    const [first, second] = bodies;
    assert.ok(first!.tools.some((tool: any) => tool.name === 'LoadTools'));
    assert.ok(!first!.tools.some((tool: any) => tool.name === '_GitStatus'));
    assert.equal(second!.tools.find((tool: any) => tool.name === '_GitStatus')?.defer_loading, true);
    assert.deepEqual(second!.tools.filter((tool: any) => !tool.defer_loading), first!.tools);
    assert.deepEqual(second!.system, first!.system);
    assert.match(JSON.stringify(first!.system), /_GitStatus: Fetch/);
    const result = second!.messages.flatMap((message: any) => message.content).find((block: any) => block.type === 'tool_result' && block.tool_use_id === 'load-real');
    assert.ok(result?.content.some((block: any) => block.type === 'tool_reference' && block.tool_name === '_GitStatus'));
    const records = await app.journal.load('s', 'logox');
    assert.ok(!records.some(entry => entry.message?.role === 'tool' && entry.message.name === '_GitStatus'));
    const usage = app.contexts.meter({sessionId: 's', ownerId: 'logox'}).usageRecords().filter(record => record.category === 'task');
    assert.equal(usage.reduce((sum, record) => sum + record.input, 0), 120);
  } finally {await app.close(); await rm(cwd, {recursive: true, force: true});}
});
