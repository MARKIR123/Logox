import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadConfig} from '../src/config/config.js';
import {runHeadless, type HeadlessIo} from '../src/headless.js';
import {createSessionHub} from '../src/session-hub.js';
import {createTestApplication, finalizingProvider, waitForSnapshot} from './runtime-fixture.js';
import type {ModelRequest, ModelTurn, Provider} from '../src/runtime/messages.js';

const call = (name: string, args: unknown, id = name.toLowerCase() + '-1'): ModelTurn => ({stop: 'tools', message: {role: 'assistant', text: '', toolCalls: [{id, name, arguments: JSON.stringify(args)}]}});
const reply = (text: string): ModelTurn => ({stop: 'complete', message: {role: 'assistant', text}});
const all = (request: ModelRequest) => request.messages.map(message => message.text).join('\n');
const sse = (chunk: unknown) => 'data: ' + JSON.stringify(chunk) + '\n\n';

const CONFIG = {permissions: {mode: 'creative' as const}, provider: {name: 'alpha', model: 'session-model'}, providers: {alpha: {base_url: 'http://127.0.0.1:7777/v1'}},
  models: {'alpha/session-model': {context_window: 64000}, 'alpha/my-worker': {context_window: 64000}}, kernel: {max_retries: 0}};

async function project() {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'logox-plan-app-')));
  const config = await loadConfig(cwd, CONFIG, {}, cwd, cwd);
  return {cwd, config, planFile: (id = 'p1') => join(cwd, '.logox', 'plans', id + '.md'), async close() {await rm(cwd, {recursive: true, force: true, maxRetries: 50, retryDelay: 50});}};
}
/** The worker endpoint: every request finishes the job at once. */
const finishing: typeof fetch = async () => new Response(sse({choices: [{index: 0, delta: {tool_calls: [{index: 0, id: 'w1', type: 'function',
  function: {name: 'Finish', arguments: JSON.stringify({status: 'done', summary: 'looked', evidence: ['a.ts:1']})}}]}, finish_reason: 'tool_calls'}]}) +
  sse({choices: [], usage: {prompt_tokens: 10, completion_tokens: 2}}) + 'data: [DONE]\n\n', {status: 200, headers: {'content-type': 'text/event-stream'}});

/** A Director that plans, dispatches two tasks on nodes, and answers when both reports arrive; Techne splits its node; every request is recorded. */
function ensemble(requests: {who: string; text: string}[]): Provider {
  return {async respond(request) {
    const text = all(request);
    const director = request.tools.some(tool => tool.name === 'Actor');
    const who = director ? 'logox' : text.includes('TECHNE-TASK') ? 'techne' : text.includes('KALON-TASK') ? 'kalon' : 'other';
    requests.push({who, text});
    const results = request.messages.filter(message => message.role === 'tool').length;
    if (who === 'logox') {
      if (text.includes('Actor techne activity')) return reply('All done.');
      if (results === 0) return call('Plan', {op: 'create', title: 'Theme preview', nodes: [{title: 'Design', owner: 'techne'}, {title: 'Ship', owner: 'kalon'}]});
      if (results === 1) return call('Actor', {briefCheck: 'skip', tasks: [{ownerId: 'techne', title: 'Design work', prompt: 'TECHNE-TASK design it', node: '1'}, {ownerId: 'kalon', title: 'Polish colors', prompt: 'KALON-TASK polish', node: '2'}]});
      return reply('Working.');
    }
    if (who === 'techne' && results === 0) return call('Plan', {op: 'add', parent: '1', nodes: [{title: 'Sub step', owner: 'automa'}]});
    return reply(who + ' finished.');
  }};
}

test('a Director plans, dispatches on nodes, companions split their node, and the Director hears of it once; no other request carries plan text', {timeout: 60000}, async () => {
  const p = await project();
  const requests: {who: string; text: string}[] = [];
  const app = await createTestApplication({cwd: p.cwd, resourceOptions: {home: p.cwd, boundary: p.cwd}, config: p.config, env: {}, authPath: join(p.cwd, 'auth.json'), provider: ensemble(requests), sessionId: 'plan-session'});
  try {
    await app.submit('Make the theme preview.');
    await waitForSnapshot(app.store, snapshot => snapshot.activities.filter(activity => activity.ownerId === 'logox').length >= 2 && snapshot.activities.every(activity => ['completed', 'failed', 'cancelled'].includes(activity.status)));
    const of = (who: string) => requests.filter(request => request.who === who);
    // Techne and Kalon were told their own node and nothing else of the plan.
    const techne = of('techne')[0]!.text;
    assert.match(techne, /Plan context:\n1 Design \[[a-z]+\] techne {2}<- your task/);
    assert.doesNotMatch(techne.slice(techne.indexOf('Plan context:')), /2 Ship/);
    const kalon = of('kalon');
    assert.match(kalon[0]!.text, /Plan context:\n2 Ship \[[a-z]+\] kalon {2}<- your task/);
    for (const request of kalon) assert.doesNotMatch(request.text, /Sub step|Design \[/, 'the companion never receives the rest of the plan');
    // The Director: no update before anything changed, exactly one block after the wake, listing only the changed nodes.
    const wake = of('logox');
    const withUpdate = wake.filter(request => request.text.includes('changes made by others'));
    assert.ok(withUpdate.length >= 1);
    for (const request of wake) assert.ok(request.text.split('changes made by others').length <= 2, 'one update block per request');
    assert.equal(wake.slice(0, 3).filter(request => request.text.includes('changes made by others')).length, 0, 'nothing is added while the Director only works on its own plan');
    const last = wake.at(-1)!.text;
    assert.match(last, /Plan p1 "Theme preview": changes made by others/);
    assert.match(last, /\+ 1\.1 Sub step \[[a-z]+\] automa \(under 1\)/);
    assert.doesNotMatch(last.slice(last.indexOf('changes made by others')), /2 Ship \[ready\]/);
    // The plan file (for people) holds the structure and the links; statuses derive from the work.
    const text = await readFile(p.planFile(), 'utf8');
    assert.match(text, /^# Theme preview <!-- plan:p1 status:active session:plan-session /);
    assert.match(text, /1\.1 Sub step — automa/);
    const derived = app.plans.active()!;
    const links = derived.nodes.find(node => node.id === '1')!.links;
    assert.equal(links.length, 1);
    assert.ok(links[0]!.activityId && app.store.getSnapshot().activities.find(activity => activity.activityId === links[0]!.activityId)!.planNode === '1');
    assert.equal(derived.nodes.find(node => node.id === '2')!.status, 'done');
    // Accept on evidence read from the linked work (the report of Kalon's task).
    const accepted = await app.plans.apply([{op: 'accept', id: '2'}], 'logox');
    assert.ok(accepted.ok, accepted.ok ? '' : accepted.error);
    assert.match((accepted.ok ? accepted.plan.nodes.find(node => node.id === '2')!.accepted!.evidence : []).join('|'), /Reported by Kalon|Changed by Kalon/);
  } finally {await app.close(); await p.close();}
});

test('an Automa job with node links to it, the node follows the job, and an unknown node is refused with the fix', {timeout: 60000}, async () => {
  const p = await project();
  const seen: string[] = [];
  const provider: Provider = {async respond(request) {
    const text = all(request), results = request.messages.filter(message => message.role === 'tool');
    if (text.includes('<automa-result')) return reply('Looked.');
    if (results.length === 0) return call('Plan', {op: 'create', title: 'Look around', nodes: [{title: 'Survey', owner: 'logox'}]});
    if (results.length === 1) return call('Automa', {jobs: [{brief: 'Look at notes', scope: 'exact', node: '9'}]}, 'automa-bad');
    seen.push(results.at(-1)!.text);
    return call('Automa', {jobs: [{brief: 'Look at notes', title: 'Look', scope: 'exact', node: '1'}]}, 'automa-good');
  }};
  const app = await createTestApplication({cwd: p.cwd, resourceOptions: {home: p.cwd, boundary: p.cwd}, config: p.config, env: {}, authPath: join(p.cwd, 'auth.json'), provider, fetcher: finishing, sessionId: 'plan-automa'});
  try {
    await app.submit('/model automa read alpha/my-worker');
    await app.submit('survey');
    await waitForSnapshot(app.store, snapshot => snapshot.activities.some(activity => activity.ownerId === 'logox') && snapshot.activities.every(activity => ['completed', 'failed', 'cancelled'].includes(activity.status)));
    assert.match(seen[0]!, /^Unknown plan node "9"\. Fix: pass a node id of the active plan \(1\) or omit node\.$/);
    const node = app.plans.active()!.nodes[0]!;
    assert.equal(node.links.length, 1);
    assert.match(node.links[0]!.automaJob!, /^[^/]+\/L1$/);
    assert.equal(node.status, 'done');
    const job = app.store.getSnapshot().messages.flatMap(message => message.step?.swarm?.jobs ?? []).find(item => item.id === 'L1')!;
    assert.equal(job.node, '1');
    assert.match(await readFile(p.planFile(), 'utf8'), /links:[^/\s]+\/L1/);
  } finally {await app.close(); await p.close();}
});

test('headless JSON lists the plans the run touched', {timeout: 60000}, async () => {
  const p = await project();
  const out: string[] = [];
  const provider: Provider = {async respond(request) {
    return request.messages.some(message => message.role === 'tool') ? reply('Planned.') : call('Plan', {op: 'create', title: 'Headless plan', nodes: [{title: 'Only step', owner: 'logox'}]});
  }};
  try {
    await mkdir(join(p.cwd, '.logox', 'plans'), {recursive: true});
    await writeFile(join(p.cwd, '.logox', 'plans', 'p9.md'), '# Old plan <!-- plan:p9 status:active session:other-session created:2020-01-01T00:00:00.000Z -->\n\n## 1 Old <!-- n:1 owner:logox -->\n');
    await writeFile(join(p.cwd, '.logox', 'config.toml'), '[provider]\nmodel = "fixture"\ncontext_window = 131072\n\n[kernel]\nmax_retries = 0\n');
    const io: HeadlessIo = {cwd: p.cwd, env: {}, stdout: text => out.push(text), stderr: () => {}, provider: finalizingProvider(provider), resourceOptions: {home: p.cwd, boundary: p.cwd}, authPath: join(p.cwd, 'auth.json')};
    const code = await runHeadless(['-p', 'plan it', '--output', 'json'], io);
    assert.equal(code, 0);
    const report = JSON.parse(out.join(''));
    assert.deepEqual(report.plans.map((plan: {title: string}) => plan.title), ['Headless plan']);
    assert.equal(report.plans[0].nodes[0].status, 'ready');
    assert.equal(report.plans[0].sessionId, report.sessionId);
  } finally {await p.close();}
});

test('the hub lists a session\'s plans, accepts the person\'s edits as `user`, and moves plansRevision only for plan changes', {timeout: 60000}, async () => {
  const p = await project();
  const provider: Provider = {async respond() {return reply('ok');}};
  const hub = await createSessionHub({cwd: p.cwd, config: p.config, provider, resourceOptions: {home: p.cwd, boundary: p.cwd}, env: {}, authPath: join(p.cwd, 'auth.json')});
  try {
    const session = await hub.create();
    const start = hub.getSnapshot().plansRevision;
    assert.deepEqual(hub.plans(session.id), []);
    const created = await hub.planOp(session.id, {op: 'create', title: 'From the GUI', nodes: [{title: 'Draw', owner: 'kalon'}, {title: 'Ship', owner: 'techne', after: ['1']}]});
    assert.ok(created.ok, created.ok ? '' : created.error);
    const afterCreate = hub.getSnapshot().plansRevision;
    assert.ok(afterCreate > start);
    const [plan] = hub.plans(session.id);
    assert.equal(plan!.title, 'From the GUI');
    assert.deepEqual(plan!.nodes.map(node => [node.id, node.status]), [['1', 'ready'], ['2', 'pending']]);
    // The person may do what the Director may; a refusal answers with the fix and changes nothing.
    const refused = await hub.planOp(session.id, {op: 'update', id: '7', title: 'x'});
    assert.equal(refused.ok, false);
    assert.match(refused.ok ? '' : refused.error, /Unknown node "7".*Fix:/);
    assert.equal(hub.getSnapshot().plansRevision, afterCreate);
    const accepted = await hub.planOp(session.id, {op: 'accept', id: '1', evidence: ['drawn']});
    assert.ok(accepted.ok);
    assert.ok(hub.getSnapshot().plansRevision > afterCreate);
    assert.equal(hub.plans(session.id)[0]!.nodes[1]!.status, 'ready');
    await assert.rejects(async () => hub.plans('nope'), /Unknown open session/);
    // A person's edit of the file reaches the subscribers too.
    let notified = 0;
    const stop = hub.subscribe(() => {notified++;});
    const before = hub.getSnapshot().plansRevision;
    await writeFile(p.planFile(), (await readFile(p.planFile(), 'utf8')).replace('From the GUI', 'Renamed by a person'));
    await hub.refresh();
    assert.equal(hub.plans(session.id)[0]!.title, 'Renamed by a person');
    assert.ok(hub.getSnapshot().plansRevision > before && notified > 0);
    stop();
  } finally {await hub.shutdown(); await p.close();}
});
