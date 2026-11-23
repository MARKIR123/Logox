import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PlanBoard} from '../src/store/plans.js';
import {executePlan, PLAN_OP_FIELDS, type PlanArgs} from '../src/tools/coordination/PlanTool/PlanTool.js';
import {normalizeToolInput} from '../src/tools/normalize.js';
import {dropEmpty, onlyFields} from '../src/tools/filler.js';
import {normalizeAutomaInput} from '../src/tools/orchestration/AutomaTool/AutomaTool.js';
import {schemas, validateToolCall} from '../src/tools/index.js';
import {sendMessageSchema} from '../src/tools/coordination/SendMessageTool/SendMessageTool.js';

async function withBoard<T>(run: (board: PlanBoard) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-filler-'));
  try {return await run(new PlanBoard({cwd, sessionId: 's1', work: () => [], knownOwners: () => ['logox', 'kalon', 'techne', 'aletheia']}));}
  finally {await rm(cwd, {recursive: true, force: true, maxRetries: 50, retryDelay: 50});}
}

/** The way a call travels: validate (schema after normalisation), then execute with the parsed data. */
async function plan(board: PlanBoard, args: unknown) {
  const checked = validateToolCall({id: 'c', name: 'Plan', arguments: JSON.stringify(args)});
  if (!checked.valid) return {text: checked.error, isError: true};
  const parsed = schemas.Plan.parse(normalizeToolInput('Plan', args)) as PlanArgs;
  return executePlan(parsed, {caller: 'logox', board});
}

const FILLER = {parent: 'x', id: 'x', owner: 'x', after: [], acceptance: [], note: '', evidence: [], ops: []};

test('the recorded Plan call that was refused three times creates the plan with its nodes', async () => {
  await withBoard(async board => {
    const recorded = {op: 'create', title: 'Theme preview', nodes: [
      {title: 'Design', owner: 'kalon', after: [], acceptance: ['palette renders'], nodes: []},
      {title: 'Ship', owner: 'techne', after: [], acceptance: ['npm run check passes'], nodes: []}], ...FILLER};
    const result = await plan(board, recorded);
    assert.equal(result.isError, false, result.text);
    assert.match(board.describe(), /Design/);
    assert.match(board.describe(), /Ship/);
  });
});

test('filler on every op type is ignored, whatever the placeholder', async () => {
  await withBoard(async board => {
    assert.equal((await plan(board, {op: 'create', title: 'Work', nodes: [{title: 'One', owner: 'kalon'}, {title: 'Two', owner: 'techne'}], ...FILLER})).isError, false);
    const steps: Record<string, unknown>[] = [
      {op: 'add', parent: '1', nodes: [{title: 'Child', owner: 'kalon', after: [], acceptance: [], nodes: []}], id: 'x', owner: 'x', title: '', note: 'x', evidence: ['x'], after: ['x'], acceptance: ['x']},
      {op: 'update', id: '2', title: 'Two renamed', parent: 'x', nodes: [], evidence: ['x'], owner: '', after: [], acceptance: [], note: ''},
      {op: 'accept', id: '1.1', evidence: ['it works'], parent: 'x', title: 'x', owner: 'x', nodes: [{title: 'x'}], note: 'x', after: ['x'], acceptance: ['x']},
      {op: 'reopen', id: '1.1', parent: 'x', title: 'x', owner: 'x', evidence: ['x'], note: 'x', nodes: []},
      {op: 'remove', id: '1.1', parent: 'x', title: 'x', owner: 'x', evidence: ['x'], note: 'x', nodes: [], after: ['x']},
      {op: 'abandon', id: '2', parent: 'x', title: 'x', owner: 'x', evidence: ['x'], note: 'x', nodes: [], after: ['x']},
    ];
    for (const step of steps) {
      const result = await plan(board, {...step, ops: []});
      assert.equal(result.isError, false, `${step.op}: ${result.text}`);
    }
    assert.match(board.describe(), /Two renamed/);
  });
});

test('filler inside ops items and an empty ops list beside a single op are ignored', async () => {
  await withBoard(async board => {
    const result = await plan(board, {ops: [
      {op: 'create', title: 'Batch', nodes: [{title: 'A', owner: 'kalon'}], parent: 'x', id: 'x', note: '', evidence: []},
      {op: 'add', parent: '1', nodes: [{title: 'B', owner: 'techne', after: [], nodes: []}], id: 'x', owner: 'x'}]});
    assert.equal(result.isError, false, result.text);
    assert.match(board.describe(), /B/);
  });
});

test('real Plan errors still refuse with the field and the value', async () => {
  await withBoard(async board => {
    assert.equal((await plan(board, {op: 'create', title: 'Work', nodes: [{title: 'One', owner: 'kalon'}]})).isError, false);
    const noId = await plan(board, {op: 'update', title: 'x', parent: 'x'});
    assert.equal(noId.isError, true); assert.match(noId.text, /"update" needs id/);
    const unknown = await plan(board, {op: 'accept', id: '9', evidence: ['x'], ops: []});
    assert.equal(unknown.isError, true); assert.match(unknown.text, /9/);
    const unknownOwner = await plan(board, {op: 'update', id: '1', owner: 'nobody', note: ''});
    assert.equal(unknownOwner.isError, true); assert.match(unknownOwner.text, /nobody/);
    const noNodes = await plan(board, {op: 'add', parent: '1', nodes: []});
    assert.equal(noNodes.isError, true); assert.match(noNodes.text, /"add" needs nodes/);
    const both = await plan(board, {op: 'create', title: 'T', ops: [{op: 'remove', id: '1'}, {op: 'remove', id: '2'}]});
    assert.equal(both.isError, true);
    assert.match(both.text, /op is "create" and ops holds 2 ops/);
    const stray = await plan(board, {parent: 'x', title: 'T'});
    assert.equal(stray.isError, true); assert.match(stray.text, /parent="x"/);
  });
});

test('a bare update may still clear a note and a node keeps nothing the op does not name', async () => {
  await withBoard(async board => {
    await plan(board, {op: 'create', title: 'Work', nodes: [{title: 'One', owner: 'kalon'}]});
    assert.equal((await plan(board, {op: 'update', id: '1', note: 'remember'})).isError, false);
    assert.match(board.describe(), /remember/);
    assert.equal((await plan(board, {op: 'update', id: '1', note: ''})).isError, false);
    assert.doesNotMatch(board.describe(), /remember/);
  });
  assert.deepEqual(Object.keys(PLAN_OP_FIELDS).sort(), ['abandon', 'accept', 'add', 'create', 'remove', 'reopen', 'update']);
});

test('the helpers read [], "" and null as absent and keep what the caller names', () => {
  assert.deepEqual(dropEmpty({a: '', b: [], c: null, d: 0, e: false, f: ' ', g: 'x'}), {d: 0, e: false, g: 'x'});
  assert.deepEqual(dropEmpty({new_string: '', x: ''}, ['new_string']), {new_string: ''});
  assert.deepEqual(onlyFields({a: 1, b: 2}, ['b', 'c']), {b: 2});
});

test('audited tools accept filler for fields they do not use', () => {
  const actor = schemas.Actor.safeParse(normalizeToolInput('Actor', {tasks: [{ownerId: 'techne', prompt: 'do it', title: '', owns: [], acceptance: [], after: [], node: '', resumeTask: ''}], resumeBatch: '', briefCheck: '', continueAct: null}));
  assert.ok(actor.success, JSON.stringify(actor.error?.issues));
  const resume = schemas.Actor.safeParse(normalizeToolInput('Actor', {tasks: [], resumeBatch: 'b1', briefCheck: ''}));
  assert.ok(resume.success, JSON.stringify(resume.error?.issues));

  const send = sendMessageSchema.safeParse(normalizeToolInput('SendMessage', {to: 'logox', message: 'hi', type: '', mode: '', summary: '', wake: null}));
  assert.ok(send.success, JSON.stringify(send.error?.issues));

  const ask = schemas.AskUserQuestion.safeParse(normalizeToolInput('AskUserQuestion', {questions: [{question: 'Which?', header: 'Pick', options: [], multiSelect: null}]}));
  assert.ok(ask.success, JSON.stringify(ask.error?.issues));
  const choice = schemas.AskUserQuestion.safeParse(normalizeToolInput('AskUserQuestion', {questions: [{question: 'Which?', header: 'Pick', options: [{label: 'A', description: ''}, {label: 'B', description: ''}]}]}));
  assert.ok(choice.success, JSON.stringify(choice.error?.issues));

  const edit = schemas.Edit.safeParse(normalizeToolInput('Edit', {file_path: '/a.ts', old_string: 'x', new_string: '', replace_all: null}));
  assert.ok(edit.success, JSON.stringify(edit.error?.issues));
  assert.equal((edit.data as {new_string: string}).new_string, '', 'an empty replacement is a deletion, not filler');

  const cancel = schemas.CancelActor.safeParse(normalizeToolInput('CancelActor', {actor: 'techne', scope: 'tool', tool_id: '', reason: 'stuck'}));
  assert.ok(cancel.success, JSON.stringify(cancel.error?.issues));

  const automa = schemas.Automa.safeParse(normalizeAutomaInput({jobs: [], wait: ['T1'], release: [], context: '', style: '', mode: '', continueAct: null}));
  assert.ok(automa.success, JSON.stringify(automa.error?.issues));
});

test('validateToolCall applies the same normalisation', () => {
  const check = validateToolCall({id: 'c', name: 'Actor', arguments: JSON.stringify({tasks: [{ownerId: 'techne', prompt: 'do it', owns: [], node: ''}], resumeBatch: ''})});
  assert.equal(check.valid, true);
});
