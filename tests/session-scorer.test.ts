import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, utimes, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

interface Score {
  session: {label: string; others: {id: string}[]; wallMs: number | null};
  roots: {finalReports: number; wakes: number; lateWakes: number; lateWakeReports: number; wallMs: number | null}[];
  stages: Record<string, {turns: number; withStage: number; share: number | null; distinct: number | null}>;
  roundClosing: Record<string, {rounds: number; same: number; separate: number; silent: number; never: number}>;
  failures: {failedTasks: number; emptyReplyFailures: number; modelErrorEvents: number};
  writes: {refusals: number; savedRecorded: number};
  preview: {serverStarts: number; backgroundStarts: number; portConflicts: number; navigations: {file: number; localHttp: number}};
  messaging: {bySender: Record<string, {reply: number; inform: number; ask: number; other: number}>; toLogox: number; total: number};
  automa: {dispatches: number; jobs: number; jobFailures: number; keep: number; continue: number; release: number};
  usage: {recorded: boolean; total: {input: number; output: number}};
  interruptions: {userInterrupts: number; directorStops: number; cancelActorCalls: number};
  missing: string[];
}
const scorer = await import(new URL('../../scripts/score-session.mjs', import.meta.url).href) as {
  scoreSession(dir: string, options?: {others?: unknown[]}): Score;
  resolveSession(path: string): {dir: string; others: {id: string}[]};
  renderTable(scores: Score[]): string;
};

const SESSION = 's1';
const ROOT = 'root';
const call = (name: string, args: Record<string, unknown>) => ({id: name + Math.random(), name, arguments: JSON.stringify(args)});
let clock = 1_000_000;
const tick = () => clock += 1000;
const assistant = (ownerId: string, activityId: string, text: string, toolCalls: unknown[] = [], stage?: string) => ({
  ownerId, role: 'assistant', text, time: tick(), activityId, message: {role: 'assistant', text, toolCalls, ...(stage ? {stage} : {})}});
const tool = (ownerId: string, activityId: string, name: string, text: string, isError = false) => ({
  ownerId, role: 'tool', text, time: tick(), activityId, message: {role: 'tool', text, name, isError}});
const human = (text: string) => ({ownerId: 'logox', role: 'user', text, time: tick(), activityId: ROOT, inputKind: 'human', message: {role: 'user', text}});
const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const REPORT = 'Done. **Open [index.html](./index.html)** to watch the animation; everything is inline and works offline.';

/** Writes the smallest session the scorer reads: one root, one Director dispatch, two wakes (the second one late), one failed Kalon task. */
async function writeSession(dir: string): Promise<void> {
  clock = 1_000_000;
  await mkdir(join(dir, 'subagents'), {recursive: true});
  const director = [
    human('Build a page'),
    assistant('logox', ROOT, 'On it.', [call('Actor', {tasks: []})], 'Plan the page'),
    assistant('logox', ROOT, '', [call('Shell', {command: 'python -m http.server 8765', run_in_background: true}),
      call('SendMessage', {to: 'techne', type: 'inform', message: 'hi'}),
      call('mcp', {server: 'playwright', action: 'call', tool: 'browser_navigate', arguments: {url: 'file:///x/index.html'}}),
      call('Automa', {jobs: [{brief: 'check', keep: true, continue: '/'}], release: ['/']})]),
    assistant('logox', ROOT, 'Waiting for the team.', [call('_FinishRound', {title: 'wait'})]),
  ];
  const techne = [
    assistant('techne', 'tech', '', [call('Shell', {command: 'python -m http.server 8765'})], 'Build the page'),
    tool('techne', 'tech', 'Shell', 'OSError: [Errno 10048] address already in use', true),
    assistant('techne', 'tech', '', [call('Write', {file_path: 'a.html'})]),
    tool('techne', 'tech', 'Write', 'Not written: this file already exists and is large (over 20 KB or 400 lines). Change it with Edit instead. Your attempted content was saved to: ' +
      join(tmpdir(), 'nope', 'rejected-writes', '1-a.html'), true),
    assistant('techne', 'tech', '', [call('SendMessage', {to: 'logox', type: 'reply', message: 'ok'})]),
    assistant('techne', 'tech', 'Finished the page.'),
    assistant('techne', 'tech', '', [call('_FinishRound', {title: 'done'})]),
  ];
  const kalon = [assistant('kalon', 'kal', 'Drawing.', [call('_FinishRound', {title: 'x'})], 'Draw the scene')];
  const wake1 = [assistant('logox', 'wake1', REPORT), assistant('logox', 'wake1', '', [call('_FinishRound', {title: 'final'})])];
  const wake2 = [assistant('logox', 'wake2', REPORT)];
  await writeFile(join(dir, 'director.jsonl'), jsonl([...director, ...wake1, ...wake2]));
  await writeFile(join(dir, 'subagents', 'techne.jsonl'), jsonl(techne));
  await writeFile(join(dir, 'subagents', 'kalon.jsonl'), jsonl(kalon));
  await writeFile(join(dir, 'subagents', 'automa.jsonl'), jsonl([{time: tick(), parentActivityId: ROOT, event: 'start', jobIndex: 0}, {time: tick(), parentActivityId: ROOT, event: 'end', state: 'done'},
    {time: tick(), parentActivityId: ROOT, event: 'start', jobIndex: 1}, {time: tick(), parentActivityId: ROOT, event: 'end', state: 'failed'}]));
  const task = (activityId: string, ownerId: string, extra: Record<string, unknown>) => ({activityId, ownerId, prompt: 'p', source: 'x', status: 'completed', time: 1, rootActivityId: ROOT, ...extra});
  await writeFile(join(dir, 'tasks.json'), JSON.stringify([
    {...task(ROOT, 'logox', {inputKind: 'human', prompt: 'Build a page'})},
    task('tech', 'techne', {parentActivityId: ROOT, inputKind: 'director', progress: {label: 'Build', stageHistory: ['Build the page', 'Polish']}}),
    task('kal', 'kalon', {parentActivityId: ROOT, inputKind: 'director', status: 'failed', error: 'Model returned only thinking or an empty reply and delivered nothing for the current step'}),
    task('wake1', 'logox', {parentActivityId: 'tech', inputKind: 'actor', coordinationWake: true}),
    task('wake2', 'logox', {parentActivityId: 'kal', inputKind: 'actor', coordinationWake: true}),
  ]));
  await writeFile(join(dir, 'events.json'), JSON.stringify([{kind: 'model_error', text: 'Model returned only thinking or an empty reply', time: 1}]));
}

test('scoreSession computes the workflow metrics of a synthetic session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-scorer-'));
  try {
    const dir = join(root, 'project', '.logox', 'state', 'sessions', SESSION);
    await writeSession(dir);
    const score = scorer.scoreSession(dir);
    assert.equal(score.session.label, 'project');
    assert.deepEqual(score.roots.map(({finalReports, wakes, lateWakes, lateWakeReports}) => ({finalReports, wakes, lateWakes, lateWakeReports})),
      [{finalReports: 2, wakes: 2, lateWakes: 1, lateWakeReports: 1}]);
    assert.ok((score.roots[0]?.wallMs ?? 0) > 0);
    assert.deepEqual(score.stages['logox'], {turns: 6, withStage: 1, share: 1 / 6, distinct: 1});
    assert.equal(score.stages['techne']?.withStage, 1);
    assert.equal(score.stages['techne']?.distinct, 2, 'stage history from tasks.json joins the ledger stage');
    assert.deepEqual(score.roundClosing['techne'], {rounds: 1, same: 0, separate: 1, silent: 0, never: 0});
    assert.deepEqual(score.roundClosing['kalon'], {rounds: 1, same: 1, separate: 0, silent: 0, never: 0});
    assert.deepEqual(score.roundClosing['logox'], {rounds: 3, same: 1, separate: 1, silent: 0, never: 1});
    assert.deepEqual([score.failures.failedTasks, score.failures.emptyReplyFailures, score.failures.modelErrorEvents], [1, 1, 1]);
    assert.deepEqual([score.writes.refusals, score.writes.savedRecorded], [1, 1]);
    assert.deepEqual([score.preview.serverStarts, score.preview.backgroundStarts, score.preview.portConflicts, score.preview.navigations.file, score.preview.navigations.localHttp], [2, 1, 1, 1, 0]);
    assert.deepEqual(score.messaging.bySender['logox'], {reply: 0, inform: 1, ask: 0, other: 0});
    assert.deepEqual(score.messaging.bySender['techne'], {reply: 1, inform: 0, ask: 0, other: 0});
    assert.equal(score.messaging.toLogox, 1);
    assert.deepEqual(score.automa, {...score.automa, dispatches: 1, jobs: 2, jobFailures: 1, keep: 1, continue: 0, release: 0});
    assert.equal(score.usage.recorded, false, 'usage is not in the fixture, so tokens are n/a');
    assert.ok(score.missing.some(note => note.startsWith('tokens and cost')));
    assert.deepEqual([score.interruptions.userInterrupts, score.interruptions.directorStops, score.interruptions.cancelActorCalls], [0, 0, 0]);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('resolveSession picks the newest session of a .logox directory and renderTable compares sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-scorer-'));
  try {
    const sessions = join(root, 'proj', '.logox', 'state', 'sessions');
    await writeSession(join(sessions, 'old'));
    await writeSession(join(sessions, 'new'));
    const past = new Date(Date.now() - 3_600_000);
    for (const file of ['director.jsonl', 'tasks.json']) await utimes(join(sessions, 'old', file), past, past);
    const found = scorer.resolveSession(join(root, 'proj', '.logox'));
    assert.ok(found.dir.endsWith('new'));
    assert.deepEqual(found.others.map(item => item.id), ['old']);
    assert.ok(scorer.resolveSession(join(sessions, 'old')).dir.endsWith('old'));
    const first = scorer.scoreSession(join(sessions, 'new'));
    const second = scorer.scoreSession(join(sessions, 'old'));
    const table = scorer.renderTable([first, second]);
    assert.match(table, /final reports \(total\)\s+2\s+2/);
    assert.match(table, /tokens in \/ out\s+n\/a\s+n\/a/);
    assert.throws(() => scorer.resolveSession(join(root, 'missing')), /No LOGOX session/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
