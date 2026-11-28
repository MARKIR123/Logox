import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {RuntimeStore} from '../src/runtime/store.js';
import {Anamnesis, type AnamnesisDriver, type RunContext, type RunKind, type RunOutcome} from '../src/anamnesis/service.js';

function rig(options: {run?: (context: RunContext) => Promise<RunOutcome>} = {}) {
  const store = new RuntimeStore();
  const state = {now: 0, busy: false, runs: [] as RunKind[]};
  const driver: AnamnesisDriver = {
    async run(context) {
      state.runs.push(context.kind);
      if (options.run) return options.run(context);
      context.report(context.kind === 'recap' ? 'Reading' : 'Thinking');
      return context.kind === 'recap' ? {stage: 'Where it stands', detail: 'Done: x'} : {stage: 'Saved 1 memory record', detail: "Remembered in this project's memory\n• x (about the project): d"};
    },
  };
  const service = new Anamnesis('s', store, driver, () => state.busy, {wall: () => 1_000_000 + state.now});
  const cards = () => store.getSnapshot().activities.filter(activity => activity.kind === 'anamnesis');
  return {store, state, service, cards};
}

// The idle clocks (a recap after 5 minutes, a dream after 30), `tick()` and the "no material" and "failed run is not retried before the next idle period"
// rules were retired with the automatic trigger: automatic work is a harvest (`tests/anamnesis-harvest.test.ts`).

test('a manual recap or dream starts at once, shows one card each and refuses while the foreground works or another run is in flight', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  const r = rig({run: async context => {await gate; return {stage: 'Done ' + context.kind, detail: ''};}});
  r.state.busy = true;
  assert.throws(() => r.service.runNow('recap'), /cannot run while tasks are running/);
  assert.deepEqual(r.cards(), []);
  r.state.busy = false;
  const first = r.service.runNow('recap');
  assert.equal(r.cards()[0]!.stage, 'Writing recap');
  assert.equal(r.cards()[0]!.detail, '');
  assert.equal(r.cards()[0]!.status, 'running');
  assert.equal(r.service.running(), 'recap');
  assert.throws(() => r.service.runNow('dream'), /already running/);
  release();
  assert.deepEqual((await first.done), {kind: 'recap', status: 'completed', outcome: {stage: 'Done recap', detail: ''}});
  const second = r.service.runNow('dream');
  assert.equal(r.cards().find(card => card.activityId === second.runId)!.stage, 'Reviewing the session');
  await second.done;
  assert.equal(r.cards().length, 2);
  await r.service.close();
  assert.throws(() => r.service.runNow('recap'), /closed/);
});

test('a sent message aborts a run: nothing is applied and the card is removed; a close does the same', async () => {
  let applied = 0;
  const r = rig({run: async context => {
    context.report('Working', 'half way');
    await delay(60_000, undefined, {signal: context.signal});
    applied++;
    return {stage: 'Applied', detail: ''};
  }});
  r.service.runNow('recap');
  while (!r.state.runs.length) await delay(1);
  assert.equal(r.cards()[0]!.stage, 'Working');
  const stopped = await Promise.race([r.service.foregroundSubmitted().then(() => 'stopped'), delay(2000).then(() => 'hung')]);
  assert.equal(stopped, 'stopped');
  assert.equal(applied, 0);
  assert.equal(r.service.running(), undefined);
  assert.deepEqual(r.cards(), [], 'an interrupted run leaves no card');
  r.service.runNow('dream');
  while (r.state.runs.length < 2) await delay(1);
  await r.service.close();
  assert.deepEqual(r.cards(), [], 'a run aborted by close is just removed');
  assert.equal(applied, 0);
});

test('typing never interrupts a run: keystrokes and finished tasks leave it running, only a submit stops it', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  let applied = 0;
  const r = rig({run: async context => {await gate; context.signal.throwIfAborted(); applied++; return {stage: 'Applied', detail: ''};}});
  const run = r.service.runNow('dream');
  while (!r.state.runs.length) await delay(1);
  for (let i = 0; i < 20; i++) r.service.noteDraft();
  r.service.foregroundFinished();
  await delay(5);
  assert.equal(r.service.running(), 'dream', 'still running after the keystrokes');
  release();
  assert.equal((await run.done).status, 'completed');
  assert.equal(applied, 1);
  assert.equal(r.cards()[0]!.status, 'completed');
});

test('a manual run that finds nothing keeps its card (an automatic one leaves none); a failed run shows its error and the next run replaces that card', async () => {
  const empty = rig({run: async () => ({stage: 'Nothing new to remember', detail: '', empty: true})});
  const manual = await empty.service.runNow('dream').done;
  assert.equal(manual.status, 'completed');
  assert.deepEqual(empty.cards().map(card => card.stage), ['Nothing new to remember']);

  let fail = true;
  const r = rig({run: async context => {if (fail) throw new Error('Network down'); return {stage: 'Recovered ' + context.kind, detail: ''};}});
  const failed = await r.service.runNow('recap').done;
  assert.deepEqual(failed, {kind: 'recap', status: 'failed', error: 'Network down'});
  assert.deepEqual([r.cards()[0]!.status, r.cards()[0]!.stage, r.cards()[0]!.detail], ['failed', 'Recap failed', 'Network down']);
  const failedCard = r.cards()[0]!.activityId;
  fail = false;
  await r.service.runNow('recap').done;
  assert.deepEqual(r.cards().map(card => [card.status, card.stage]), [['completed', 'Recovered recap']], 'the failure card gave way');
  assert.notEqual(r.cards()[0]!.activityId, failedCard);
  const dream = rig({run: async () => {throw new Error('Anamnesis has no usable model (x/y). Choose one under /anamnesis.');}});
  const result = await dream.service.runNow('dream').done;
  assert.deepEqual(result, {kind: 'dream', status: 'failed', error: 'Anamnesis has no usable model (x/y). Choose one under /anamnesis.'});
  assert.deepEqual([dream.cards()[0]!.stage, dream.cards()[0]!.detail], ['Dream failed', 'Anamnesis has no usable model (x/y). Choose one under /anamnesis.']);
});
