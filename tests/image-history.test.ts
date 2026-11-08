import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Journal} from '../src/store/journal.js';
import {ContextManager} from '../src/context/manager.js';
import {contextPolicySchema} from '../src/config/config.js';
import {getActorScratchpadDir, settleToolResults, TURN_TOOL_RESULTS_LIMIT} from '../src/kernel/scratchpad.js';
import {providerFailure} from '../src/providers/http.js';
import type {ModelMessage, Provider} from '../src/runtime/messages.js';

const PNG = Buffer.from('not really a png but bytes').toString('base64');
const id = (activityId: string) => ({version: 1 as const, sessionId: 's', ownerId: 'techne', activityId});
const shot = (index: number, path = '/shots/' + index + '.png'): ModelMessage => ({role: 'tool', callId: 'c' + index, name: 'Read', isError: false,
  text: '[Image file: ' + path + ', size: 26 bytes, format: image/png. Visual content presented to model.]\n[image: ' + path + ']',
  images: [{data: PNG, mimeType: 'image/png', path}]});
const call = (index: number): ModelMessage => ({role: 'assistant', text: '', toolCalls: [{id: 'c' + index, name: 'Read', arguments: JSON.stringify({file_path: '/shots/' + index + '.png'})}]});
const provider: Provider = {async respond() {return {message: {role: 'assistant', text: 'OVERVIEW'}, stop: 'complete'};}};

async function fixture(shots: number) {
  const root = await mkdtemp(join(tmpdir(), 'logox-images-'));
  const journal = new Journal(root);
  const put = (activityId: string, message: ModelMessage) => journal.append({...id(activityId), role: message.role, text: message.text, message});
  await journal.append({...id('open'), role: 'user', inputKind: 'human', text: 'Look at the shots'});
  for (let index = 1; index <= shots; index++) {await put('open', call(index)); await put('open', shot(index));}
  const manager = (maxImages?: number) => {
    const model = {identity: 'fixture', window: 1_000_000, ...(maxImages ? {maxImages} : {})};
    return new ContextManager({journal, maxOutput: 512, model: () => model, summarizer: () => ({model, provider}),
      policy: contextPolicySchema.parse({keep_recent_rounds: 0, keep_recent_tools: 2, keep_index_lines: 2})});
  };
  return {root, journal, put, manager, identity: {sessionId: 's', ownerId: 'techne', activityId: 'open'}, base: {system: 'rules', tools: []}, signal: new AbortController().signal};
}
const inline = (messages: readonly ModelMessage[]) => messages.reduce((sum, message) => sum + (message.role === 'tool' ? message.images?.length ?? 0 : 0), 0);
const toolTexts = (messages: readonly ModelMessage[]) => messages.flatMap(message => message.role === 'tool' ? [message.text] : []);

test('every image gets a file at creation and its path is written into the tool result text', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-images-cwd-'));
  try {
    const [saved, fromFile] = await settleToolResults([
      {callId: 'shot-1', text: '[Image: image/png]', images: [{data: PNG, mimeType: 'image/png'}]},
      {callId: 'read-1', text: '[Image file: /work/logo.png, size: 26 bytes]', images: [{data: PNG, mimeType: 'image/png', path: '/work/logo.png'}]},
    ], cwd, 'sess', 'kalon');
    const path = saved!.images![0]!.path!;
    assert.ok(path.startsWith(join(getActorScratchpadDir(cwd, 'sess', 'kalon'), 'images')), 'written to the caller images directory: ' + path);
    assert.equal((await readFile(path)).toString('base64'), PNG);
    assert.ok(saved!.text.includes('[image: ' + path + ']'));
    assert.equal(fromFile!.images![0]!.path, '/work/logo.png', 'a source file keeps its own path');
    assert.ok(fromFile!.text.includes('/work/logo.png') && !fromFile!.text.includes('[image:'), 'already named in the text, so no duplicate line');
    assert.ok((await stat(path)).isFile());
  } finally {await rm(cwd, {recursive: true, force: true});}
});

test('parallel tool results above the per-message cap offload the largest ones until the total fits', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-cap-'));
  try {
    const size = Math.floor(TURN_TOOL_RESULTS_LIMIT / 4);
    const items = [30_000, size + 5000, size, size - 1000, size + 1000, 100].map((length, index) => ({callId: 'r' + index, text: 'x'.repeat(length)}));
    const settled = await settleToolResults(items, cwd, 'sess', 'techne');
    const total = settled.reduce((sum, item) => sum + item.text.length, 0);
    assert.ok(total <= TURN_TOOL_RESULTS_LIMIT, 'fits: ' + total);
    const offloaded = settled.flatMap((item, index) => item.text.includes('<persisted-output>') ? [index] : []);
    assert.ok(offloaded.includes(1) && offloaded.includes(4), 'the largest are offloaded: ' + offloaded);
    assert.ok(!offloaded.includes(5) && !offloaded.includes(0), 'small results stay inline');
    assert.ok(settled[1]!.text.includes(join(getActorScratchpadDir(cwd, 'sess', 'techne'), 'tool-results')), 'stored under tool-results with the usual preview');
    const small = await settleToolResults(items.slice(0, 2).map(item => ({...item, text: 'y'.repeat(100)})), cwd, 'sess', 'techne');
    assert.ok(small.every(item => !item.text.includes('<persisted-output>')), 'under the cap nothing is offloaded');
  } finally {await rm(cwd, {recursive: true, force: true});}
});

test('compaction turns archived images into [image: path] text and keeps only the recent ones inline', async () => {
  const f = await fixture(5);
  try {
    const contexts = f.manager();
    const {request, compacted} = await contexts.prepare(f.identity, f.base, f.signal, true);
    assert.equal(compacted, true);
    assert.equal(inline(request.messages), 2, 'only the two protected recent results keep their image');
    const texts = toolTexts(request.messages);
    for (let index = 1; index <= 3; index++) {
      const archived = texts.find(text => text.startsWith('Tool result archived') && text.includes('[image: /shots/' + index + '.png]'));
      assert.ok(archived, 'archived result ' + index + ' names its image file');
    }
    assert.ok(request.messages.every(message => message.role !== 'tool' || !message.text.startsWith('Tool result archived') || !message.images?.length));
  } finally {await rm(f.root, {recursive: true, force: true});}
});

test('over the image limit the oldest images are replaced in one saved batch and later requests stay prefix-identical', async () => {
  const f = await fixture(6);
  try {
    const contexts = f.manager(6);
    const under = await contexts.prepare(f.identity, f.base, f.signal);
    assert.equal(inline(under.request.messages), 6, 'at the limit nothing changes');
    await f.put('open', call(7)); await f.put('open', shot(7));
    const first = await contexts.prepare(f.identity, f.base, f.signal);
    assert.equal(inline(first.request.messages), 3, 'seven images over a limit of six drop to half the limit');
    const texts = toolTexts(first.request.messages);
    for (let index = 1; index <= 4; index++) assert.ok(texts.some(text => text.endsWith('[image: /shots/' + index + '.png]\n[image: /shots/' + index + '.png]')), 'image ' + index + ' became text');
    await f.put('open', call(8)); await f.put('open', shot(8));
    const second = await f.manager(6).prepare(f.identity, f.base, f.signal);
    assert.equal(inline(second.request.messages), 4, 'a fresh manager reads the saved decision and adds only the new image');
    const a = first.request.messages.map(message => JSON.stringify(message)), b = second.request.messages.map(message => JSON.stringify(message));
    const stable = a.length - 1;
    assert.deepEqual(b.slice(0, stable), a.slice(0, stable), 'the earlier bytes are untouched by the next request');
  } finally {await rm(f.root, {recursive: true, force: true});}
});

test('a request rejected for too many images downgrades the older half once, persistently', async () => {
  const f = await fixture(8);
  try {
    const contexts = f.manager();
    assert.equal(inline((await contexts.prepare(f.identity, f.base, f.signal)).request.messages), 8, 'no limit known, nothing is replaced up front');
    contexts.downgradeImages(f.identity);
    const retry = await contexts.prepare(f.identity, f.base, f.signal);
    assert.equal(inline(retry.request.messages), 4);
    assert.equal(inline((await f.manager().prepare(f.identity, f.base, f.signal)).request.messages), 4, 'the downgrade persists across managers');
    const error = providerFailure(400, {error: {type: 'invalid_request_error', message: 'Too many images in request: 9 > 8'}});
    assert.equal(error.diagnostic?.issue, 'too_many_images');
  } finally {await rm(f.root, {recursive: true, force: true});}
});
