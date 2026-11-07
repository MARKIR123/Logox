import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {executeShell, shellSchema} from '../src/tools/ShellTool/ShellTool.js';
import {executeShellJob} from '../src/tools/ShellJobTool/ShellJobTool.js';
import {killActiveProcess, killBackgroundJobs} from '../src/tools/process.js';
import {SHELL_DESCRIPTION} from '../src/tools/ShellTool/prompt.js';
import {schemas, descriptions} from '../src/tools/index.js';

const node = process.platform === 'win32' ? `& '${process.execPath}'` : `'${process.execPath}'`;
/** Writes a script into `cwd` and returns the shell command that runs it. */
async function script(cwd: string, name: string, code: string): Promise<string> {
  await writeFile(join(cwd, name), code);
  return node + ' ' + name;
}
const alive = (pid: number) => {try {process.kill(pid, 0); return true;} catch {return false;}};
const until = async (check: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {if (await check()) return true; await new Promise(r => setTimeout(r, 50));}
  return false;
};

test('run_in_background returns at once with an id and initial output, ShellJob reads and stops it', {timeout: 20_000}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-bg-'));
  try {
    const started = Date.now();
    const result = await executeShell(shellSchema.parse({command: await script(cwd, 'tick.js', "console.log('ready'); setInterval(() => console.log('tick'), 100);"), run_in_background: true, timeout: 1000}), cwd, new AbortController().signal, {activityId: 'act-bg', toolId: 'call-bg'});
    assert.ok(Date.now() - started < 5000, 'returned without waiting for the process');
    assert.equal(result.isError, false);
    const id = /Background job (job-\d+) \(pid (\d+)\)/.exec(result.text);
    assert.ok(id, result.text);
    assert.match(result.text, /ShellJob/);
    const pid = Number(id[2]);
    assert.ok(alive(pid));

    assert.ok(await until(async () => /tick/.test((await executeShellJob({id: id[1]!})).text)));
    const stopped = await executeShellJob({id: id[1]!, stop: true});
    assert.match(stopped.text, /stopp/);
    assert.ok(await until(() => !alive(pid)), 'process tree is gone after stop');
    assert.equal((await executeShellJob({id: 'job-missing'})).isError, true);
  } finally {killBackgroundJobs(); await rm(cwd, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});}
});

test('background jobs end with their activity, and the per-call stop reaches them', {timeout: 20_000}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-bg-'));
  try {
    const sleeper = await script(cwd, 'sleep.js', 'setInterval(() => {}, 1000);');
    const a = await executeShell(shellSchema.parse({command: sleeper, run_in_background: true}), cwd, new AbortController().signal, {activityId: 'act-1', toolId: 'call-1'});
    const b = await executeShell(shellSchema.parse({command: sleeper, run_in_background: true}), cwd, new AbortController().signal, {activityId: 'act-2', toolId: 'call-2'});
    const pidA = Number(/pid (\d+)/.exec(a.text)![1]), pidB = Number(/pid (\d+)/.exec(b.text)![1]);
    assert.equal(killBackgroundJobs('act-1'), 1);
    assert.ok(await until(() => !alive(pidA)));
    assert.ok(alive(pidB), 'another activity keeps its job');
    assert.equal(killActiveProcess('call-2', 'Stopped by user', 'user'), true);
    assert.ok(await until(() => !alive(pidB)));
  } finally {killBackgroundJobs(); await rm(cwd, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});}
});

test('a background command that fails reports its exit code and output through ShellJob', {timeout: 20_000}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-bg-'));
  try {
    const result = await executeShell(shellSchema.parse({command: await script(cwd, 'boom.js', "console.error('boom'); process.exit(3);"), run_in_background: true}), cwd, new AbortController().signal, {activityId: 'act-3', toolId: 'call-3'});
    const id = /Background job (job-\d+)/.exec(result.text)![1]!;
    let text = result.text;
    assert.ok(await until(async () => {text += ' ' + (await executeShellJob({id})).text; return /exited with code [13]/.test(text);}));
    assert.match(text, /boom/);
  } finally {killBackgroundJobs(); await rm(cwd, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});}
});

test('the Shell contract documents background mode and ShellJob is registered', () => {
  assert.match(SHELL_DESCRIPTION, /run_in_background: true/);
  assert.match(SHELL_DESCRIPTION, /ShellJob/);
  assert.ok('ShellJob' in schemas);
  assert.match(descriptions.ShellJob, /stop: true/);
});
