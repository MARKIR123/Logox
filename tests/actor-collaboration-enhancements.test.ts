import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {executeListActors} from '../src/tools/ListActorsTool/ListActorsTool.js';
import {executeCancelActor} from '../src/tools/CancelActorTool/CancelActorTool.js';
import {ensureProjectBulletin, appendProjectBulletin} from '../src/actors/bulletin.js';
import {RuntimeStore} from '../src/runtime/store.js';

test('ListActors: Director receives full execution metrics with tool_id, companions receive sanitized view', () => {
  const store = new RuntimeStore();
  store.activities.create({
    sessionId: 'test-sess',
    activityId: 'act-1',
    ownerId: 'techne',
    kind: 'actor',
    title: 'Build UI Component',
    status: 'running',
    stage: '执行 · 动画生成',
    detail: 'Run tests',
  });
  store.message('test-sess', 'techne', 'assistant', 'Working on shell', {
    activityId: 'act-1',
    step: {
      title: 'Shell · Run tests',
      callId: 'tool-call-999',
      state: 'running',
      elapsedMs: 25000,
      runningSince: Date.now() - 25000,
    },
  });

  // 1. Director view: contains tool_id, currentTool, and elapsed
  const directorResult = executeListActors({}, {
    caller: 'logox',
    getSnapshot: () => store.getSnapshot(),
  });
  assert.equal(directorResult.isError, false);
  const directorData = JSON.parse(directorResult.text);
  const techneDirector = directorData.actors.find((a: any) => a.id === 'techne');
  assert.equal(techneDirector.status, 'busy');
  assert.equal(techneDirector.currentTool, 'Shell · Run tests');
  assert.equal(techneDirector.tool_id, 'tool-call-999');
  assert.equal(techneDirector.stage, '执行 · 动画生成');

  // 2. Peer actor view (e.g. kalon): sanitized, no tool_id or raw command metrics
  const peerResult = executeListActors({}, {
    caller: 'kalon',
    getSnapshot: () => store.getSnapshot(),
  });
  assert.equal(peerResult.isError, false);
  const peerData = JSON.parse(peerResult.text);
  const technePeer = peerData.actors.find((a: any) => a.id === 'techne');
  assert.equal(technePeer.status, 'busy');
  assert.equal(technePeer.stage, '执行 · 动画生成');
  assert.equal(technePeer.tool_id, undefined);
  assert.equal(technePeer.currentTool, undefined);
});

test('CancelActor: Director can cancel tool with reason; non-director is rejected', () => {
  let toolCancelled = false;
  let reasonRecorded = '';

  const context = {
    caller: 'logox',
    cancelTool: (actorId: string, toolId?: string, reason?: string) => {
      toolCancelled = true;
      reasonRecorded = reason || '';
      return {success: true, message: `Tool ${toolId} cancelled: ${reason}`};
    },
    cancelActivity: (actorId: string, reason?: string) => {
      return {success: true, message: `Activity cancelled: ${reason}`};
    },
  };

  // Director can cancel tool
  const result = executeCancelActor({
    actor: 'techne',
    scope: 'tool',
    tool_id: 'tool-call-999',
    reason: 'Process unresponsive for > 5m',
  }, context);

  assert.equal(result.isError, false);
  assert.ok(result.text.includes('Tool tool-call-999 cancelled'));
  assert.equal(toolCancelled, true);
  assert.equal(reasonRecorded, 'Process unresponsive for > 5m');

  // Non-director calling CancelActor is rejected with permission error
  const nonDirectorResult = executeCancelActor({
    actor: 'techne',
    scope: 'tool',
    reason: 'I want to cancel',
  }, {...context, caller: 'aletheia'});

  assert.equal(nonDirectorResult.isError, true);
  assert.equal(nonDirectorResult.disposition, 'denied');
});

test('Project Bulletin: creates .logox/bulletin.md with standard template and records entries with author and timestamp', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'logox-bulletin-'));
  try {
    const bulletinPath = await ensureProjectBulletin(dir);
    const initialContent = await readFile(bulletinPath, 'utf8');
    assert.ok(initialContent.includes('LOGOX Project Bulletin'));

    await appendProjectBulletin(dir, 'Techne', 'Browser Screenshot Gotchas', 'Avoid virtual-time-budget=0; use browser-shot CLI utility.');
    const updatedContent = await readFile(bulletinPath, 'utf8');
    assert.ok(updatedContent.includes('Techne · Browser Screenshot Gotchas'));
    assert.ok(updatedContent.includes('Avoid virtual-time-budget=0'));
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});
