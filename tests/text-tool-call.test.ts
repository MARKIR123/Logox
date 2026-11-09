import test from 'node:test';
import assert from 'node:assert/strict';
import {textToolCallName} from '../src/kernel/text-tool-call.js';
import {executionRecoveryInstruction} from '../src/kernel/execution-recovery.js';

const offered = [{name: 'Write'}, {name: 'Read'}, {name: 'mcp__a.b'}];

test('a serialized call to an offered tool is detected, including glued to a heading', () => {
  assert.equal(textToolCallName('call:default_api:Write{content:x,file_path:a}', offered), 'Write');
  assert.equal(textToolCallName('### Overwriting the pagecall:default_api:Write{content:x}', offered), 'Write');
  assert.equal(textToolCallName('Plan:\ncall:default_api:Read{file_path:a}', offered), 'Read');
  assert.equal(textToolCallName('call:default_api:mcp__a.b{x:1}', offered), 'mcp__a.b');
});

test('prose and calls to tools that were not offered do not match', () => {
  assert.equal(textToolCallName('call:default_api:Delete{x:1}', offered), undefined);
  assert.equal(textToolCallName('We call Write{} later; see call: Write', offered), undefined);
  assert.equal(textToolCallName('call:default_api:Write{x}', []), undefined);
});

test('the recovery instruction tells the model to issue a real tool call', () => {
  assert.match(executionRecoveryInstruction('text_tool_call', 'kalon'), /plain text.*real tool call/);
});
