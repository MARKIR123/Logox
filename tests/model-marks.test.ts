import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ModelMarkStore, deriveTier, deriveVision, familyTier, likelyToolCapable, marksText} from '../src/providers/model-marks.js';
import {ModelTable, type ModelRow} from '../src/providers/model-table.js';
import {omitImages, imageOmittedText} from '../src/providers/vision-fallback.js';
import type {ModelMessage} from '../src/runtime/messages.js';

const row = (id: string, input: number, modalities = 'text,image', name = id): ModelRow => [id, name, 128000, 0, modalities, '', [input, input * 4, 0, 0]];
/** `acme` has eight priced models (quartiles), `tiny` three (absolute thresholds), `claude` the known families. */
const table = new ModelTable({source: 'test', version: '1', providers: {
  acme: {subscription: false, models: [0.1, 0.2, 0.5, 1, 2, 4, 8, 16].map((price, index) => row('acme-m' + index, price, index === 0 ? 'text' : 'text,image'))},
  tiny: {subscription: false, models: [row('tiny-a', 0.5), row('tiny-b', 5), row('tiny-c', 10)]},
  claude: {subscription: false, models: [row('x1', 3, 'text,image', 'Claude Opus 9'), row('plain-free', 0)]},
}});

test('known families map by id or catalog name, case-insensitively, before any price', () => {
  assert.equal(deriveTier('any', 'claude-haiku-4-5', {}, table), 1);
  assert.equal(deriveTier('any', 'CLAUDE-SONNET-4-6', {}, table), 2);
  assert.equal(deriveTier('any', 'claude-opus-4-6-high', {}, table), 3);
  assert.equal(deriveTier('any', 'Fable-5', {}, table), 4);
  assert.equal(deriveTier('any', 'mythos-preview', {}, table), 4);
  assert.equal(deriveTier('claude', 'x1', {}, table), 3, 'the catalog name Claude Opus 9 names the family');
  assert.equal(familyTier('gpt-5'), undefined);
});

test('other models rank by input price in quartiles within their provider', () => {
  const tiers = Array.from({length: 8}, (_, index) => deriveTier('acme', 'acme-m' + index, {}, table));
  assert.deepEqual(tiers, [1, 1, 2, 2, 3, 3, 4, 4]);
});

test('a provider with fewer than four priced models maps by absolute input price', () => {
  assert.equal(deriveTier('tiny', 'tiny-a', {}, table), 1, 'under $0.8');
  assert.equal(deriveTier('tiny', 'tiny-b', {}, table), 3, 'under $8');
  assert.equal(deriveTier('tiny', 'tiny-c', {}, table), 4, '$8 and over');
});

test('a model with no price and no family is T2; an unknown model sees images, a known one by its modalities', () => {
  assert.equal(deriveTier('nowhere', 'mystery-1', {}, table), 2);
  assert.equal(deriveTier('claude', 'plain-free', {}, table), 2, 'a zero price is no price');
  assert.equal(deriveVision('nowhere', 'mystery-1', {}, table), true);
  assert.equal(deriveVision('acme', 'acme-m0', {}, table), false, 'the catalog row lists text only');
  assert.equal(deriveVision('acme', 'acme-m1', {}, table), true);
  assert.equal(likelyToolCapable('text-embedding-3-small'), false);
  assert.equal(likelyToolCapable('claude-sonnet-4-6'), true);
});

test('user overrides win, persist, fall back to the family of a variant, and clear back to the derived value', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'logox-marks-'));
  try {
    const path = join(dir, 'model-tiers.json'), store = new ModelMarkStore(path, table);
    assert.deepEqual(store.marks('acme', 'acme-m0'), {tier: 1, vision: false, derived: {tier: true, vision: true}});
    await store.setTier('acme', 'acme-m0', 4);
    await store.setVision('acme', 'acme-m0', true);
    assert.deepEqual(store.marks('acme', 'acme-m0'), {tier: 4, vision: true, derived: {tier: false, vision: false}});
    assert.equal(marksText(store.marks('acme', 'acme-m0')), 'T4 ◉');
    assert.deepEqual(store.marks('acme', 'acme-m0-high').derived, {tier: false, vision: false}, 'a variant reads its family override');
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {version: 1, models: {'acme/acme-m0': {tier: 4, vision: true}}});
    // A second process (a new store on the same file) sees the saved values.
    assert.equal(new ModelMarkStore(path, table).marks('acme', 'acme-m0').tier, 4);
    await store.clear('acme', 'acme-m0');
    assert.deepEqual(store.marks('acme', 'acme-m0'), {tier: 1, vision: false, derived: {tier: true, vision: true}});
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {version: 1, models: {}});
  } finally {await rm(dir, {recursive: true, force: true});}
});

test('a corrupt marks file is ignored for reading and never overwritten', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'logox-marks-bad-'));
  try {
    const path = join(dir, 'model-tiers.json');
    await writeFile(path, '{not json');
    const store = new ModelMarkStore(path, table);
    assert.equal(store.marks('acme', 'acme-m7').tier, 4, 'derived values still answer');
    await assert.rejects(store.setTier('acme', 'acme-m7', 1));
    assert.equal(await readFile(path, 'utf8'), '{not json', 'the original file is preserved');
    await writeFile(path, JSON.stringify({version: 1, models: {'acme/acme-m7': {tier: 9}}}));
    assert.equal(new ModelMarkStore(path, table).marks('acme', 'acme-m7').tier, 4, 'an invalid value is ignored too');
  } finally {await rm(dir, {recursive: true, force: true});}
});

test('omitImages replaces each image with a line for its audience and leaves messages without images alone', () => {
  const image = {data: 'AAAA', mimeType: 'image/png'};
  const messages: ModelMessage[] = [{role: 'user', text: 'look', images: [image, image]}, {role: 'tool', callId: 'c', name: 'Read', isError: false, text: 'shot', images: [image]}, {role: 'assistant', text: 'ok'}];
  const worker = omitImages(messages, 'p/m', 'worker');
  assert.equal(worker.omitted, 3);
  assert.equal(worker.messages[0]!.text, 'look\n' + imageOmittedText('p/m', 'worker') + '\n' + imageOmittedText('p/m', 'worker'));
  assert.match(imageOmittedText('p/m', 'worker'), /^\[Image omitted: p\/m cannot see images\.\] The dispatcher should resend the job with vision: true\.$/);
  assert.match(imageOmittedText('p/m', 'actor'), /^\[Image omitted: p\/m cannot see images\.\] Ask the user to choose a model that can see images for this actor\.$/);
  assert.ok(worker.messages.every(message => !('images' in message)));
  assert.equal(messages[0]!.role === 'user' && messages[0]!.images?.length, 2, 'the input is not changed');
  const none = omitImages([messages[2]!], 'p/m', 'actor');
  assert.equal(none.omitted, 0);
});
