import test from 'node:test';
import assert from 'node:assert/strict';
import {executeListActors} from '../src/tools/coordination/ListActorsTool/ListActorsTool.js';
import {LIST_ACTORS_DESCRIPTION} from '../src/tools/coordination/ListActorsTool/prompt.js';
import type {RuntimeSnapshot} from '../src/runtime/contracts.js';

function harness() {
  let snapshot = {revision: 0, activities: [], interactions: [], messages: []} as unknown as RuntimeSnapshot;
  let clock = 1_000_000;
  const getSnapshot = () => snapshot;
  const roles = {logox: {name: 'Logox'}, techne: {name: 'Techne'}, kalon: {name: 'Kalon'}};
  return {
    call: (caller: string) => executeListActors({}, {caller, getSnapshot, roles, now: () => clock}),
    advance: (ms: number) => { clock += ms; },
    busy: (ownerId: string, stage = 'working') => {
      snapshot = {...snapshot, activities: [{activityId: `a-${ownerId}`, ownerId, status: 'running', stage}]} as unknown as RuntimeSnapshot;
    },
  };
}

test('ListActors: unchanged second call returns the one-line no-change result', () => {
  const h = harness();
  const first = h.call('techne');
  assert.match(first.text, /"actors"/);
  h.advance(12_400);
  const second = h.call('techne');
  assert.equal(second.text, 'No change since your last check (12s ago). Peer messages arrive automatically; you do not need to poll.');
  assert.equal(second.isError, false);
});

test('ListActors: a changed roster returns the full roster again', () => {
  const h = harness();
  h.call('techne');
  h.busy('kalon', 'reading');
  const changed = h.call('techne');
  assert.match(changed.text, /"actors"/);
  assert.match(changed.text, /"stage": "reading"/);
  h.busy('kalon', 'writing');
  assert.match(h.call('techne').text, /"stage": "writing"/);
  assert.match(h.call('techne').text, /^No change/);
});

test('ListActors: callers are tracked separately and the Director keeps its detailed view', () => {
  const h = harness();
  h.call('techne');
  assert.match(h.call('kalon').text, /"actors"/);
  assert.match(h.call('logox').text, /"actors"/);
  assert.match(h.call('techne').text, /^No change/);
  assert.match(h.call('logox').text, /^No change/);
  h.busy('techne');
  const detailed = h.call('logox').text;
  assert.match(detailed, /"activityId": "a-techne"/);
  assert.match(detailed, /"queuedCount"/);
});

test('ListActors: description tells actors not to poll', () => {
  assert.match(LIST_ACTORS_DESCRIPTION, /delivered automatically, so polling is unnecessary/);
});
