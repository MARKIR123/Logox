import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {agentRequestBase} from '../src/kernel/agent.js';
import {defaultToolRegistry} from '../src/tools/registry.js';
import {isVisibleToolMessage} from '../src/tools/ui-registry.js';
import {Tools} from '../src/tools/index.js';
import type {Message} from '../src/runtime/contracts.js';

test('agentRequestBase applies tool registry scoping for director, worker, and new dynamic actor', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-tools-integ-'));
  try {
    // 1. Director (logox)
    const logoxBase = await agentRequestBase(cwd, 'logox');
    const logoxToolNames = logoxBase.tools.map(t => t.name);
    assert.ok(logoxToolNames.includes('Read'));
    assert.ok(logoxToolNames.includes('Actor'));
    assert.ok(logoxToolNames.includes('CancelActor'));
    assert.ok(logoxToolNames.includes('_GitStatus'));
    assert.ok(logoxToolNames.includes('_FinishRound'));

    // 2. Worker actor (techne)
    const techneBase = await agentRequestBase(cwd, 'techne');
    const techneToolNames = techneBase.tools.map(t => t.name);
    assert.ok(techneToolNames.includes('Read'));
    assert.ok(techneToolNames.includes('SendMessage'));
    assert.ok(techneToolNames.includes('_GitStatus'));
    assert.ok(techneToolNames.includes('_FinishRound'));
    assert.equal(techneToolNames.includes('Actor'), false);
    assert.equal(techneToolNames.includes('CancelActor'), false);

    // 3. New dynamic actor created at runtime - zero code change required!
    const dynamicBase = await agentRequestBase(
      cwd,
      'dynamic-subagent-99',
      [],
      undefined,
      {
        prompt: 'You are a dynamic specialist.',
        visibility: {actorId: 'dynamic-subagent-99', skills: [], borrowed: []},
      }
    );
    const dynamicToolNames = dynamicBase.tools.map(t => t.name);
    assert.ok(dynamicToolNames.includes('Read'));
    assert.ok(dynamicToolNames.includes('SendMessage'));
    assert.ok(dynamicToolNames.includes('_GitStatus'));
    assert.ok(dynamicToolNames.includes('_FinishRound'));
    assert.equal(dynamicToolNames.includes('Actor'), false);
    assert.equal(dynamicToolNames.includes('CancelActor'), false);
  } finally {
    await rm(cwd, {recursive: true, force: true});
  }
});

test('isVisibleToolMessage returns false for silent tools like _GitStatus and _FinishRound', () => {
  const readMsg: Message = {
    id: 'm1',
    sessionId: 's1',
    ownerId: 'logox',
    role: 'assistant',
    text: '',
    kind: 'tool',
    step: {
      title: 'Read file',
      call: {id: 'c1', name: 'Read', arguments: '{}'},
      state: 'running',
      elapsedMs: 0,
    },
  };
  assert.equal(isVisibleToolMessage(readMsg), true);

  const gitStatusMsg: Message = {
    id: 'm2',
    sessionId: 's1',
    ownerId: 'logox',
    role: 'assistant',
    text: '',
    kind: 'tool',
    step: {
      title: 'Git Status',
      call: {id: 'c2', name: '_GitStatus', arguments: '{}'},
      state: 'running',
      elapsedMs: 0,
    },
  };
  assert.equal(isVisibleToolMessage(gitStatusMsg), false);

  const finishRoundMsg: Message = {
    id: 'm3',
    sessionId: 's1',
    ownerId: 'logox',
    role: 'assistant',
    text: '',
    kind: 'tool',
    step: {
      title: 'Finish Round',
      call: {id: 'c3', name: '_FinishRound', arguments: '{}'},
      state: 'running',
      elapsedMs: 0,
    },
  };
  assert.equal(isVisibleToolMessage(finishRoundMsg), false);
});

test('Tools.execute handles _GitStatus seamlessly', async () => {
  const tools = new Tools(process.cwd());
  const context = {
    sessionId: 'test-session',
    ownerId: 'techne',
    activityId: 'test-act',
    signal: new AbortController().signal,
  };

  const result = await tools.execute({
    id: 'call-git-status',
    name: '_GitStatus',
    arguments: JSON.stringify({mode: 'compact'}),
  }, context as any);

  assert.equal(result.isError, false);
  assert.ok(result.text.includes('Branch'));
});
