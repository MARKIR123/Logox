import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../src/application.js';
import {loadConfig} from '../src/config/config.js';
import {ActorCatalog} from '../src/actors/catalog.js';
import {builtinActors} from '../src/actors/builtins.js';
import {acquireFileLock} from '../src/store/file-lock.js';
import type {ModelRequest, Provider} from '../src/runtime/messages.js';
import {legacyCompression} from './compression-fixture.js';

const grammar = '<number> | <title> | <status>[; <verification>] | <carry-forward> | <start>:<end>';
async function migration() {
  const path = '../src/actors/compression-migration.js';
  const value = await import(path).catch(() => undefined);
  assert.equal(typeof value?.refreshShippedCompression, 'function', 'Managed default compression migration must exist');
  return value.refreshShippedCompression as (path: string, id: string, expected: string) => Promise<'updated' | 'preserved'>;
}

test('each actual role request receives one common memory contract and one resident focus', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-compression-contract-'));
  const seen: ModelRequest[] = [];
  const provider: Provider = {async respond(request) {
    seen.push(request);
    return {stop: 'tools', message: {role: 'assistant', text: 'Normal response', toolCalls: [{id: 'finish-' + seen.length, name: '_FinishRound', arguments: JSON.stringify({title: 'Answered request', verification: null, carry_forward: []})}]}};
  }};
  const config = await loadConfig(cwd, {provider: {model: 'fixture', context_window: 131072}}, {}, cwd, cwd);
  const app = await createApplication({cwd, sessionId: 's', config, env: {}, provider, authPath: join(cwd, 'auth.json'), resourceOptions: {home: cwd, boundary: cwd}});
  try {
    for (const role of builtinActors) {
      await app.ensemble.dispatch(role.id, 'Explain normally', 'direct', {inputKind: 'human'}).done;
      const request = seen.at(-1)!;
      assert.equal(request.system.split(grammar).length - 1, 1, role.id);
      assert.equal(request.system.split(role.compression).length - 1, 1, role.id);
      assert.ok(request.tools.some(tool => tool.name === '_FinishRound'));
      assert.ok(!request.system.includes('[Round Summary]') && !request.system.includes('250 words') && !request.system.includes('Exports & Changes'));
      assert.match(request.system, /Only when this round was formally assigned by Director/);
      assert.ok(!role.compression.includes('_FinishRound') && !role.compression.includes(grammar));
      const priorities = {logox: /global|dependencies|acceptance/i, techne: /implementation|test commands|blockers/i, aletheia: /facts|hypotheses|evidence/i, kalon: /design|visual verification|tokens/i};
      assert.match(role.compression, priorities[role.id as keyof typeof priorities]);
    }
    assert.equal(seen.length, 4);
  } finally {await app.close(); await rm(cwd, {recursive: true, force: true});}
});

test('only unchanged shipped defaults migrate; custom and concurrently edited content remains intact', async () => {
  const refresh = await migration();
  const root = await mkdtemp(join(tmpdir(), 'logox-compression-migration-'));
  try {
    for (const role of builtinActors) {
      const path = join(root, role.id, 'compression.md');
      await mkdir(join(root, role.id), {recursive: true});
      const old = legacyCompression[role.id]!;
      await writeFile(path, old);
      assert.equal(await refresh(path, role.id, old), 'updated');
      assert.equal((await readFile(path, 'utf8')).trim(), role.compression);
      await writeFile(path, 'Custom memory focus\n');
      assert.equal(await refresh(path, role.id, 'Custom memory focus\n'), 'preserved');
      assert.equal(await readFile(path, 'utf8'), 'Custom memory focus\n');
      await writeFile(path, old);
      const release = await acquireFileLock(path);
      let pending: Promise<'updated' | 'preserved'>;
      try {
        pending = refresh(path, role.id, old);
        await writeFile(path, 'User edited while migration waited\n');
      } finally {await release();}
      assert.equal(await pending!, 'preserved');
      assert.equal(await readFile(path, 'utf8'), 'User edited while migration waited\n');
      assert.equal(await refresh(join(root, 'absent.md'), role.id, old), 'preserved');
      assert.equal(await refresh(path, 'custom-actor', old), 'preserved');
    }
  } finally {await rm(root, {recursive: true, force: true});}
});

test('catalog refresh leaves persona, configuration, custom focus and model bindings byte-identical', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-compression-catalog-'));
  try {
    const actors = join(root, '.logox', 'actors');
    const before = new Map<string, string>();
    for (const role of builtinActors) {
      const directory = join(actors, role.id);
      await mkdir(directory, {recursive: true});
      const config = `id: ${role.id}\nname: ${role.name}\ntitle: Custom title\ndescription: Custom description\ncolor: "#123456"\nsymbol: ${role.symbol}\n`;
      const persona = 'Custom persona ' + role.id + '\n';
      for (const [name, content] of [['config.yaml', config], ['persona.md', persona]]) {
        const path = join(directory, name!); before.set(path, content!); await writeFile(path, content!);
      }
      await writeFile(join(directory, 'compression.md'), role.id === 'kalon' ? 'Custom design memory' : legacyCompression[role.id]!);
    }
    const modelPath = join(root, '.logox', 'actor-models.json');
    await writeFile(modelPath, JSON.stringify({techne: {provider: 'fixture', model: 'custom'}}));
    const models = await readFile(modelPath, 'utf8');
    const catalog = new ActorCatalog(root, {home: root});
    const snapshot = await catalog.load();
    assert.deepEqual(snapshot.issues, []);
    for (const role of builtinActors) {
      const expected = role.id === 'kalon' ? 'Custom design memory' : role.compression;
      assert.equal(catalog.find(role.id)?.compression, expected);
      assert.equal((await readFile(join(actors, role.id, 'compression.md'), 'utf8')).trim(), expected);
    }
    for (const [path, text] of before) assert.equal(await readFile(path, 'utf8'), text);
    assert.equal(await readFile(modelPath, 'utf8'), models);
  } finally {await rm(root, {recursive: true, force: true});}
});
