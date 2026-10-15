import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {StateFile, preferenceSchema} from '../src/config/model-preferences.js';
import {acquireFileLock} from '../src/store/file-lock.js';
import {UsageLedger} from '../src/context/usage.js';
import type {UsageRecord} from '../src/context/budget.js';

const preference = {version: 1 as const, provider: 'synthetic', model: 'first', effort: 'auto' as const};
async function heldState(path: string, ledger = false) {
  const module = new URL('../src/config/model-preferences.js', import.meta.url).href;
  const budgetModule = new URL('../src/context/budget.js', import.meta.url).href;
  const code = `import {StateFile, preferenceSchema} from ${JSON.stringify(module)};
    import {usageRecordSchema} from ${JSON.stringify(budgetModule)};
    import {z} from 'zod';
    const file = new StateFile(process.argv[1], ${ledger ? 'z.array(usageRecordSchema)' : 'preferenceSchema'});
    await file.update(() => {
      process.stdout.write('LOCKED\\n');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      return ${JSON.stringify(preference)};
    });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, path], {stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
  const exited = once(child, 'exit');
  let output = '', errors = '';
  child.stderr.on('data', chunk => {errors += String(chunk);});
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child did not hold lock: ' + errors)), 5000);
    child.stdout.on('data', chunk => {output += String(chunk); if (output.includes('LOCKED\n')) {clearTimeout(timer); resolve();}});
    child.once('error', error => {clearTimeout(timer); reject(error);});
    child.once('exit', () => {clearTimeout(timer); reject(new Error('child exited before ready: ' + errors));});
  }).catch(async error => {child.kill('SIGKILL'); await exited; throw error;});
  return {child, async kill() {child.kill('SIGKILL'); await exited;}};
}

test('真实子进程持锁后强杀，StateFile保存自动恢复且保留原状态', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-state-lock-')), path = join(root, 'state.json');
  const file = new StateFile(path, preferenceSchema);
  await file.save(preference);
  const held = await heldState(path);
  try {
    await held.kill();
    await file.save({...preference, model: 'recovered'});
    assert.equal(JSON.parse(await readFile(path, 'utf8')).model, 'recovered');
  } finally {if (held.child.exitCode === null && held.child.signalCode === null) await held.kill(); await rm(root, {recursive: true, force: true});}
});

test('真实活进程锁即使等待超时仍保留，死亡后才允许恢复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-live-state-lock-')), path = join(root, 'state.json');
  const file = new StateFile(path, preferenceSchema); await file.save(preference);
  const held = await heldState(path), lock = path + '.lock-v2';
  try {
    const before = await readdir(lock); assert.equal(before.length, 1); assert.match(before[0]!, new RegExp('^owner-' + held.child.pid + '-'));
    await assert.rejects(file.save({...preference, model: 'must-not-write'}), /另一个进程/);
    assert.deepEqual(await readdir(lock), before);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).model, 'first');
    assert.equal(held.child.exitCode, null); assert.equal(held.child.signalCode, null);
    await held.kill(); await file.save({...preference, model: 'after-death'});
    assert.equal(JSON.parse(await readFile(path, 'utf8')).model, 'after-death');
  } finally {if (held.child.exitCode === null && held.child.signalCode === null) await held.kill(); await rm(root, {recursive: true, force: true});}
});

test('释放只删除自己的随机身份；替换后的有效锁不会被旧finally删除', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-owner-state-lock-')), path = join(root, 'state.json');
  const release = await acquireFileLock(path), directory = path + '.lock-v2';
  try {
    await rename(directory, join(root, 'previous-owner'));
    const releaseReplacement = await acquireFileLock(path), before = await readdir(directory);
    try {await release(); assert.deepEqual(await readdir(directory), before);}
    finally {await releaseReplacement();}
    await assert.rejects(readdir(directory), {code: 'ENOENT'});
  } finally {await rm(root, {recursive: true, force: true});}
});

test('强杀后的UsageLedger继续保存；多个真实进程并发回收不丢记录或偷有效锁', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-ledger-state-lock-')), messages: string[] = [];
  const ledger = new UsageLedger(root, message => messages.push(message));
  const record: UsageRecord = {id: 'first', model: 'synthetic', category: 'task', input: 3, output: 1, cacheRead: 1, cacheWrite: 0};
  ledger.record('session', 'logox', record); await ledger.flush();
  const file = (await readdir(root)).find(name => name.endsWith('.json'))!;
  const held = await heldState(join(root, file), true);
  try {
    await held.kill();
    const module = new URL('../src/context/usage.js', import.meta.url).href;
    const children = Array.from({length: 4}, (_, index) => {
      const code = `import {UsageLedger} from ${JSON.stringify(module)};
        const ledger = new UsageLedger(process.argv[1], message => {throw new Error(message);});
        ledger.record('session', 'logox', ${JSON.stringify({...record, id: 'worker-' + index})});
        await ledger.flush();`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', code, root], {stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true});
      let errors = ''; child.stderr.on('data', chunk => {errors += String(chunk);});
      return {child, done: once(child, 'exit').then(([exit]) => {assert.equal(exit, 0, errors);})};
    });
    const results = await Promise.allSettled(children.map(child => child.done));
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    const records = await ledger.read('session', 'logox'); assert.equal(records.length, 5);
    assert.equal(new Set(records.map(item => item.id)).size, 5); assert.deepEqual(messages, []);
    await assert.rejects(readdir(join(root, file + '.lock-v2')), {code: 'ENOENT'});
  } finally {if (held.child.exitCode === null && held.child.signalCode === null) await held.kill(); await rm(root, {recursive: true, force: true});}
});

test('空v2锁可完成中断清理；无身份旧锁、损坏身份均保留且诊断', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-invalid-state-lock-')), path = join(root, 'state.json');
  try {
    await mkdir(path + '.lock-v2'); const release = await acquireFileLock(path); await release();
    await mkdir(path + '.lock'); await assert.rejects(acquireFileLock(path), /旧版状态锁/);
    assert.deepEqual(await readdir(path + '.lock'), []);
    await rm(path + '.lock', {recursive: true});
    await mkdir(path + '.lock-v2');
    await writeFile(join(path + '.lock-v2', 'owner-broken.json'), 'broken');
    await assert.rejects(acquireFileLock(path), /身份无法读取/);
    assert.equal(await readFile(join(path + '.lock-v2', 'owner-broken.json'), 'utf8'), 'broken');
  } finally {await rm(root, {recursive: true, force: true});}
});

test('并发保存反复交接空锁目录，Windows竞争不会中断保存或同时进入', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-handoff-lock-')), path = join(root, 'state.json');
  const file = new StateFile(path, preferenceSchema);
  try {
    await file.save(preference);
    for (let round = 0; round < 12; round++) {
      let inside = 0;
      await Promise.all(Array.from({length: 6}, async (_, index) => {
        const release = await acquireFileLock(path);
        try {
          assert.equal(inside++, 0, '保存操作互斥');
          await delay(1);
          await writeFile(path, JSON.stringify({...preference, model: 'round-' + round + '-' + index}));
          inside--;
        } finally {await release();}
      }));
      assert.match(JSON.parse(await readFile(path, 'utf8')).model, new RegExp('^round-' + round + '-'));
    }
    await assert.rejects(readdir(path + '.lock-v2'), {code: 'ENOENT'});
  } finally {await rm(root, {recursive: true, force: true});}
});
