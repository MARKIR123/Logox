import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {RuntimeStore} from '../src/runtime/store.js';
import {Anamnesis, type AnamnesisDriver, type RunContext, type RunKind, type RunOutcome} from '../src/anamnesis/service.js';

const MIN = 60_000;
function rig(options: {run?: (context: RunContext) => Promise<RunOutcome>; auto?: {recap: boolean; dream: boolean}} = {}) {
  const store = new RuntimeStore();
  const state = {now: 0, busy: false, material: {recap: true, dream: true} as Record<RunKind, boolean>, runs: [] as RunKind[], checks: 0,
    auto: options.auto ?? {recap: true, dream: true}};
  const driver: AnamnesisDriver = {
    async material(kind) {state.checks++; return state.material[kind];},
    async run(context) {
      state.runs.push(context.kind);
      if (options.run) return options.run(context);
      context.report(context.kind === 'recap' ? 'Reading' : 'Thinking');
      return context.kind === 'recap' ? {stage: 'Where it stands', detail: 'Done: x'} : {stage: 'Saved 1 memory record', detail: '+ project/x (project): d'};
    },
  };
  const service = new Anamnesis('s', store, driver, () => state.busy, {clock: () => state.now, wall: () => 1_000_000 + state.now, recapIdleMs: 5 * MIN, dreamIdleMs: 30 * MIN, auto: () => state.auto});
  const cards = () => store.getSnapshot().activities.filter(activity => activity.kind === 'anamnesis');
  /** Ticks and lets the run it started finish. */
  const tick = async () => {await service.tick(); while (service.running()) await delay(1);};
  return {store, state, service, cards, tick};
}

test('a recap runs after its idle time and a dream after its own; each leaves one finished card', async () => {
  const r = rig();
  r.state.now = 5 * MIN - 1; await r.tick();
  assert.deepEqual(r.state.runs, [], 'not idle long enough');
  r.state.now = 5 * MIN; await r.tick();
  assert.deepEqual(r.state.runs, ['recap']);
  r.state.material.recap = false;
  r.state.now = 29 * MIN; await r.tick();
  assert.deepEqual(r.state.runs, ['recap'], 'the recap has nothing new and the dream is not due');
  r.state.now = 30 * MIN; await r.tick();
  assert.deepEqual(r.state.runs, ['recap', 'dream']);
  const [recap, dream] = r.cards();
  assert.deepEqual([recap!.status, recap!.stage, recap!.detail, recap!.title, recap!.ownerId], ['completed', 'Where it stands', 'Done: x', 'Anamnesis', 'anamnesis']);
  assert.deepEqual([dream!.status, dream!.stage, dream!.detail], ['completed', 'Saved 1 memory record', '+ project/x (project): d']);
  assert.ok(recap!.createdAt !== undefined && dream!.createdAt! > recap!.createdAt!, 'cards carry their creation time');
  r.state.material.dream = false;
  r.state.now = 300 * MIN; await r.tick();
  assert.equal(r.state.runs.length, 2, 'nothing new, nothing runs');
});

test('when both are due the recap goes first unless it was already shown; the dream follows on the next check', async () => {
  const r = rig();
  r.state.now = 40 * MIN; await r.tick();
  assert.deepEqual(r.state.runs, ['recap']);
  r.state.material.recap = false;
  await r.tick();
  assert.deepEqual(r.state.runs, ['recap', 'dream']);
  const shown = rig();
  shown.state.material.recap = false; shown.state.now = 40 * MIN; await shown.tick();
  assert.deepEqual(shown.state.runs, ['dream'], 'a recap that was already shown is skipped');
});

test('a "no material" answer is not asked again until the user has been active', async () => {
  const r = rig();
  r.state.material = {recap: false, dream: false};
  r.state.now = 40 * MIN; await r.tick();
  const checks = r.state.checks;
  assert.ok(checks >= 1);
  for (let i = 0; i < 5; i++) {r.state.now += 15_000; await r.tick();}
  assert.equal(r.state.checks, checks, 'no journal is read again while nothing could have changed');
  r.service.foregroundFinished();
  r.state.now += 31 * MIN; r.state.material.dream = true; await r.tick();
  assert.deepEqual(r.state.runs, ['dream']);
});

test('drafts, submits and finished tasks keep the session from being idle', async () => {
  const r = rig();
  r.state.now = 4 * MIN; r.service.noteDraft();
  r.state.now = 8 * MIN; await r.tick();
  assert.deepEqual(r.state.runs, [], 'the draft at minute 4 restarted the clock');
  r.state.now = 9 * MIN; await r.tick();
  assert.deepEqual(r.state.runs, ['recap']);
  const finished = rig();
  finished.state.now = 4 * MIN; finished.service.foregroundFinished();
  finished.state.now = 8 * MIN; await finished.tick();
  assert.deepEqual(finished.state.runs, []);
});

test('busy foreground, a pending question, closed service and switched-off triggers all keep the automatic run away; runNow ignores the switches', async () => {
  const r = rig();
  r.state.now = 60 * MIN;
  r.state.busy = true; await r.tick();
  assert.deepEqual(r.state.runs, []);
  r.state.busy = false;
  void r.store.interactions.open({sessionId: 's', activityId: 'a', ownerId: 'logox', kind: 'question', title: 'Q',
    questions: [{id: 'q', header: 'Q', question: 'Which?', options: [{id: 'x', label: 'X', description: ''}, {id: 'y', label: 'Y', description: ''}]}]}).result;
  await r.tick();
  assert.deepEqual(r.state.runs, [], 'a pending interaction means the user is being waited on');
  r.store.interactions.close();

  const off = rig({auto: {recap: false, dream: false}});
  off.state.now = 60 * MIN; await off.tick();
  assert.deepEqual(off.state.runs, []);
  const handle = off.service.runNow('dream');
  assert.equal((await handle.done).status, 'completed');
  assert.deepEqual(off.state.runs, ['dream'], 'a manual run still works');
  const onlyDream = rig({auto: {recap: false, dream: true}});
  onlyDream.state.now = 60 * MIN; await onlyDream.tick();
  assert.deepEqual(onlyDream.state.runs, ['dream']);

  const closed = rig();
  closed.state.now = 60 * MIN;
  await closed.service.close();
  await closed.service.tick();
  assert.deepEqual(closed.state.runs, []);
  assert.throws(() => closed.service.runNow('recap'), /closed/);
});

test('runNow ignores the idle clock and the material check but refuses while the foreground works or another run is in flight', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  const r = rig({run: async context => {await gate; return {stage: 'Done ' + context.kind, detail: ''};}});
  r.state.material = {recap: false, dream: false};
  r.state.busy = true;
  assert.throws(() => r.service.runNow('recap'), /cannot run while tasks are running/);
  assert.deepEqual(r.cards(), []);
  r.state.busy = false;
  const first = r.service.runNow('recap');
  assert.equal(r.cards()[0]!.stage, 'Writing recap');
  assert.equal(r.cards()[0]!.detail, '');
  assert.equal(r.cards()[0]!.status, 'running');
  assert.throws(() => r.service.runNow('dream'), /already running/);
  release();
  assert.deepEqual((await first.done), {kind: 'recap', status: 'completed', outcome: {stage: 'Done recap', detail: ''}});
  const second = r.service.runNow('dream');
  assert.equal(r.cards().find(card => card.activityId === second.runId)!.stage, 'Reviewing the session');
  await second.done;
  assert.equal(r.cards().length, 2);
});

test('user activity aborts a run: nothing is applied, the same card waits and the run starts over on the next idle period', async () => {
  let applied = 0, attempts = 0;
  const r = rig({run: async context => {
    attempts++;
    context.report('Working', 'half way');
    await delay(60_000, undefined, {signal: context.signal});
    applied++;
    return {stage: 'Applied', detail: ''};
  }});
  r.state.now = 5 * MIN;
  await r.service.tick();
  while (!r.state.runs.length) await delay(1);
  const card = r.cards()[0]!;
  assert.equal(r.cards()[0]!.stage, 'Working');
  const stopped = await Promise.race([r.service.foregroundSubmitted().then(() => 'stopped'), delay(2000).then(() => 'hung')]);
  assert.equal(stopped, 'stopped');
  assert.equal(applied, 0);
  assert.equal(r.service.running(), undefined);
  assert.deepEqual([r.cards()[0]!.status, r.cards()[0]!.stage], ['paused', 'Waiting to resume']);
  r.state.now = 10 * MIN + 1;
  await r.service.tick();
  while (attempts < 2) await delay(1);
  assert.equal(r.cards().length, 1, 'the same card continues');
  assert.equal(r.cards()[0]!.activityId, card.activityId);
  assert.equal(r.cards()[0]!.status, 'running');
  assert.ok(r.cards()[0]!.createdAt! > card.createdAt!, 'and moves to where the new run began');
  await r.service.close();
  assert.equal(r.cards()[0]!.status, 'cancelled');
  assert.equal(applied, 0);
});

test('an automatic dream that finds nothing leaves no card; a manual one keeps its card; a recap always keeps its card', async () => {
  const run = async (context: RunContext): Promise<RunOutcome> => context.kind === 'dream' ? {stage: 'Nothing new to remember', detail: '', empty: true} : {stage: 'Quiet session', detail: ''};
  const r = rig({run});
  r.state.now = 31 * MIN; await r.tick();
  assert.deepEqual(r.state.runs, ['recap']);
  r.state.material.recap = false;
  await r.tick();
  assert.deepEqual(r.state.runs, ['recap', 'dream']);
  assert.deepEqual(r.cards().map(card => card.stage), ['Quiet session'], 'only the recap card remains');
  const manual = await r.service.runNow('dream').done;
  assert.equal(manual.status, 'completed');
  assert.deepEqual(r.cards().map(card => card.stage), ['Quiet session', 'Nothing new to remember']);
});

test('a failed run shows its error on the card, is not retried in a loop, tries again after the next idle period and replaces its own failure card', async () => {
  let fail = true;
  const r = rig({run: async context => {if (fail) throw new Error('Network down'); return {stage: 'Recovered ' + context.kind, detail: ''};}});
  r.state.now = 5 * MIN; await r.tick();
  assert.deepEqual([r.cards()[0]!.status, r.cards()[0]!.stage, r.cards()[0]!.detail], ['failed', 'Recap failed', 'Network down']);
  const failed = r.cards()[0]!.activityId;
  for (let i = 0; i < 10; i++) {r.state.now += 15_000; await r.tick();}
  assert.deepEqual(r.state.runs, ['recap'], 'no retry loop');
  fail = false;
  r.state.now = 10 * MIN + 1; await r.tick();
  assert.deepEqual(r.state.runs, ['recap', 'recap']);
  assert.deepEqual(r.cards().map(card => [card.status, card.stage]), [['completed', 'Recovered recap']], 'the failure card gave way');
  assert.notEqual(r.cards()[0]!.activityId, failed);
  const dream = rig({run: async () => {throw new Error('Anamnesis has no usable model (x/y). Choose one under /anamnesis.');}});
  dream.state.material.recap = false; dream.state.now = 30 * MIN; await dream.tick();
  assert.deepEqual([dream.cards()[0]!.stage, dream.cards()[0]!.detail], ['Dream failed', 'Anamnesis has no usable model (x/y). Choose one under /anamnesis.']);
  const manual = await dream.service.runNow('dream').done;
  assert.deepEqual(manual, {kind: 'dream', status: 'failed', error: 'Anamnesis has no usable model (x/y). Choose one under /anamnesis.'});
});
