import test from 'node:test';
import assert from 'node:assert/strict';
import {createProvider, partialTarget} from '../src/providers/http.js';
import type {Delta} from '../src/runtime/messages.js';

type ToolDelta = Extract<Delta, {kind: 'tool'}>;
const sse = (frames: unknown[]) => new Response(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join('') + 'data: [DONE]\n\n', {headers: {'content-type': 'text/event-stream'}});
async function stream(kind: 'openai_compat' | 'anthropic', api: 'responses' | undefined, frames: unknown[]): Promise<{tools: ToolDelta[]; texts: string[]; arguments: string | undefined}> {
  const provider = createProvider({kind, baseUrl: 'http://localhost/v1', model: 'test', key: 'k', temperature: 0, maxTokens: 1000, timeoutMs: 5000,
    ...(api ? {api} : {})} as never, async () => sse(frames));
  const tools: ToolDelta[] = [], texts: string[] = [];
  const turn = await provider.respond({system: '', messages: [{role: 'user', text: 'go'}], tools: []}, delta => {if (delta.kind === 'tool') tools.push(delta); else texts.push(delta.text);}, new AbortController().signal);
  return {tools, texts, arguments: turn.message.toolCalls?.[0]?.arguments};
}
const first = '{"file_path":"C:\\\\art\\\\pelican.svg",', second = '"content":"<svg/>"}';

test('partialTarget reads file_path or path once its string has fully arrived', () => {
  assert.equal(partialTarget('{"file_pa'), undefined);
  assert.equal(partialTarget('{"file_path":"src/a'), undefined);
  assert.equal(partialTarget('{"file_path":"src/a.ts","content":"x'), 'src/a.ts');
  assert.equal(partialTarget('{"path": "dir\\\\b.md"}'), 'dir\\b.md');
  assert.equal(partialTarget('{"command":"ls"}'), undefined);
});

test('Responses streams report accumulated tool-argument size and target', async () => {
  const result = await stream('openai_compat', 'responses', [
    {type: 'response.output_item.added', output_index: 0, item: {type: 'function_call', call_id: 'c1', name: 'Edit'}},
    {type: 'response.function_call_arguments.delta', output_index: 0, delta: first},
    {type: 'response.function_call_arguments.delta', output_index: 0, delta: second},
    {type: 'response.completed', response: {status: 'completed'}},
  ]);
  assert.deepEqual(result.tools, [{kind: 'tool', name: 'Edit', chars: first.length, target: 'C:\\art\\pelican.svg'}, {kind: 'tool', name: 'Edit', chars: first.length + second.length, target: 'C:\\art\\pelican.svg'}]);
  assert.deepEqual(result.texts, []);
});

test('Anthropic input_json_delta reports accumulated tool-argument size, target only once complete', async () => {
  const tail = 'th":"a/b.ts","content":"x"}';
  const result = await stream('anthropic', undefined, [
    {type: 'message_start', message: {usage: {input_tokens: 1}}},
    {type: 'content_block_start', index: 0, content_block: {type: 'tool_use', id: 'c1', name: 'Write', input: {}}},
    {type: 'content_block_delta', index: 0, delta: {type: 'input_json_delta', partial_json: '{"file_pa'}},
    {type: 'content_block_delta', index: 0, delta: {type: 'input_json_delta', partial_json: tail}},
    {type: 'message_delta', delta: {stop_reason: 'tool_use'}, usage: {output_tokens: 3}},
  ]);
  assert.deepEqual(result.tools, [{kind: 'tool', name: 'Write', chars: 9}, {kind: 'tool', name: 'Write', chars: 9 + tail.length, target: 'a/b.ts'}]);
  assert.equal(result.arguments, '{"file_path":"a/b.ts","content":"x"}');
});

test('OpenAI-compatible chat tool_calls report accumulated size and target', async () => {
  const result = await stream('openai_compat', undefined, [
    {choices: [{delta: {tool_calls: [{index: 0, id: 'c1', function: {name: 'Edit', arguments: '{"path":"x.svg",'}}]}}]},
    {choices: [{delta: {tool_calls: [{index: 0, function: {arguments: '"content":"y"}'}}]}, finish_reason: 'tool_calls'}]},
  ]);
  assert.deepEqual(result.tools.map(tool => [tool.name, tool.chars, tool.target]), [['Edit', 16, 'x.svg'], ['Edit', 30, 'x.svg']]);
});
