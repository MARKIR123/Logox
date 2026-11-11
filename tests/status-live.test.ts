import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../src/application.js';
import {loadConfig} from '../src/config/config.js';
import type {ModelRequest} from '../src/runtime/messages.js';
import {waitForSnapshot} from './runtime-fixture.js';

async function fixture(sessionId?: string, shared?: {root: string}) {
  const root = shared?.root ?? await realpath(await mkdtemp(join(tmpdir(), 'logox-status-live-')));
  const project = join(root, 'project'), home = join(root, 'home');
  await mkdir(join(project, '.logox'), {recursive: true}); await mkdir(join(home, '.logox'), {recursive: true});
  const config = await loadConfig(project, {permissions: {mode: 'default'}, provider: {model: 'main', context_window: 131072}}, {}, home, project);
  const app = await createApplication({cwd: project, config, env: {}, resourceOptions: {home, boundary: project}, ...(sessionId ? {sessionId} : {}),
    authPath: join(home, '.logox', 'auth.json'), statusbarPath: join(home, '.logox', 'statusbar.json'),
    fetcher: async () => {throw new Error('offline');},
    provider: {async respond(request: ModelRequest) {
      return {message: {role: 'assistant' as const, text: 'done', toolCalls: [{id: 'finish-' + request.messages.length, name: '_FinishRound',
        arguments: JSON.stringify({title: 'Done', summary: 'ok'})}]}, stop: 'tools' as const,
        usage: {input: 700, output: 50, cacheRead: 200}};
    }}});
  return {root, app};
}

test('context reading is recorded from the response usage, totals split input/output/cached, and the last state is kept', async () => {
  const {root, app} = await fixture();
  try {
    assert.equal(app.status('logox').state, 'Ready');
    await app.submit('hello');
    await waitForSnapshot(app.store, snapshot => snapshot.activities.some(activity => activity.status === 'completed'));
    const status = app.status('logox');
    assert.equal(status.context?.tokens, 750);
    assert.equal(status.context?.estimated, false);
    assert.equal(status.context?.over, false);
    assert.ok((status.context?.high ?? 0) > 0);
    assert.equal(status.state, 'Completed');
    assert.deepEqual(status.usage?.window, {input: 500, output: 50, cached: 200});
    assert.deepEqual(status.usage?.session, status.usage?.window);
    assert.equal(status.tokens, 550, 'tokens is the session total of fresh input plus output');
  } finally {await app.close(); await rm(root, {recursive: true, force: true});}
});

test('a resumed session restores meters and context readings before any actor runs', async () => {
  const first = await fixture('resume-status');
  let second: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    await first.app.submit('hello');
    await waitForSnapshot(first.app.store, snapshot => snapshot.activities.some(activity => activity.status === 'completed'));
    await first.app.persistSession();
    await first.app.close();
    second = await fixture('resume-status', first);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !second.app.status('logox').usage?.session.output) await new Promise(resolve => setTimeout(resolve, 25));
    const status = second.app.status('logox');
    assert.equal(status.usage?.session.output, 50, 'persisted usage is visible without a new request');
    assert.equal(status.tokens, 550);
    assert.ok(status.context, 'a window with history has a context reading after resume');
    assert.equal(status.context?.estimated, true, 'recomputed readings are marked as estimates');
  } finally {
    await second?.app.close().catch(() => {});
    await first.app.close().catch(() => {});
    await rm(first.root, {recursive: true, force: true});
  }
});

test('permission mode changes bump the status revision so the footer refreshes at once', async () => {
  const {root, app} = await fixture();
  try {
    let notified = 0;
    const stop = app.subscribeStatus(() => {notified++;});
    const before = app.getStatusSnapshot();
    await app.permissions.setMode('creative');
    assert.notEqual(app.getStatusSnapshot(), before);
    assert.ok(notified > 0);
    assert.equal(app.status('logox').permission, 'creative');
    stop();
  } finally {await app.close(); await rm(root, {recursive: true, force: true});}
});

const page = (app: Awaited<ReturnType<typeof fixture>>['app']) => {
  const surface = app.surfaces.getSnapshot();
  assert.ok(surface?.kind === 'page', 'a page is open');
  return surface;
};

test('/config and /status agree on the model and thinking effort and carry no leftover rows', async () => {
  const {root, app} = await fixture();
  try {
    await app.submit('/config');
    const config = page(app).tabs[0]!;
    assert.ok(!config.lines[0]!.includes('Effective Configuration'), 'the page title is not repeated as the first row');
    assert.ok(config.lines.every(line => !line.includes('Claude Code mode')));
    assert.ok(config.rows?.some(item => item.kind === 'rule' && item.title === 'Execution Limits'), 'separators are rows, not 61-char strings');
    assert.ok(config.lines.every(line => !/^─{20,}$/.test(line)));
    const effort = config.lines.find(line => line.startsWith('Thinking effort:'));
    app.surfaces.cancel();
    await app.submit('/status');
    const status = page(app).tabs.find(tab => tab.id === 'status')!;
    assert.equal(status.lines.find(line => line.startsWith('Thinking effort:')), effort);
    assert.ok(!status.lines.some(line => line === 'Resource origins:'), 'no empty header');
    assert.ok(status.lines.some(line => line.startsWith('Project rules')));
    assert.ok(status.lines.some(line => line.startsWith('Tokens (session, all windows):')));
  } finally {app.surfaces.cancel(); await app.close(); await rm(root, {recursive: true, force: true});}
});

test('permissions page saves the mode only through set_mode and closes with a receipt', async () => {
  const {root, app} = await fixture();
  try {
    await app.submit('/permissions');
    const open = page(app);
    const initial = app.permissions.mode;
    assert.equal(open.tabs[0]!.permissions?.mode.current, initial);
    assert.deepEqual(open.tabs[0]!.permissions?.mode.options.map(option => option.id), ['default', 'auto', 'creative']);
    await app.surfaces.triggerTabAction(open.id, 'permissions', 'toggle_mode');
    assert.equal(app.permissions.mode, initial, 'the old one-key cycle no longer changes anything');
    await app.surfaces.triggerTabAction(open.id, 'permissions', 'set_mode:creative');
    assert.equal(app.permissions.mode, 'creative');
    assert.equal(app.surfaces.getSnapshot(), null);
    const receipt = app.store.getSnapshot().messages.filter(message => message.role === 'system').at(-1)!;
    assert.equal(receipt.text, 'Permission mode set to creative');
    assert.equal(receipt.systemPresentation, 'status');
  } finally {app.surfaces.cancel(); await app.close(); await rm(root, {recursive: true, force: true});}
});

test('provider logout from the page needs a confirmation and can be cancelled', async () => {
  const {root, app} = await fixture();
  try {
    await app.submit('/providers');
    const open = page(app);
    await app.surfaces.triggerTabAction(open.id, 'providers', 'logout');
    const asking = page(app);
    assert.match(asking.confirm?.prompt ?? '', /Log out of provider/);
    await app.surfaces.triggerTabAction(open.id, 'providers', 'cancel_confirm');
    assert.equal(page(app).confirm, undefined);
  } finally {app.surfaces.cancel(); await app.close(); await rm(root, {recursive: true, force: true});}
});

test('a failed theme/cursor save is reported instead of swallowed', async () => {
  const {root, app} = await fixture();
  try {
    // A directory where the preference file belongs makes the write fail.
    await mkdir(join(root, 'home', '.logox', 'ui-preferences.json'), {recursive: true});
    await app.submit('/settings');
    const open = app.surfaces.getSnapshot();
    assert.ok(open?.kind === 'settings');
    await app.surfaces.saveSettings(open.id, {cursor: 'Underline _'});
    const receipt = app.store.getSnapshot().messages.filter(message => message.role === 'system').at(-1)!;
    assert.match(receipt.text, /Cursor was not saved/);
    assert.equal(receipt.systemEventKind, 'command_error');
  } finally {app.surfaces.cancel(); await app.close(); await rm(root, {recursive: true, force: true});}
});

test('permissions page adds and deletes rules through validated actions and refreshes its rows', async () => {
  const {root, app} = await fixture();
  try {
    await app.submit('/permissions');
    const open = page(app);
    const add = JSON.stringify({scope: 'session', decision: 'ask', tool: 'shell', pattern: 'git push'});
    await app.surfaces.triggerTabAction(open.id, 'permissions', 'add_rule:' + add);
    assert.deepEqual(page(app).tabs[0]!.permissions?.rules.map(rule => [rule.scope, rule.decision, rule.tool, rule.pattern, rule.hits]), [['session', 'ask', 'shell', 'git push', 0]]);
    await app.surfaces.triggerTabAction(open.id, 'permissions', 'add_rule:' + JSON.stringify({scope: 'session', decision: 'allow', tool: 'shell', pattern: 'a && b'}));
    assert.match(page(app).error ?? '', /static token prefixes/);
    assert.equal(page(app).tabs[0]!.permissions?.rules.length, 1);
    await app.surfaces.triggerTabAction(open.id, 'permissions', 'delete_rule:' + page(app).tabs[0]!.permissions!.rules[0]!.id);
    assert.equal(page(app).tabs[0]!.permissions?.rules.length, 0);
  } finally {app.surfaces.cancel(); await app.close(); await rm(root, {recursive: true, force: true});}
});
