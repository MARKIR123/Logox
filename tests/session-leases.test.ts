import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {mkdtemp, rm, readFile, rename, readdir, writeFile, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SessionManager} from '../src/store/sessions.js';

async function worker(cwd: string, pauseBeforePublish = false) {
  const module = new URL('../src/store/sessions.js', import.meta.url).href;
  const script = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    import {SessionManager} from ${JSON.stringify(module)};
    if (${pauseBeforePublish}) {
      const rename = fs.promises.rename;
      fs.promises.rename = async (a, b) => {
        if (String(b).endsWith('.lock')) {process.stdout.write('READY\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);}
        return rename(a, b);
      };
      syncBuiltinESMExports();
    }
    const manager = await SessionManager.open(process.argv[1]);
    try {await manager.acquire('same'); process.stdout.write('READY\\n'); setInterval(() => {}, 1000);}
    catch(e) {process.stdout.write('BLOCKED\\n'); if (!e.message.includes('占用')) {console.error(e); process.exitCode=1;}}`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, cwd], {stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
  const exit = once(child, 'exit');
  let errors = '', output = '';
  child.stderr.on('data', chunk => {errors += String(chunk);});
  const ready = new Promise<'READY' | 'BLOCKED'>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('lease worker timeout: ' + errors)), 5000);
    child.stdout.on('data', chunk => {
      output += String(chunk);
      for (const state of ['READY', 'BLOCKED'] as const) if (output.includes(state + '\n')) {clearTimeout(timeout); resolve(state);}
    });
    child.once('error', error => {clearTimeout(timeout); reject(error);});
    child.once('exit', code => {clearTimeout(timeout); if (!output) reject(new Error('lease worker exited ' + code + ': ' + errors));});
  });
  const kill = async () => {if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exit;};
  return {child, ready, kill};
}

test('真实申请在原子发布前强杀：短期锁自动回收，没有半租约；持有长期租约强杀也能恢复', async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'logox-lease-kill-'))), manager = await SessionManager.open(cwd);
  const file = join(manager.directory, 'locks', createHash('sha256').update('same').digest('hex') + '.lock');
  const before = await worker(cwd, true);
  try {
    assert.equal(await before.ready, 'READY');
    assert.equal((await readdir(file + '.claim.lock-v2')).length, 1);
    await assert.rejects(readFile(file), {code: 'ENOENT'});
    await before.kill();
    const lease = await manager.acquire('same');
    assert.equal(JSON.parse(await readFile(file, 'utf8')).pid, process.pid); await lease.release();
    const held = await worker(cwd);
    try {
      assert.equal(await held.ready, 'READY');
      await assert.rejects(manager.acquire('same'), /占用/);
      assert.equal(JSON.parse(await readFile(file, 'utf8')).pid, held.child.pid);
      await held.kill(); const recovered = await manager.acquire('same'); await recovered.release();
    } finally {await held.kill();}
  } finally {await before.kill(); await rm(cwd, {recursive: true, force: true});}
});

test('四个真实进程并发申请只有一个持有者；旧释放不删除替换租约，重复释放安全', async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'logox-lease-race-'))), manager = await SessionManager.open(cwd);
  const workers = await Promise.all(Array.from({length: 4}, () => worker(cwd)));
  const file = join(manager.directory, 'locks', createHash('sha256').update('same').digest('hex') + '.lock');
  try {
    const states = await Promise.all(workers.map(item => item.ready));
    assert.equal(states.filter(state => state === 'READY').length, 1);
    const winner = workers[states.indexOf('READY')]!;
    assert.equal(JSON.parse(await readFile(file, 'utf8')).pid, winner.child.pid);
    await winner.kill();
    const previous = await manager.acquire('same');
    await rename(file, file + '.previous');
    const replacement = await manager.acquire('same'), bytes = await readFile(file, 'utf8');
    await assert.rejects(previous.release(), /拥有者发生变化/);
    assert.equal(await readFile(file, 'utf8'), bytes);
    await Promise.all([replacement.release(), replacement.release()]);
    await assert.rejects(readFile(file), {code: 'ENOENT'});
    await writeFile(file, '{broken'); await assert.rejects(manager.acquire('same'), /损坏/);
    assert.equal(await readFile(file, 'utf8'), '{broken');
  } finally {await Promise.all(workers.map(item => item.kill())); await rm(cwd, {recursive: true, force: true});}
});
