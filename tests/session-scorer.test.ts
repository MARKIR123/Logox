import test from 'node:test';
import assert from 'node:assert/strict';
import {appendFile, mkdir, mkdtemp, rm, utimes, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {techneRequests, writeFingerprints} from './fingerprint-fixture.js';

interface Score {
  session: {label: string; others: {id: string}[]; wallMs: number | null};
  roots: {finalReports: number; wakes: number; lateWakes: number; lateWakeReports: number; wallMs: number | null; usage: {input: number} | null}[];
  stages: Record<string, {turns: number; withStage: number; share: number | null; distinct: number | null}>;
  roundClosing: Record<string, {rounds: number; same: number; separate: number; silent: number; never: number}>;
  roundSummaries: Record<string, {rounds: number; model: number; runtime: number; failed: number; interrupted: number; reply: number; modelShare: number | null}>;
  failures: {failedTasks: number; emptyReplyFailures: number; modelErrorEvents: number};
  writes: {refusals: number; savedRecorded: number};
  preview: {serverStarts: number; backgroundStarts: number; portConflicts: number; navigations: {file: number; localHttp: number}};
  messaging: {bySender: Record<string, {reply: number; inform: number; ask: number; other: number}>; toLogox: number; total: number};
  automa: {dispatches: number; jobs: number; jobFailures: number; keep: number; continue: number; release: number};
  usage: {recorded: boolean; costRecorded: boolean; total: {turns: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number};
    byActor: Record<string, {turns: number; input: number; cost: number}>};
  interruptions: {userInterrupts: number; directorStops: number; cancelActorCalls: number};
  cache: {recorded: boolean; byActor: Record<string, {requests: number; pairs: number; pureAppend: number; pureAppendShare: number | null; misses: Record<string, number>}>};
  missing: string[];
}
const scorer = await import(new URL('../../scripts/score-session.mjs', import.meta.url).href) as {
  scoreSession(dir: string, options?: {others?: unknown[]}): Score;
  resolveSession(path: string): {dir: string; others: {id: string}[]};
  renderTable(scores: Score[]): string;
  projectUsage(path: string): {sessions: {id: string; usage: Score['usage']}[]; recorded: number; total: Score['usage']['total']} | null;
  main(argv: string[]): number;
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
async function writeSession(dir: string, withUsage = false): Promise<void> {
  clock = 1_000_000;
  await mkdir(join(dir, 'subagents'), {recursive: true});
  // Turn usage as the runtime persists it: one record per assistant turn, tokens as the provider reports them.
  const priced = (rows: Record<string, unknown>[]) => withUsage ? rows.map(row => row['role'] === 'assistant'
    ? {...row, usage: {input: 100, output: 10, cacheRead: 40, cacheWrite: 0, provider: 'p', model: 'm', cost: 0.5, currency: 'USD'}} : row) : rows;
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
  await writeFile(join(dir, 'director.jsonl'), jsonl(priced([...director, ...wake1, ...wake2])));
  await writeFile(join(dir, 'subagents', 'techne.jsonl'), jsonl(priced(techne)));
  await writeFile(join(dir, 'subagents', 'kalon.jsonl'), jsonl(priced(kalon)));
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
  const round = (activityId: string, report: string) => ({activityId, start: 0, end: 1, sourceHash: 'h', status: 'completed', summary: {title: 't', report, source: report.startsWith('[') ? 'local' : 'model'}});
  await writeFile(join(dir, 'director.rounds.json'), JSON.stringify([round(ROOT, 'Dispatched the page.'), round('wake1', '[runtime] The model gave no round summary.'), round('wake2', '[reply] Answered a teammate.')]));
  await writeFile(join(dir, 'subagents', 'techne.rounds.json'), JSON.stringify([round('tech', 'Built the page.'), round('tech2', '[failed] Ended with an error.'), round('tech3', '[interrupted] Stopped before finishing.')]));
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
    assert.deepEqual(score.roundSummaries['logox'], {rounds: 3, model: 1, runtime: 1, failed: 0, interrupted: 0, reply: 1, modelShare: 1 / 3});
    assert.deepEqual(score.roundSummaries['techne'], {rounds: 3, model: 1, runtime: 0, failed: 1, interrupted: 1, reply: 0, modelShare: 1 / 3});
    assert.deepEqual(score.roundSummaries['total'], {rounds: 6, model: 2, runtime: 1, failed: 1, interrupted: 1, reply: 1, modelShare: 1 / 3});
    assert.equal(score.roundSummaries['kalon'], undefined, 'an actor without a rounds file is not listed');
    assert.deepEqual([score.failures.failedTasks, score.failures.emptyReplyFailures, score.failures.modelErrorEvents], [1, 1, 1]);
    assert.deepEqual([score.writes.refusals, score.writes.savedRecorded], [1, 1]);
    assert.deepEqual([score.preview.serverStarts, score.preview.backgroundStarts, score.preview.portConflicts, score.preview.navigations.file, score.preview.navigations.localHttp], [2, 1, 1, 1, 0]);
    assert.deepEqual(score.messaging.bySender['logox'], {reply: 0, inform: 1, ask: 0, other: 0});
    assert.deepEqual(score.messaging.bySender['techne'], {reply: 1, inform: 0, ask: 0, other: 0});
    assert.equal(score.messaging.toLogox, 1);
    assert.deepEqual(score.automa, {...score.automa, dispatches: 1, jobs: 2, jobFailures: 1, keep: 1, continue: 0, release: 0});
    assert.equal(score.usage.recorded, false, 'usage is not in the fixture, so tokens are n/a');
    assert.equal(score.roots[0]?.usage, null);
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

test('Cost reports tokens and cost per actor, per root task and in total when ledgers carry usage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-scorer-'));
  try {
    const dir = join(root, 'proj', '.logox', 'state', 'sessions', SESSION);
    await writeSession(dir, true);
    const score = scorer.scoreSession(dir);
    assert.deepEqual(score.usage.total, {turns: 12, input: 1200, output: 120, cacheRead: 480, cacheWrite: 0, cost: 6, costTurns: 12});
    assert.deepEqual([score.usage.byActor['logox']?.turns, score.usage.byActor['techne']?.turns, score.usage.byActor['kalon']?.turns], [6, 5, 1]);
    assert.equal(score.usage.byActor['techne']?.cost, 2.5);
    assert.equal(score.roots[0]?.usage?.input, 1200, 'wake activities attribute to their root task');
    assert.ok(!score.missing.some(note => note.startsWith('cost') || note.startsWith('tokens')));
    const table = scorer.renderTable([score]);
    assert.match(table, /tokens in [/] out +1200 [/] 120/);
    assert.match(table, /techne cost +2[.]5000 USD/);
    assert.match(table, /root #1 cost +6[.]0000 USD/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('projectUsage sums every session of a .logox directory and keeps n/a sessions out of the total', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-scorer-'));
  try {
    const sessions = join(root, 'proj', '.logox', 'state', 'sessions');
    await writeSession(join(sessions, 'a'), true);
    await writeSession(join(sessions, 'b'), true);
    await writeSession(join(sessions, 'legacy'));
    const project = scorer.projectUsage(join(root, 'proj', '.logox'));
    assert.ok(project);
    assert.deepEqual(project.sessions.map(item => item.id), ['a', 'b', 'legacy']);
    assert.equal(project.recorded, 2);
    assert.equal(project.total.input, 2400);
    assert.equal(project.total.cost, 12);
    assert.equal(project.sessions[2]?.usage.recorded, false);
    assert.equal(scorer.projectUsage(join(sessions, 'a')), null, 'a session directory is not a project');
    const logged: string[] = [], log = console.log;
    console.log = (text: string) => {logged.push(text);};
    try {scorer.main([join(root, 'proj', '.logox')]);} finally {console.log = log;}
    const printed = logged.join(String.fromCharCode(10));
    assert.ok(printed.includes("[Project total] 3 sessions, 2 with usage data"));
    assert.match(printed, /legacy +n[/]a/);
    assert.ok(printed.includes("1 sessions predate"));
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('the partial-cost note names the unpriced model ids with their turn counts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-scorer-'));
  try {
    const dir = join(root, 'proj', '.logox', 'state', 'sessions', SESSION);
    await writeSession(dir, true);
    const bare = (model: string) => ({input: 10, output: 1, cacheRead: 0, cacheWrite: 0, provider: 'antigravity', model});
    await writeFile(join(dir, 'usage.jsonl'), jsonl([
      {version: 1, time: tick(), ownerId: 'techne', category: 'summary', usage: bare('gemini-4-hydrogen')},
      {version: 1, time: tick(), ownerId: 'techne', category: 'summary', usage: bare('gemini-4-hydrogen')},
      {version: 1, time: tick(), ownerId: 'techne', category: 'approval', usage: bare('gemini-4-hydrogen-xhigh')}]));
    const score = scorer.scoreSession(dir);
    const note = score.missing.find(item => item.startsWith('cost:'));
    assert.equal(note, 'cost: 3 of 15 turns had no price, so cost is partial; unpriced: antigravity/gemini-4-hydrogen (2), antigravity/gemini-4-hydrogen-xhigh (1)');
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('Automa worker turns and summary calls count toward actor, root and project totals with their own rows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-scorer-'));
  try {
    const dir = join(root, 'proj', '.logox', 'state', 'sessions', SESSION);
    await writeSession(dir, true);
    const usage = (input: number, output: number, cost: number) => ({input, output, cacheRead: 0, cacheWrite: 0, provider: 'p', model: 'm', cost, currency: 'USD'});
    await appendFile(join(dir, 'subagents', 'automa.jsonl'), jsonl([{time: tick(), parentActivityId: ROOT, principal: 'logox', event: 'message', usage: usage(60, 6, 0.25)}]));
    await writeFile(join(dir, 'usage.jsonl'), jsonl([{version: 1, time: tick(), ownerId: 'techne', category: 'summary', usage: usage(50, 5, 0.1)}]));
    const score = scorer.scoreSession(dir);
    assert.equal(score.usage.total.input, 1310);
    assert.ok(Math.abs(score.usage.total.cost - 6.35) < 1e-9);
    assert.equal(score.roots[0]?.usage?.input, 1310, 'Automa follows its dispatching activity and the summary the owner\'s latest activity');
    assert.equal(score.usage.byActor['logox']?.turns, 7);
    assert.equal(score.usage.byActor['techne']?.turns, 6);
    const table = scorer.renderTable([score]);
    assert.match(table, /logox automa in [/] out [/] cache +60 [/] 6 [/] 0[+]0/);
    assert.match(table, /techne compaction cost +0[.]1000 USD/);
    assert.match(table, /logox automa cost +0[.]2500 USD/);
    assert.equal(scorer.projectUsage(join(root, 'proj', '.logox'))?.total.input, 1310);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('the Cache section reports pure-append share and miss classes from request fingerprints, and n/a without them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-scorer-'));
  try {
    const dir = join(root, 'proj', '.logox', 'state', 'sessions', SESSION);
    await writeSession(dir);
    const without = scorer.scoreSession(dir);
    assert.equal(without.cache.recorded, false);
    assert.ok(without.missing.some(note => note.startsWith('cache:')));
    assert.match(scorer.renderTable([without]), /\[Cache\]\s+request fingerprints\s+n\/a/);
    await writeFingerprints(dir, 'techne', techneRequests());
    const score = scorer.scoreSession(dir);
    assert.equal(score.cache.recorded, true);
    assert.deepEqual(score.cache.byActor['techne']?.misses, {'prefix changed': 1, 'fields changed': 1, idle: 1, unexplained: 1});
    assert.equal(score.cache.byActor['techne']?.pureAppendShare, 0.8);
    assert.ok(!score.missing.some(note => note.startsWith('cache:')));
    const table = scorer.renderTable([score]);
    assert.match(table, /\[Cache\]/);
    assert.match(table, /techne pure append\s+80% \(4\/5\)/);
    assert.match(table, /techne misses prefix\/idle\/fields\/unexplained\s+1\/1\/1\/1 of 6/);
    assert.match(table, /techne cache read share\s+\d+%/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('cache keep-alive calls get their own row per actor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-scorer-'));
  try {
    const dir = join(root, 'proj', '.logox', 'state', 'sessions', SESSION);
    await writeSession(dir, true);
    const usage = {input: 90, output: 1, cacheRead: 90, cacheWrite: 0, provider: 'p', model: 'm', cost: 0.02, currency: 'USD'};
    await writeFile(join(dir, 'usage.jsonl'), jsonl([{version: 1, time: tick(), ownerId: 'logox', category: 'keepalive', usage}]));
    const table = scorer.renderTable([scorer.scoreSession(dir)]);
    assert.match(table, /logox keepalive in [/] out [/] cache +90 [/] 1 [/] 90[+]0/);
    assert.match(table, /logox keepalive cost +0[.]0200 USD/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
