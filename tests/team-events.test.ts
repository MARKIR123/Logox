import test from 'node:test';
import assert from 'node:assert/strict';
import {RuntimeStore} from '../src/runtime/store.js';
import type {AutomaSwarm} from '../src/runtime/contracts.js';
import {involves, parseMessage, TeamStream, teamEvents, teamMembers, type TeamEvent} from '../src/runtime/team-events.js';

const base = {sessionId: 's', stage: '', detail: ''};
const T0 = Date.UTC(2026, 10, 20, 8, 0, 0);
const at = (seconds: number) => T0 + seconds * 1000;
const events = (store: RuntimeStore, extra: Partial<Parameters<typeof teamEvents>[0]> = {}) => teamEvents({snapshot: store.getSnapshot(), sessionId: 's', ...extra});
const kinds = (list: readonly TeamEvent[]) => list.map(event => event.kind);
const swarm = (jobs: AutomaSwarm['jobs']): AutomaSwarm => ({name: 'crew', jobs});
const job = (id: string, state: AutomaSwarm['jobs'][number]['state'], extra: Partial<AutomaSwarm['jobs'][number]> = {}): AutomaSwarm['jobs'][number] =>
  ({id, title: 'Job ' + id, state, elapsedMs: 2000, calls: [], ...extra});
const say = (store: RuntimeStore, owner: string, role: 'user' | 'assistant', text: string, extra: Record<string, unknown> = {}) =>
  store.message('s', owner, role, text, extra as never);

/** A whole session: the human asks, the Director dispatches two companions, they talk, one dispatches workers, one waits, both report. */
function session(over: Record<string, Record<string, unknown>> = {}): RuntimeStore {
  const store = new RuntimeStore();
  store.activities.create({...base, activityId: 'root', ownerId: 'logox', kind: 'director', title: 'Draw', status: 'completed', rootActivityId: 'root', inputKind: 'human'});
  say(store, 'logox', 'user', 'Draw the pelican', {activityId: 'root', inputKind: 'human', source: 'direct', time: at(0)});
  store.activities.create({...base, activityId: 'kal', ownerId: 'kalon', kind: 'actor', title: 'Kalon', taskTitle: 'Draw the SVG', status: 'completed', stopReason: 'completed',
    rootActivityId: 'root', parentActivityId: 'root', batchId: 'b1', inputKind: 'director', summary: {title: 'SVG drawn', report: '⏵ Reporting\nDrew it.', source: 'model'}, ...over.kal} as never);
  store.activities.create({...base, activityId: 'tech', ownerId: 'techne', kind: 'actor', title: 'Techne', taskTitle: 'Build the page', status: 'completed', stopReason: 'completed',
    rootActivityId: 'root', parentActivityId: 'root', batchId: 'b1', inputKind: 'director', summary: {title: 'Page built', report: 'Built.', source: 'model'}, ...over.tech} as never);
  store.activities.create({...base, activityId: 'alet', ownerId: 'aletheia', kind: 'actor', title: 'Aletheia', taskTitle: 'Check it', status: 'completed', stopReason: 'completed',
    rootActivityId: 'root', parentActivityId: 'root', batchId: 'b1', inputKind: 'director', after: ['tech'], summary: {title: 'Checked', report: 'Looks right.', source: 'model'}, ...over.alet} as never);
  say(store, 'kalon', 'user', 'Draw the SVG for the pelican', {activityId: 'kal', inputKind: 'director', source: 'logox', time: at(10)});
  say(store, 'techne', 'user', 'Build the page', {activityId: 'tech', inputKind: 'director', source: 'logox', time: at(10)});
  say(store, 'aletheia', 'user', 'Check it', {activityId: 'alet', inputKind: 'director', source: 'logox', time: at(10)});
  say(store, 'kalon', 'user', '[Event e1; collaboration; source techne; activity unspecified; root unspecified]\n[Message from techne · rename call]\n' +
    '[Question for you. Answer with SendMessage type "reply" to techne once you can.]\nThe API is now buildStreetProps().', {activityId: 'kal', inputKind: 'collaboration', source: 'coordination', time: at(40)});
  say(store, 'kalon', 'assistant', '', {activityId: 'kal', kind: 'tool', time: at(60), step: {title: 'Automa', state: 'completed', elapsedMs: 0, swarm: swarm([
    job('T1', 'done', {title: 'Search references', summary: '⏵ Searching\nFound 4 references.', stopReason: 'completed'}), job('T2', 'blocked', {title: 'Palette', kind: 'fork', summary: 'Need a colour decision', stopReason: 'completed'})])}});
  say(store, 'kalon', 'user', '[Event e2; help; source kalon; activity kal; root root]\nAsk the Director\nShould the beak be larger?', {activityId: 'kal', inputKind: 'collaboration', source: 'kalon', time: at(120)});
  say(store, 'techne', 'assistant', 'Built the page.', {activityId: 'tech', time: at(130)});
  say(store, 'aletheia', 'assistant', 'Checked it.', {activityId: 'alet', time: at(140)});
  say(store, 'logox', 'user', 'Make the beak bigger', {activityId: 'root', inputKind: 'human', source: 'direct', time: at(200)});
  say(store, 'logox', 'assistant', 'ok', {activityId: 'root', time: at(250)});
  return store;
}

test('every kind is projected, in time order, with the sender, recipients and one-line text', () => {
  const list = events(session());
  assert.deepEqual(kinds(list), ['user', 'assign', 'waiting', 'message', 'workers', 'result', 'result', 'message', 'report', 'report', 'report', 'user']);
  const by = (kind: string) => list.filter(event => event.kind === kind);
  const [firstUser, lastUser] = by('user');
  assert.deepEqual([firstUser!.from, firstUser!.to, firstUser!.text, firstUser!.at], ['user', ['logox'], 'Draw the pelican', at(0)]);
  assert.equal(lastUser!.text, 'Make the beak bigger');
  const assign = by('assign')[0]!;
  assert.deepEqual([assign.from, assign.to, assign.text, assign.ref], ['logox', ['kalon', 'techne', 'aletheia'], 'Draw the SVG ／ Build the page ／ Check it', 'kal'], 'one assignment per batch');
  const [peer, help] = by('message');
  assert.deepEqual([peer!.from, peer!.to, peer!.title, peer!.text], ['techne', ['kalon'], 'rename call', 'The API is now buildStreetProps().']);
  assert.deepEqual([help!.from, help!.title, help!.text], ['kalon', 'Ask the Director', 'Should the beak be larger?']);
  const workers = by('workers')[0]!;
  assert.deepEqual([workers.from, workers.text, workers.ref, workers.items], ['kalon', '2 workers', 'kal/T1', [{title: 'Search references', fork: false}, {title: 'Palette', fork: true}]]);
  const [done, blocked] = by('result');
  assert.deepEqual([done!.from, done!.dispatcher, done!.worker, done!.to, done!.status, done!.text], ['automa', 'kalon', 'T1', ['kalon'], 'done', 'Found 4 references.']);
  assert.equal(blocked!.status, 'blocked');
  const wait = by('waiting')[0]!;
  assert.deepEqual([wait.from, wait.to, wait.text, wait.ref], ['aletheia', ['techne'], 'waiting on techne', 'alet']);
  assert.ok(list.every((event, index) => index === 0 || list[index - 1]!.at <= event.at), 'ordered by time');
  assert.equal(new Set(list.map(event => event.id)).size, list.length, 'ids are unique');
});

test('settled work reports to whoever dispatched it, with the status words and the summary without its status line', () => {
  const store = session({tech: {status: 'failed', stopReason: 'error', summary: {title: 'Tool crashed', report: 'x', source: 'model'}}, kal: {finishedAt: at(150)},
    alet: {status: 'cancelled', stopReason: 'cancelled_by_user'}});
  const reports = events(store).filter(event => event.kind === 'report');
  assert.deepEqual(reports.map(event => event.from).sort(), ['aletheia', 'kalon', 'techne']);
  assert.deepEqual(reports.map(event => event.to), reports.map(() => ['logox']));
  const kal = reports.find(event => event.from === 'kalon')!;
  assert.deepEqual([kal.status, kal.at, kal.ref, kal.text], ['done', at(150), 'kal', 'SVG drawn'], 'a settled activity reports at its finish time');
  assert.equal(reports.find(event => event.from === 'techne')!.status, 'failed');
  assert.equal(reports.find(event => event.from === 'aletheia')!.status, 'interrupted');
});

test('envelopes and status lines never reach the text, and what the person typed is kept whole in the detail', () => {
  const parsed = parseMessage('[Event e; collaboration; source techne; activity unspecified; root unspecified]\n[Message from Techne · label]\n[Question for you. Answer with SendMessage type "reply" to techne.]\nFirst line\nsecond line');
  assert.deepEqual(parsed, {from: 'techne', title: 'label', body: 'First line\nsecond line'});
  assert.deepEqual(parseMessage('[Event help:x; help; source aletheia; activity a; root r]\nShort label\nThe long text.'), {from: 'aletheia', title: 'Short label', body: 'The long text.'});
  assert.deepEqual(parseMessage('plain'), {body: 'plain'});
  const store = new RuntimeStore();
  store.activities.create({...base, activityId: 'root', ownerId: 'logox', kind: 'director', title: 'x', status: 'running', rootActivityId: 'root'});
  say(store, 'logox', 'user', '[The user sent this while you were working. Take it into account now; it may change your direction.]\nLine one\n\nLine two', {activityId: 'root', inputKind: 'human', time: at(1)});
  say(store, 'logox', 'user', '[Automated event, not a message from the human.]\nActor results', {activityId: 'root', inputKind: 'actor', source: 'kalon', time: at(2)});
  const list = events(store);
  assert.equal(list.length, 1, 'automated records are no events');
  assert.deepEqual([list[0]!.text, list[0]!.detail], ['Line one Line two', 'Line one\n\nLine two']);
  assert.ok(!list.some(event => event.text.startsWith('[')));
});

test('a report never repeats the echoed goal or a status line, and a long text is clipped to one line', () => {
  const store = new RuntimeStore();
  store.activities.create({...base, activityId: 'root', ownerId: 'logox', kind: 'director', title: 'x', status: 'running', rootActivityId: 'root'});
  store.activities.create({...base, activityId: 'a', ownerId: 'kalon', kind: 'actor', title: 'Kalon · Aesthete', taskTitle: 'Polish', status: 'completed', stopReason: 'completed', rootActivityId: 'root',
    parentActivityId: 'root', inputKind: 'director', summary: {title: 'Goal: do the thing', report: '⏵ Wrapping up\n\n' + 'word '.repeat(200), source: 'local'}});
  say(store, 'kalon', 'user', 'go', {activityId: 'a', inputKind: 'director', source: 'logox', time: at(1)});
  const report = events(store).find(event => event.kind === 'report')!;
  assert.ok(!report.text.startsWith('⏵') && !report.text.includes('\n'));
  assert.ok(report.text.length <= 240 && report.text.endsWith('…'));
});

test('records without timestamps keep record order and sit at the time of the message record they follow', () => {
  const store = new RuntimeStore();
  store.activities.create({...base, activityId: 'root', ownerId: 'logox', kind: 'director', title: 'x', status: 'completed', rootActivityId: 'root'});
  store.activities.create({...base, activityId: 'a', ownerId: 'kalon', kind: 'actor', title: 'K', taskTitle: 'Draw', status: 'completed', stopReason: 'completed', rootActivityId: 'root', parentActivityId: 'root', inputKind: 'director',
    summary: {title: 'Drawn', report: 'ok', source: 'model'}});
  say(store, 'logox', 'user', 'one', {activityId: 'root', inputKind: 'human', time: undefined});
  say(store, 'kalon', 'user', 'brief', {activityId: 'a', inputKind: 'director', source: 'logox', time: undefined});
  say(store, 'kalon', 'assistant', 'done', {activityId: 'a', time: undefined});
  say(store, 'logox', 'user', 'two', {activityId: 'root', inputKind: 'human', time: undefined});
  const list = events(store);
  assert.deepEqual(list.map(event => event.kind + ':' + event.text), ['user:one', 'assign:Draw', 'report:Drawn', 'user:two']);
  assert.ok(list.every(event => Number.isFinite(event.at)));
  // With times on some records only, the untimed ones inherit the nearest earlier time.
  const mixed = new RuntimeStore();
  mixed.activities.create({...base, activityId: 'root', ownerId: 'logox', kind: 'director', title: 'x', status: 'completed', rootActivityId: 'root'});
  say(mixed, 'logox', 'user', 'first', {activityId: 'root', inputKind: 'human', time: at(5)});
  say(mixed, 'logox', 'user', 'second', {activityId: 'root', inputKind: 'human', time: undefined});
  assert.deepEqual(events(mixed).map(event => [event.text, event.at]), [['first', at(5)], ['second', at(5)]]);
});

test('a broadcast is one event, a pending delivery shows until it is consumed, and a wait on a prerequisite that had already ended is not one', () => {
  const store = new RuntimeStore();
  store.activities.create({...base, activityId: 'root', ownerId: 'logox', kind: 'director', title: 'x', status: 'running', rootActivityId: 'root'});
  for (const owner of ['kalon', 'techne']) say(store, owner, 'user', '[Message from logox · heads up]\nShip at five', {inputKind: 'collaboration', source: 'coordination', time: at(10)});
  say(store, 'aletheia', 'user', '[Message from logox · heads up]\nShip at five', {inputKind: 'collaboration', source: 'coordination', time: at(100)});
  const list = events(store, {deliveries: [{id: 'd1', kind: 'collaboration', status: 'pending', ownerId: 'techne', source: 'kalon', text: '[Message from kalon · pending]\nNot read yet', time: at(300)},
    {id: 'd2', kind: 'collaboration', status: 'delivered', ownerId: 'techne', source: 'kalon', text: 'gone', time: at(301)}, {id: 'd3', kind: 'report', status: 'pending', ownerId: 'logox', source: 'kalon', text: 'held', time: at(302)}]});
  assert.deepEqual(list.map(event => [event.from, event.to, event.text]), [['logox', ['kalon', 'techne'], 'Ship at five'], ['logox', ['aletheia'], 'Ship at five'], ['kalon', ['techne'], 'Not read yet']]);
  assert.equal(list[2]!.ref, 'd1');
  // `after` a prerequisite that finished before the dispatch.
  const waits = (prerequisiteEnded: number) => {
    const store = new RuntimeStore();
    store.activities.create({...base, activityId: 'root', ownerId: 'logox', kind: 'director', title: 'x', status: 'running', rootActivityId: 'root'});
    store.activities.create({...base, activityId: 'p', ownerId: 'kalon', kind: 'actor', title: 'K', status: 'completed', stopReason: 'completed', rootActivityId: 'root', parentActivityId: 'root', inputKind: 'director', finishedAt: at(prerequisiteEnded), startedAt: at(1)});
    store.activities.create({...base, activityId: 'q', ownerId: 'techne', kind: 'actor', title: 'T', status: 'running', rootActivityId: 'root', parentActivityId: 'root', inputKind: 'director', after: ['p'], startedAt: at(20)});
    return store;
  };
  assert.ok(!events(waits(5)).some(event => event.kind === 'waiting'));
  assert.deepEqual(events(waits(30)).filter(event => event.kind === 'waiting').map(event => [event.from, event.to, event.text]), [['techne', ['kalon'], 'waiting on kalon']]);
});

test('a pending approval is a waiting post addressed to the user; the user can message any window', () => {
  const store = new RuntimeStore();
  store.activities.create({...base, activityId: 'root', ownerId: 'logox', kind: 'director', title: 'x', status: 'running', rootActivityId: 'root'});
  store.activities.create({...base, activityId: 'a', ownerId: 'techne', kind: 'actor', title: 'T', status: 'waiting_input', rootActivityId: 'root', parentActivityId: 'root', inputKind: 'director'});
  store.interactions.open({kind: 'permission', sessionId: 's', activityId: 'a', ownerId: 'techne', title: 'Write', tool: 'Write', arguments: {}, reason: 'ask'});
  say(store, 'techne', 'user', 'Bigger beak', {activityId: 'a', inputKind: 'human', source: 'direct', time: at(3)});
  const list = events(store);
  assert.deepEqual(list.map(event => [event.kind, event.from, event.to, event.text]).filter(row => row[0] !== 'assign'), [['user', 'user', ['techne'], 'Bigger beak'], ['waiting', 'techne', ['user'], 'awaiting approval (Write)']]);
});

test('members and involvement: senders, recipients and the dispatcher of a worker, `you` last', () => {
  const list = events(session());
  assert.deepEqual(teamMembers(list), ['logox', 'kalon', 'techne', 'aletheia', 'user']);
  const result = list.find(event => event.kind === 'result')!;
  assert.ok(involves(result, 'kalon') && !involves(result, 'techne'));
  assert.ok(involves(list[0]!, 'user') && involves(list[0]!, 'logox') && !involves(list[0]!, 'kalon'));
});

test('the stream is memoised on the store revision and keeps the same array while the events do not change', () => {
  const store = session();
  const stream = new TeamStream();
  const input = () => ({snapshot: store.getSnapshot(), sessionId: 's'});
  const first = stream.get(input());
  assert.equal(stream.get(input()), first);
  assert.equal(stream.computed, 1, 'an unchanged revision projects nothing');
  // A store change that projects to the same list returns the same array.
  say(store, 'logox', 'assistant', 'noted', {activityId: 'root', time: at(260)});
  assert.equal(stream.get(input()), first);
  assert.equal(stream.computed, 2);
  say(store, 'logox', 'user', 'One more', {activityId: 'root', inputKind: 'human', time: at(400)});
  const next = stream.get(input());
  assert.notEqual(next, first);
  assert.equal(next.length, first.length + 1);
});
