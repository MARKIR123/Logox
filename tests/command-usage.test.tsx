import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PassThrough} from 'node:stream';
import {act, type ReactElement} from 'react';
import {setTimeout as delay} from 'node:timers/promises';
import {createApplication} from '../src/application.js';
import {loadConfig} from '../src/config/config.js';
import {commandCatalog} from '../src/commands.js';
import {commandSuggestions} from '../src/tui/commands/completion.js';
import {emptyCommandContext} from '../src/commands.js';
import {planUsageRows, sessionUsageRows, type UsageOwner} from '../src/context/usage.js';
import {rowText} from '../src/commands/tab-rows.js';
import {renderTerminal as render} from '../src/tui/terminal/terminal.js';
import {TerminalScreen} from './terminal-screen.js';
import {MouseHost} from '../src/tui/terminal/mouse.js';
import {TabbedPage} from '../src/tui/panels/tabbed-page.js';
import {tabContent} from '../src/commands/tab-rows.js';
import {waitFor} from './wait-for.js';
import type {UsageRecord} from '../src/context/budget.js';
import type {CommandTab} from '../src/runtime/command-surface.js';
Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
class Input extends PassThrough {isTTY = true; setRawMode(): this {return this;} ref(): this {return this;} unref(): this {return this;}}

const config = {models: {'alpha/m': {prices: {currency: 'USD', input: 1, output: 2, cache_read: 0.1, cache_write: 1.25}}}} as never;
let serial = 0;
const record = (model: string, category: UsageRecord['category'], input: number, output: number, cacheRead = 0): UsageRecord =>
  ({id: 'r' + serial++, model, category, input, output, cacheRead, cacheWrite: 0});
const owners = (): UsageOwner[] => [
  {id: 'logox', name: 'Logox', records: [record('alpha/m', 'task', 1000, 100, 600), record('alpha/m', 'summary', 200, 20)]},
  {id: 'techne', name: 'Techne', records: [record('alpha/m', 'task', 2000, 200, 1000), record('alpha/m', 'automa', 300, 30)]},
  {id: 'kalon', name: 'Kalon', records: [record('beta/n', 'task', 500, 50)]},
  {id: 'aletheia', name: 'Aletheia', records: []},
];
const text = (rows: ReturnType<typeof sessionUsageRows>) => rows.map(rowText).join('\n');
const field = (rows: ReturnType<typeof sessionUsageRows>, label: string) => rows.flatMap(row => row.kind === 'field' && row.label === label ? [row.value] : []);

test('session tab: total equals the actors, Automa is attributed to its dispatcher, partial cost names the unpriced model', () => {
  const rows = sessionUsageRows({owners: owners(), config, now: 125_000, startedAt: 0});
  const output = text(rows);
  assert.deepEqual(field(rows, 'Tokens')[0], '4,000 in / 400 out / 1,600 cache read / 0 cache write', 'the session total is the sum of every actor and Automa');
  assert.equal(field(rows, 'Cache hit')[0], '40% of input');
  assert.equal(field(rows, 'Wall time')[0], '2m 5s');
  assert.equal(field(rows, 'Requests')[0], '5');
  assert.match(field(rows, 'Cost')[0]!, /^~0\.\d+ USD \(partial\)$/);
  assert.match(output, /Unpriced, so the cost is partial: beta\/n \(1 turn\)/);
  // One block per actor in roster order; Automa calls are not counted in the actor's own block.
  const order = ['Session total', 'Logox', 'Techne', 'Kalon', 'Aletheia', 'Automa', 'By model', 'By category'].map(name => rows.findIndex(row => row.kind === 'heading' && row.text === name));
  assert.ok(order.every(index => index >= 0) && order.every((index, at) => at === 0 || index > order[at - 1]!), 'blocks follow the roster, then Automa, models, categories: ' + order);
  assert.match(output, /Aletheia\n.*No usage yet/);
  const techne = rows.slice(order[2]!, order[3]!);
  assert.equal(techne.flatMap(row => row.kind === 'field' && row.label === 'Requests' ? [row.value] : [])[0], '1', 'Techne\'s block holds its own call only');
  assert.match(output, /Dispatched by Techne: .* · 300 in \/ 30 out · cache hit 0% · 1 request/);
  assert.match(output, /alpha\/m: .*3,500 in \/ 350 out/);
  assert.match(output, /beta\/n: unknown \(no price\) · 500 in \/ 50 out/);
});

test('session tab: categories appear only when used and a fully priced session is not partial', () => {
  const rows = sessionUsageRows({owners: [{id: 'logox', name: 'Logox', records: [record('alpha/m', 'task', 100, 10)]}], config, now: 5000});
  const output = text(rows);
  assert.match(output, /Task: /);
  assert.doesNotMatch(output, /Summary: |Approval: |Automa|Keep-alive: |Wall time/);
  assert.doesNotMatch(field(rows, 'Cost')[0]!, /partial|~/);
  assert.doesNotMatch(output, /Unpriced/);
  const empty = text(sessionUsageRows({owners: [{id: 'logox', name: 'Logox', records: []}], config, now: 0}));
  assert.match(empty, /No response usage recorded yet\./);
});

test('plan tab: absent without a subscription provider, otherwise one muted line says limits are not reported', () => {
  const input = {owners: [{id: 'logox', name: 'Logox', records: [record('sub/gpt', 'task', 100, 10), record('alpha/m', 'task', 50, 5)]}], config, now: 0};
  assert.equal(planUsageRows(input), undefined);
  assert.equal(planUsageRows({...input, subscriptions: new Set(['other'])}), undefined);
  const rows = planUsageRows({...input, subscriptions: new Set(['sub'])})!;
  assert.deepEqual(rows.filter(row => row.kind === 'text' && row.tone === 'muted').map(rowText), ['Plan limits and reset times are not reported by this provider.']);
  assert.match(text(rows), /sub \(subscription\)/);
  assert.match(text(rows), /This session: 100 in \/ 10 out · 1 request/);
  assert.doesNotMatch(text(rows), /alpha/);
  assert.ok(planUsageRows({owners: [{id: 'logox', name: 'Logox', records: []}], config, now: 0, subscriptions: new Set(['sub']), selected: ['sub']}), 'a selected subscription provider is in use before any call');
});

test('/usage is in the catalog, completion and help, and /cost opens the same page', async () => {
  assert.ok(commandCatalog.some(command => command.name === 'usage' && /plan/i.test(command.description)));
  assert.ok(commandSuggestions({text: '/usa', cursor: 4} as never, emptyCommandContext).some(item => item.label === '/usage'));
  const cwd = await mkdtemp(join(tmpdir(), 'logox-usage-'));
  try {
    const app = await createApplication({cwd, config: await loadConfig(cwd, {provider: {model: 'test', context_window: 8192}}, {}, cwd, cwd), env: {}, sessionId: 'usage-cost',
      authPath: join(cwd, 'auth.json'), resourceOptions: {home: cwd, boundary: cwd}});
    try {
      await app.submit('/cost');
      const page = app.surfaces.getSnapshot();
      assert.ok(page?.kind === 'page'); assert.equal(page.title, 'Usage'); assert.deepEqual(page.tabs.map(tab => tab.id), ['session'], 'no plan tab without a subscription provider');
      app.surfaces.cancel();
    } finally {await app.close();}
  } finally {await rm(cwd, {recursive: true, force: true});}
});

test('/usage page grows with the session, /status shows the session total and the hint, subscription providers add the Plan tab', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-usage-'));
  try {
    await writeFile(join(cwd, 'auth.json'), JSON.stringify({sub: {type: 'oauth', access_token: 'synthetic'}}));
    const loaded = await loadConfig(cwd, {provider: {model: 'test', context_window: 8192},
      models: {'alpha/m': {prices: {currency: 'USD', input: 1, output: 2, cache_read: 0.1, cache_write: 1.25}}}}, {}, cwd, cwd);
    const app = await createApplication({cwd, config: loaded, env: {}, sessionId: 'usage-live', authPath: join(cwd, 'auth.json'), resourceOptions: {home: cwd, boundary: cwd}});
    try {
      const charge = (owner: string, model: string, category: UsageRecord['category'], input: number, output: number, cacheRead = 0) =>
        app.contexts.meter({sessionId: 'usage-live', ownerId: owner}).chargeUsage({input, output, cacheRead}, model, category);
      charge('logox', 'alpha/m', 'task', 1000, 100, 600);
      charge('techne', 'alpha/m', 'task', 2000, 200, 1000);
      charge('techne', 'alpha/m', 'automa', 300, 30);
      charge('kalon', 'beta/n', 'task', 500, 50);
      await app.submit('/usage');
      const tab = (id: string) => {const page = app.surfaces.getSnapshot(); return page?.kind === 'page' ? page.tabs.find(item => item.id === id) : undefined;};
      assert.ok(tab('session'));
      const lines = tab('session')!.lines.join('\n');
      assert.match(lines, /Tokens: 3,800 in \/ 380 out \/ 1,600 cache read \/ 0 cache write/);
      assert.match(lines, /Dispatched by Techne/);
      assert.match(lines, /Unpriced, so the cost is partial: beta\/n/);
      // The open page follows usage that arrives later, without reopening.
      charge('logox', 'alpha/m', 'approval', 100, 10);
      await waitFor(() => tab('session')?.lines.join('\n') ?? '', value => /Tokens: 3,900 in \/ 390 out/.test(value) && /Approval: /.test(value), {label: 'usage page refresh'});
      // The subscription list settles in the background; its arrival adds the Plan tab to the open page.
      charge('logox', 'sub/gpt', 'task', 10, 1);
      await waitFor(() => tab('plan')?.lines.join('\n') ?? '', value => /not reported by this provider/.test(value), {label: 'plan tab'});
      app.surfaces.cancel();
      await app.submit('/status');
      const status = app.surfaces.getSnapshot();
      assert.ok(status?.kind === 'page');
      const usage = status.tabs.find(item => item.id === 'usage')!.lines.join('\n');
      assert.match(usage, /Tokens: 3,910 in \/ 391 out \/ 1,600 cache read/);
      assert.match(usage, /Details: \/usage/);
      assert.doesNotMatch(usage, /Breakdown/);
      app.surfaces.cancel();
    } finally {await app.close();}
  } finally {await rm(cwd, {recursive: true, force: true});}
});

test('/usage tab bar and rows take the mouse: click switches Session and Plan, wheel scrolls, hover does not change content', async () => {
  const plan = planUsageRows({owners: [{id: 'logox', name: 'Logox', records: [record('sub/gpt', 'task', 100, 10)]}], config, now: 0, subscriptions: new Set(['sub'])})!;
  const tabs: CommandTab[] = [
    {id: 'session', title: 'Session', ...tabContent(sessionUsageRows({owners: owners(), config, now: 125_000, startedAt: 0}))},
    {id: 'plan', title: 'Plan', ...tabContent(plan)}];
  const input = new Input(), output = new TerminalScreen(); output.columns = 70; output.rows = 12;
  const listeners = new Set<(event: import('../src/tui/terminal/mouse.js').SgrMouseEvent) => void>();
  let instance!: ReturnType<typeof render>;
  const element: ReactElement = <MouseHost subscribe={handler => {listeners.add(handler); return () => {listeners.delete(handler);};}} color="#ff8800">
    <TabbedPage title="Usage" tabs={tabs} initialTab="session" width={70} height={12} y={0} onClose={() => {}}/></MouseHost>;
  await act(async () => {instance = render(element, {stdin: input, stdout: output, stderr: output, interactive: true, alternateScreen: true, patchConsole: false, exitOnCtrlC: false, maxFps: 100});});
  const flush = async () => {await act(async () => {await instance.waitUntilRenderFlush();});};
  const send = async (button: number, x: number, y: number, action: 'press' | 'release' | 'move' | 'wheel_up' | 'wheel_down') => {
    await act(async () => {for (const listener of listeners) listener({button, x, y, action}); await delay(5);}); await flush();
  };
  try {
    await flush();
    assert.match(output.lines.join('\n'), /Session total/);
    const barY = output.lines.findIndex(line => line.includes('Plan')), x = output.lines[barY]!.indexOf('Plan');
    await send(0, x + 1, barY, 'move');
    assert.match(output.lines.join('\n'), /Session total/, 'hover leaves the page as it is');
    await send(0, x + 1, barY, 'press'); await send(0, x + 1, barY, 'release');
    assert.match(output.lines.join('\n'), /sub \(subscription\)/, 'clicking the Plan tab shows its rows');
    assert.match(output.lines.join('\n'), /not reported by this provider/);
    const sessionX = output.lines[barY]!.indexOf('Session');
    await send(0, sessionX + 1, barY, 'press'); await send(0, sessionX + 1, barY, 'release');
    await send(0, 5, 5, 'wheel_down'); await send(0, 5, 5, 'wheel_down');
    assert.doesNotMatch(output.lines.join('\n'), /Session total/, 'the wheel scrolls the long Session tab');
  } finally {await act(async () => {instance.unmount();}); await instance.waitUntilExit(); input.destroy(); output.destroy();}
});
