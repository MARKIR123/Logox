import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyTurn, isTextToolCall, type TurnFacts, type TurnShape} from '../src/kernel/turn-outcome.js';

const offered = [{name: 'Write'}, {name: 'Read'}];
const base: TurnFacts = {closing: false, peerPending: false, directorWaiting: false, offered};
const turn = (stop: TurnShape['stop'], text = '', ...calls: [string, string?][]): TurnShape => ({
  stop, message: {text, ...(calls.length ? {toolCalls: calls.map(([name, args]) => ({name, arguments: args ?? '{}'}))} : {})}});
const kindOf = (shape: TurnShape, facts: Partial<TurnFacts> = {}) => classifyTurn(shape, {...base, ...facts}).kind;

test('the closing follow-up with any call is closing_with_calls: nothing in it runs', () => {
  assert.deepEqual(classifyTurn(turn('tools', '', ['Read']), {...base, closing: true}), {kind: 'closing_with_calls', truncated: false});
  assert.deepEqual(classifyTurn(turn('length', '', ['Read']), {...base, closing: true}), {kind: 'closing_with_calls', truncated: true});
  assert.deepEqual(classifyTurn(turn('tools', '', ['Read', '{broken']), {...base, closing: true}), {kind: 'closing_with_calls', truncated: true});
});

test('a business batch is a tools outcome, truncated by the stop reason or by unparsable arguments', () => {
  assert.deepEqual(classifyTurn(turn('tools', '', ['Read']), base), {kind: 'tools', truncated: false});
  assert.deepEqual(classifyTurn(turn('length', '', ['Read']), base), {kind: 'tools', truncated: true});
  assert.deepEqual(classifyTurn(turn('tools', '', ['Read', '{"a":']), base), {kind: 'tools', truncated: true});
});

test('a call to the retired _FinishRound is an ordinary batch (unknown tool)', () => {
  assert.deepEqual(classifyTurn(turn('tools', 'done', ['_FinishRound']), base), {kind: 'tools', truncated: false});
});

test('a tool call written as text is recognised only for an offered tool and never in the closing follow-up', () => {
  const written = turn('complete', 'call:default_api:Write{content:x}');
  assert.equal(kindOf(written), 'text_tool_call');
  assert.equal(isTextToolCall(written, false, offered), true);
  assert.equal(kindOf(turn('complete', 'call:default_api:Delete{x:1}')), 'delivered');
  assert.equal(isTextToolCall(written, true, offered), false);
});

test('the closing follow-up without a call is closing_reply whatever it holds', () => {
  assert.equal(kindOf(turn('complete', '<synopsis title="t">s</synopsis>'), {closing: true}), 'closing_reply');
  assert.equal(kindOf(turn('complete', 'thanks'), {closing: true}), 'closing_reply');
  assert.equal(kindOf(turn('complete', ''), {closing: true}), 'closing_reply');
  assert.equal(kindOf(turn('length', 'cut'), {closing: true}), 'closing_reply');
  assert.equal(kindOf(turn('complete', 'call:default_api:Write{content:x}'), {closing: true}), 'closing_reply');
});

test('an empty reply while a peer wait is pending or a reply is owed is empty_awaiting_peer', () => {
  assert.equal(kindOf(turn('complete', '  '), {peerPending: true}), 'empty_awaiting_peer');
});

test('an empty reply from a waiting Director is empty_director_waiting', () => {
  assert.equal(kindOf(turn('complete', ''), {directorWaiting: true}), 'empty_director_waiting');
});

test('a pending peer outranks a waiting Director when both hold', () => {
  assert.equal(kindOf(turn('complete', ''), {peerPending: true, directorWaiting: true}), 'empty_awaiting_peer');
});

test('an empty reply with no excuse is no_delivery, for a complete or a length stop', () => {
  assert.equal(kindOf(turn('complete', '')), 'no_delivery');
  assert.equal(kindOf(turn('length', '')), 'no_delivery');
  assert.equal(kindOf(turn('length', ''), {peerPending: true, directorWaiting: true}), 'no_delivery');
});

test('text cut off by the output limit is truncated_text', () => {
  assert.equal(kindOf(turn('length', 'half a sentence')), 'truncated_text');
});

test('complete text is delivered, including while a peer is pending or a Director waits', () => {
  assert.equal(kindOf(turn('complete', 'answer')), 'delivered');
  assert.equal(kindOf(turn('complete', 'answer'), {peerPending: true, directorWaiting: true}), 'delivered');
});

test('a tools or other stop without calls is abnormal_stop', () => {
  assert.equal(kindOf(turn('tools', 'text')), 'abnormal_stop');
  assert.equal(kindOf(turn('tools', '')), 'abnormal_stop');
  assert.equal(kindOf(turn('other', 'text')), 'abnormal_stop');
  assert.equal(kindOf(turn('other', '')), 'abnormal_stop');
});

test('calls outrank the empty-reply outcomes: a tool turn is a tools outcome whatever the waiting facts say', () => {
  assert.equal(kindOf(turn('tools', '', ['Read']), {peerPending: true, directorWaiting: true}), 'tools');
});
