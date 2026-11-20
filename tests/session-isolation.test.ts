import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {PermissionEngine} from '../src/permissions/engine.js';
import {Mcp} from '../src/extensions/mcp.js';
import {mcpServerSchema} from '../src/extensions/config.js';
import {startBackgroundProcess, stopBackgroundJob, takeBackgroundOutput} from '../src/tools/process.js';
import {Snapshots} from '../src/tools/snapshots.js';
import type {ActorContext} from '../src/actors/ensemble.js';

function context(sessionId: string): ActorContext {
  return {sessionId, activityId: 'activity-' + sessionId, ownerId: 'logox', history: [], signal: new AbortController().signal,
    report() {}, say() {}, record: async () => {}, ask: async () => ({status: 'cancelled', reason: 'fixture'}), permission: async () => false};
}

test('session rules stay in one session; project rules reach every isolated session', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-rules-'));
  const engine = new PermissionEngine(cwd, 'default');
  try {
    engine.isolateSessions();
    await engine.add({scope: 'session', decision: 'allow', tool: 'write', pattern: 'a.txt'}, 'A');
    await engine.add({scope: 'session', decision: 'allow', tool: 'write', pattern: 'b.txt'}, 'B');
    const write = (file: string, session?: string) => engine.evaluate({tool: 'write', paths: [file], effect: 'write', risky: false}, session).decision;
    assert.equal(write('a.txt', 'A'), 'allow');
    assert.notEqual(write('a.txt', 'B'), 'allow');
    assert.equal(write('b.txt', 'B'), 'allow');
    assert.notEqual(write('b.txt', 'A'), 'allow');
    assert.deepEqual(engine.snapshot('A').filter(rule => rule.scope === 'session').map(rule => rule.pattern), ['a.txt']);

    await engine.add({scope: 'project', decision: 'deny', tool: 'write', pattern: 'secret.txt'});
    assert.equal(write('secret.txt', 'A'), 'deny');
    assert.equal(write('secret.txt', 'B'), 'deny');

    engine.clearSession('A');
    assert.notEqual(write('a.txt', 'A'), 'allow');
    assert.equal(write('b.txt', 'B'), 'allow', 'clearing A never drops B grants');
    assert.equal(write('secret.txt', 'B'), 'deny', 'project rules survive a session cleanup');
  } finally {await rm(cwd, {recursive: true, force: true});}
});

test('same call id in two sessions addresses two background jobs, and stopping one keeps the other', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-process-'));
  try {
    const script = 'setTimeout(() => {}, 30000)';
    const a = await startBackgroundProcess(process.execPath, ['-e', script], cwd, {activityId: 'activity-A', toolId: 'same-call', sessionId: 'A'}, 30);
    const b = await startBackgroundProcess(process.execPath, ['-e', script], cwd, {activityId: 'activity-B', toolId: 'same-call', sessionId: 'B'}, 30);
    try {
      assert.notEqual(a.id, b.id);
      assert.equal(stopBackgroundJob(a.id, 'B'), undefined, "a job id is not addressable from another session");
      assert.ok(stopBackgroundJob(a.id, 'A')?.stopped);
      await delay(50);
      assert.equal(takeBackgroundOutput(b.id, 'B')?.job.stopped, false, 'stopping the same call id in A never kills B');
    } finally {
      stopBackgroundJob(a.id, 'A'); stopBackgroundJob(b.id, 'B');
      for (let i = 0; i < 200 && (a.exitCode === undefined || b.exitCode === undefined); i++) await delay(10);
    }
  } finally {await rm(cwd, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});}
});

test('MCP clients are scoped by session and releaseSession touches only its own processes', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-mcp-scope-')), log = join(cwd, 'server.jsonl');
  const config = mcpServerSchema.parse({command: process.execPath, args: [resolve('tests/fixtures/mcp-server.mjs'), log, 'normal'], timeout: 2, startup_timeout_s: 1});
  const mcp = new Mcp(cwd, {fixture: config}, async () => true);
  const invoke = (value: number) => ({id: 'call-' + value, name: 'mcp', arguments: JSON.stringify({server: 'fixture', action: 'call', tool: 'echo', arguments: {value}})});
  const starts = async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as {pid?: number}).filter(event => event.pid !== undefined).map(event => event.pid!);
  try {
    assert.equal((await mcp.execute(invoke(1), context('A'))).text, 'echo:1');
    assert.equal((await mcp.execute(invoke(2), context('A'))).text, 'echo:2');
    assert.equal((await starts()).length, 1, 'one session reuses its own client');
    assert.equal((await mcp.execute(invoke(3), context('B'))).text, 'echo:3');
    const two = await starts();
    assert.equal(two.length, 2, 'a second session gets its own MCP process');

    await mcp.releaseSession('A');
    assert.equal((await mcp.execute(invoke(4), context('A'))).text, 'echo:4');
    const three = await starts();
    assert.equal(three.length, 3, 'A reconnects after its own release');
    assert.equal((await mcp.execute(invoke(5), context('B'))).text, 'echo:5');
    assert.deepEqual(await starts(), three, 'releasing A keeps the B process alive');
  } finally {
    await mcp.close();
    await rm(cwd, {recursive: true, force: true});
  }
});


test("undo is scoped to the named session and cannot roll back another session's file", async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'logox-undo-')));
  try {
    const fileA = join(cwd, 'a.txt'), fileB = join(cwd, 'b.txt');
    await writeFile(fileA, 'A0'); await writeFile(fileB, 'B0');
    const snapshots = new Snapshots(join(cwd, 'snapshots')), signal = new AbortController().signal;
    await snapshots.apply(fileA, Buffer.from('A0'), Buffer.from('A1'), 'activity-A', signal, 'logox', 'A');
    await snapshots.apply(fileB, Buffer.from('B0'), Buffer.from('B1'), 'activity-B', signal, 'logox', 'B');
    assert.deepEqual(await snapshots.changedPaths(['activity-A', 'activity-B'], 'A'), [fileA]);
    assert.deepEqual(await snapshots.undo(undefined, 'A'), [fileA]);
    assert.equal(await readFile(fileA, 'utf8'), 'A0');
    assert.equal(await readFile(fileB, 'utf8'), 'B1', "undoing A leaves B's newer write alone");
    assert.deepEqual(await snapshots.undo(['activity-B'], 'A'), []);
    assert.equal(await readFile(fileB, 'utf8'), 'B1');
    assert.deepEqual(await snapshots.undo(undefined, 'B'), [fileB]);
    assert.equal(await readFile(fileB, 'utf8'), 'B0');
  } finally {await rm(cwd, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});}
});
