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

test('SendMessage: injects into active task without opening a new card, and drainInbox delivers message', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'logox-collab-active-'));
  const journal = new (await import('../src/store/journal.js')).Journal(dir);
  const store = new RuntimeStore();
  const {DynamicEnsemble} = await import('../src/actors/ensemble.js');
  const {Collaboration} = await import('../src/actors/collaboration.js');

  let taskStartedResolve!: () => void;
  const taskStarted = new Promise<void>(resolve => { taskStartedResolve = resolve; });
  let completeTaskResolve!: () => void;
  const completeTask = new Promise<void>(resolve => { completeTaskResolve = resolve; });

  let techneContext: any;
  const ensemble = new DynamicEnsemble('s1', store, journal, async (_prompt, context) => {
    techneContext = context;
    taskStartedResolve();
    await completeTask;
  }, {
    member: owner => ({name: owner, title: '角色'}),
  });

  const collaboration = new Collaboration({
    sessionId: 's1',
    journal,
    member: owner => ['logox', 'techne', 'kalon'].includes(owner),
    enqueue: (owner, prompt, source) => ensemble.dispatch(owner, prompt, source),
    getActiveTask: owner => ensemble.getActiveTask(owner),
    injectMessage: (target, msg, src, sum, mode) => ensemble.injectTaskMessage(target, msg, src, sum, mode),
  });

  try {
    // 1. Dispatch long-running task to techne
    const handle = ensemble.dispatch('techne', '开始实现驱动');
    await taskStarted;

    // Verify techne has 1 active task running
    assert.ok(ensemble.getActiveTask('techne'));
    assert.equal(store.activities.list().filter(a => a.ownerId === 'techne').length, 1);

    // 2. Logox calls SendMessage to techne while techne is running
    const result = await collaboration.execute({
      id: 'send-1',
      name: 'SendMessage',
      arguments: JSON.stringify({
        to: 'techne',
        message: '口径确认，你的判定是对的，照此执行。',
        summary: '确认口径',
        mode: 'queue',
      }),
    }, {
      sessionId: 's1',
      ownerId: 'logox',
      activityId: 'logox-act-1',
      history: [],
      signal: new AbortController().signal,
      report() {},
      say() {},
      async record() {},
      async ask() { return {status: 'cancelled', reason: 'test'}; },
      async permission() { return true; },
    });

    assert.equal(result.isError, false);
    assert.ok(result.text.includes('without creating a new card'), `Result should indicate no new card was created: ${result.text}`);

    // 3. Verify STILL only 1 activity (card) for techne in store (ZERO card fragmentation!)
    const techneActivities = store.activities.list().filter(a => a.ownerId === 'techne');
    assert.equal(techneActivities.length, 1, 'MUST NOT create a second card/activity for an active actor');

    // 4. Verify message was received in techneContext's inbox!
    assert.ok(typeof techneContext.drainInbox === 'function');
    const drained = techneContext.drainInbox();
    assert.equal(drained.length, 1);
    assert.match(drained[0].text, /口径确认，你的判定是对的/);
    assert.match(drained[0].text, /确认口径/);

    // After draining, inbox is empty
    assert.equal(techneContext.drainInbox().length, 0);

    // Complete techne task
    completeTaskResolve();
    await handle.done;
  } finally {
    completeTaskResolve();
    await ensemble.close();
    await rm(dir, {recursive: true, force: true});
  }
});

test('UpdateTaskProgressTool: registered in tools/index, aliases update_task_progress to UpdateTaskProgress', async () => {
  const {canonicalToolName, schemas, descriptions} = await import('../src/tools/index.js');
  const {UPDATE_TASK_PROGRESS_TOOL_NAME, UPDATE_TASK_PROGRESS_DESCRIPTION} = await import('../src/tools/UpdateTaskProgressTool/prompt.js');

  assert.equal(canonicalToolName('update_task_progress'), 'UpdateTaskProgress');
  assert.equal(canonicalToolName('UpdateTaskProgress'), 'UpdateTaskProgress');
  assert.equal(canonicalToolName('updatetaskprogress'), 'UpdateTaskProgress');

  assert.equal(UPDATE_TASK_PROGRESS_TOOL_NAME, 'UpdateTaskProgress');
  assert.ok(schemas.UpdateTaskProgress, 'schemas.UpdateTaskProgress must be exported');
  assert.equal(descriptions.UpdateTaskProgress, UPDATE_TASK_PROGRESS_DESCRIPTION);

  // Validate schema accepting stages and update
  const valid = schemas.UpdateTaskProgress.safeParse({
    stages: [{id: 's1', title: 'T1', purpose: 'P1', activeForm: 'A1'}],
    update: {id: 's1', status: 'in_progress'},
  });
  assert.equal(valid.success, true);
});

