import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {act} from 'react';
import {setTimeout as delay} from 'node:timers/promises';
import {mkdir, mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TerminalScreen} from './terminal-screen.js';
import {renderTerminal as render} from '../src/tui/terminal/terminal.js';
import {App} from '../src/tui/app.js';
import {teamStats} from '../src/tui/panels/team-sidebar.js';
import {loadConfig} from '../src/config/config.js';
import type {Provider} from '../src/runtime/messages.js';
import type {CommandSurface} from '../src/runtime/command-surface.js';
import {commandCatalog, commandHelp} from '../src/commands.js';
import {createTestApplication as createApplication} from './runtime-fixture.js';
import {waitFor} from './wait-for.js';

Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
class TerminalInput extends PassThrough {
  isTTY = true; setRawMode(): this {return this;} ref(): this {return this;} unref(): this {return this;}
}
type Application = Awaited<ReturnType<typeof createApplication>>;

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'logox-team-ui-')));
  const cwd = join(root, 'project'), home = join(root, 'home');
  await mkdir(cwd, {recursive: true}); await mkdir(join(home, '.logox'), {recursive: true});
  const config = await loadConfig(cwd, {permissions: {mode: 'default'}, provider: {model: 'fixture', context_window: 131072}}, {}, home, root);
  const provider: Provider = {async respond() {return {message: {role: 'assistant', text: 'Understood.'}, stop: 'complete'};}};
  const apps: Application[] = [];
  return {root,
    async open(sessionId = 'team-ui'): Promise<Application> {
      const app = await createApplication({cwd, config, provider, sessionId, resourceOptions: {home, boundary: root}, env: {}, authPath: join(root, 'auth.json')});
      apps.push(app); return app;
    },
    async close() {for (const app of apps) await app.close().catch(() => {}); await rm(root, {recursive: true, force: true, maxRetries: 50, retryDelay: 50});}};
}

interface Rig {app: Application; input: TerminalInput; output: TerminalScreen; instance: ReturnType<typeof render>;
  send(value: string): Promise<void>; screen(): string; side(): string[]; find(needle: string, from?: number, after?: number): {x: number; y: number}; mouse(kind: 'press' | 'move' | 'wheel_down' | 'wheel_up', x: number, y: number): Promise<void>;
  click(x: number, y: number): Promise<void>; clickText(needle: string, offset?: number): Promise<void>; sidebarX: number}
async function mount(app: Application, columns: number, rows: number): Promise<Rig> {
  const input = new TerminalInput(), output = new TerminalScreen();
  output.columns = columns; output.rows = rows;
  app.store.message(app.sessionId, 'logox', 'assistant', 'Ready when you are.');
  let instance!: ReturnType<typeof render>;
  await act(async () => {instance = render(<App stage sessionId={app.sessionId} store={app.store} plans={app.plans} surfaces={app.surfaces} onSubmit={app.submit}
    onCancel={() => {}} onClose={async () => {}}/>,
  {stdout: output, stdin: input, stderr: output, interactive: true, alternateScreen: true, patchConsole: false, exitOnCtrlC: false, maxFps: 100});});
  const send = async (value: string) => {await act(async () => {input.write(value); await delay(value === '\x1b' ? 40 : 10);}); await instance.waitUntilRenderFlush(); await delay(25);};
  const screen = () => output.lines.join('\n');
  const usable = columns - 1, sidebarX = usable - Math.max(36, Math.min(56, Math.floor(usable * 0.34)));
  const find = (needle: string, from = sidebarX, after = -1) => {
    for (let y = after + 1; y < output.lines.length; y++) {const x = output.lines[y]!.indexOf(needle, from); if (x >= 0) return {x, y};}
    assert.fail(needle + ' is not on screen:\n' + screen());
  };
  const mouse = async (kind: 'press' | 'move' | 'wheel_down' | 'wheel_up', x: number, y: number) =>
    send(kind === 'press' ? `\x1b[<0;${x + 1};${y + 1}M\x1b[<0;${x + 1};${y + 1}m` : kind === 'move' ? `\x1b[<35;${x + 1};${y + 1}M` : `\x1b[<${kind === 'wheel_up' ? 64 : 65};${x + 1};${y + 1}M`);
  return {app, input, output, instance, send, screen, side: () => output.lines.map(line => line.slice(sidebarX)), find, mouse, click: (x, y) => mouse('press', x, y),
    clickText: async (needle, offset = 1) => {const {x, y} = find(needle); await mouse('press', x + offset, y);}, sidebarX};
}
async function unmount(rig: Rig) {try {await act(async () => rig.instance.unmount());} catch {} rig.input.destroy(); rig.output.destroy();}
const surface = (app: Application): CommandSurface | null => app.surfaces.getSnapshot();

/** One human request, a dispatch to Kalon and a message from Techne to Kalon: three posts. */
function seed(app: Application) {
  const s = app.sessionId, base = {stage: '', detail: ''};
  app.store.activities.create({sessionId: s, activityId: 'root', ownerId: 'logox', kind: 'director', title: 'Draw', status: 'running', rootActivityId: 'root', inputKind: 'human', ...base});
  app.store.message(s, 'logox', 'user', 'Draw the pelican', {activityId: 'root', inputKind: 'human', source: 'direct', time: Date.now() - 3000});
  app.store.activities.create({sessionId: s, activityId: 'kal', ownerId: 'kalon', kind: 'actor', title: 'Kalon · Aesthete', taskTitle: 'Draw the SVG', status: 'running', rootActivityId: 'root', parentActivityId: 'root', inputKind: 'director', ...base});
  app.store.message(s, 'kalon', 'user', 'Draw the SVG', {activityId: 'kal', inputKind: 'director', source: 'logox', time: Date.now() - 2000});
  app.store.message(s, 'kalon', 'user', '[Message from techne · rename call]\nRenamed to buildStreetProps()\n\n**Update** your calls.', {activityId: 'kal', inputKind: 'collaboration', source: 'techne', time: Date.now() - 1000});
}
const NODES = [{title: 'Design', owner: 'logox', nodes: [{title: 'Palette', owner: 'techne'}]}, {title: 'Ship', owner: 'techne', after: ['1']}];
const hasCard = (text: string) => /│ \S Palette/.test(text);
const posts = (rig: Rig) => rig.side().join('\n');
/** The first match in the feed, under the stage's current-post card (which repeats the selected post). */
const feed = (rig: Rig, needle: string) => rig.find(needle, rig.sidebarX, rig.find('── #').y + 2);
/** A click on the rule under the tabs gives the sidebar the keyboard and changes nothing else. */
const focusSidebar = async (rig: Rig) => {const head = rig.find('Tasks'); await rig.click(rig.sidebarX + 10, head.y + 1);};

test('the sidebar header has two tabs: a click switches, `t` toggles from the keyboard, and the choice is remembered across hide and show', {timeout: 60000}, async () => {
  const f = await fixture(); let rig!: Rig;
  try {
    const app = await f.open();
    seed(app);
    await app.plans.apply([{op: 'create', title: 'Theme preview', nodes: NODES as never}], 'logox');
    rig = await mount(app, 120, 34);
    await waitFor(() => rig.screen(), text => hasCard(text), {label: 'the sidebar opens on Tasks'});
    assert.match(rig.side()[0]!, /Tasks Theme preview +Team/, 'Tasks is the title of its tab, Team the other tab at the right end');
    await rig.clickText('Team');
    await waitFor(() => posts(rig), text => /Tasks {2}Team +● Live/.test(text) && text.includes('◈ logox → @kalon · assign'), {label: 'the Team tab'});
    assert.ok(!hasCard(rig.screen()));
    for (const expected of ['✓ you → @logox', '◈ logox → @kalon · assign', '⊞ techne → @kalon', 'Draw the SVG', 'Renamed to buildStreetProps()']) assert.ok(posts(rig).includes(expected), expected + '\n' + posts(rig));
    assert.match(posts(rig), /◀ ▶ ▶ \S+ .*3\/3 · \+\d+s/, 'the stage controls carry the stepping and the counter');
    assert.match(posts(rig).split('\n').find(line => line.includes('all members ▾'))!, /^ *│? *all members ▾ *$/, 'the footer keeps only the member filter');
    await rig.clickText('Tasks');
    await waitFor(() => rig.screen(), text => hasCard(text), {label: 'back to Tasks'});
    // The click gave the sidebar the keyboard: t switches both ways.
    await rig.send('t');
    await waitFor(() => posts(rig), text => /● Live/.test(text), {label: 't opens Team'});
    await rig.send('t');
    await waitFor(() => rig.screen(), text => hasCard(text) && !/● Live/.test(posts(rig)), {label: 't opens Tasks'});
    await rig.send('t');
    await waitFor(() => posts(rig), text => /● Live/.test(text), {label: 'Team again'});
    // Ctrl+B hides it (the keyboard is in it), Ctrl+B shows it again on the tab it was on.
    await rig.send('\x02');
    await waitFor(() => posts(rig), text => !/● Live/.test(text), {label: 'hidden'});
    await rig.send('\x02');
    await waitFor(() => posts(rig), text => /Tasks {2}Team +● Live/.test(text), {label: 'shown on Team'});
  } finally {if (rig) await unmount(rig); await f.close();}
});

test('/team opens the sidebar on Team (a second /team hides it), works with no task graph, and /tasks still needs one; the catalog and help list it', {timeout: 60000}, async () => {
  const f = await fixture(); let rig!: Rig;
  try {
    const app = await f.open();
    app.store.message(app.sessionId, 'logox', 'user', 'Hello team', {inputKind: 'human', source: 'direct'});
    rig = await mount(app, 120, 32);
    await waitFor(() => rig.screen(), text => text.includes('Ready when you are.'), {label: 'mounted'});
    assert.ok(!/Tasks {2}Team/.test(posts(rig)), 'nothing opens by itself');
    await act(async () => {await app.submit('/tasks');});
    await waitFor(() => rig.screen(), text => /Nothing has been planned or delegated/.test(text), {label: '/tasks needs a task graph'});
    await act(async () => {await app.submit('/team');});
    await waitFor(() => posts(rig), text => /Tasks {2}Team +● Live/.test(text) && text.includes('✓ you → @logox'), {label: '/team shows the feed'});
    await act(async () => {await app.submit('/team');});
    await waitFor(() => posts(rig), text => !/● Live/.test(text), {label: 'a second /team hides it'});
    await act(async () => {await app.submit('/team show');});
    await waitFor(() => posts(rig), text => /● Live/.test(text), {label: '/team show'});
    await act(async () => {await app.submit('/team hide');});
    await waitFor(() => posts(rig), text => !/● Live/.test(text), {label: '/team hide'});
    await assert.rejects(app.submit('/team sideways'), /Usage: \/team/);
    assert.ok(commandCatalog.some(command => command.name === 'team'));
    assert.match(commandHelp(), /\/team \[show\|hide\|toggle\]: Team feed sidebar/);
  } finally {if (rig) await unmount(rig); await f.close();}
});

test('/team on an empty session shows the empty feed with a hint instead of nothing', {timeout: 30000}, async () => {
  const f = await fixture(); let rig!: Rig;
  try {
    const app = await f.open();
    rig = await mount(app, 120, 32);
    await waitFor(() => rig.screen(), text => text.includes('Ready when you are.'), {label: 'mounted'});
    await act(async () => {await app.submit('/team');});
    await waitFor(() => posts(rig), text => text.includes('No team activity yet') && /0 \/ 0/.test(text), {label: 'the empty feed'});
  } finally {if (rig) await unmount(rig); await f.close();}
});

test('a click selects a post, a double click or Enter opens it (the message as Markdown, work as the delegation detail), a name filters and the footer picks members', {timeout: 60000}, async () => {
  const f = await fixture(); let rig!: Rig;
  try {
    const app = await f.open();
    seed(app);
    rig = await mount(app, 120, 34);
    await act(async () => {await app.submit('/team');});
    await waitFor(() => posts(rig), text => /● Live/.test(text) && text.includes('Renamed to buildStreetProps()'), {label: 'the feed'});
    // Double click on the message post: its full text as Markdown.
    const body = feed(rig, 'Renamed to');
    await rig.click(body.x + 2, body.y);
    assert.equal(surface(app), null, 'one click only selects');
    assert.match(posts(rig), /○ Live/);
    await rig.click(body.x + 2, body.y);
    await waitFor(() => surface(app)?.kind, kind => kind === 'result', {label: 'the detail page'});
    const page = surface(app) as Extract<CommandSurface, {kind: 'result'}>;
    assert.equal(page.markdown, true);
    assert.match(page.title, /^Team · rename call/);
    assert.ok(page.text.includes('**techne**') && page.text.includes('Renamed to buildStreetProps()') && page.text.includes('**Update** your calls.'));
    await waitFor(() => rig.screen(), text => text.includes('Update') && !text.includes('**Update**'), {label: 'the page lays the text out as Markdown'});
    app.surfaces.cancel();
    await waitFor(() => surface(app), current => current === null, {label: 'closed'});
    // The assignment post opens the delegation detail of the work.
    const assign = feed(rig, 'Draw the SVG');
    await rig.click(assign.x + 2, assign.y); await rig.click(assign.x + 2, assign.y);
    await waitFor(() => surface(app)?.kind, kind => kind === 'page', {label: 'the delegation detail'});
    assert.match((surface(app) as Extract<CommandSurface, {kind: 'page'}>).title, /^Delegation · Draw the SVG/);
    app.surfaces.cancel();
    await waitFor(() => surface(app), current => current === null, {label: 'closed'});
    // The keyboard: focus the sidebar, Home selects the first post, Enter opens it (the person's own words).
    await focusSidebar(rig);
    await rig.send('\x1b[H');
    await rig.send('\r');
    await waitFor(() => surface(app)?.kind, kind => kind === 'result', {label: 'Enter opens the selected post'});
    assert.match((surface(app) as Extract<CommandSurface, {kind: 'result'}>).text, /Draw the pelican/);
    app.surfaces.cancel();
    await waitFor(() => surface(app), current => current === null, {label: 'closed'});
    // A click on a name filters to that member; the footer shows it and says how many posts.
    const name = feed(rig, '@kalon');
    await rig.click(name.x + 1, name.y);
    await waitFor(() => posts(rig), text => /kalon ▾/.test(text) && !text.includes('✓ you → @logox'), {label: 'filtered to kalon'});
    // The footer opens the picker; choosing All members clears the filter.
    await rig.clickText('kalon ▾');
    await waitFor(() => posts(rig), text => text.includes('─ Members') && text.includes('All members'), {label: 'the member picker'});
    await rig.clickText('All members');
    await waitFor(() => posts(rig), text => /all members ▾/.test(text) && text.includes('✓ you → @logox') && !text.includes('─ Members'), {label: 'all members again'});
  } finally {if (rig) await unmount(rig); await f.close();}
});

test('◀ ▶ and the wheel leave Live, ● Live returns and follows the newest post; new posts append at the tail while Live and never move a view that left it', {timeout: 60000}, async () => {
  const f = await fixture(); let rig!: Rig;
  try {
    const app = await f.open();
    seed(app);
    const say = (text: string) => app.store.message(app.sessionId, 'kalon', 'user', '[Message from techne · note]\n' + text, {activityId: 'kal', inputKind: 'collaboration', source: 'techne'});
    for (let n = 0; n < 24; n++) say('earlier note ' + n);
    rig = await mount(app, 120, 30);
    await act(async () => {await app.submit('/team');});
    await waitFor(() => posts(rig), text => /● Live/.test(text) && text.includes('earlier note 23'), {label: 'the tail is visible while Live'});
    assert.ok(!posts(rig).includes('earlier note 0'), 'the early posts are scrolled away');
    await act(async () => {say('fresh note 1');});
    await waitFor(() => posts(rig), text => text.includes('fresh note 1') && /● Live/.test(text) && /28\/28/.test(text), {label: 'a new post follows the tail'});
    // The wheel moves the selection by one post and leaves Live.
    const at = rig.find('fresh note 1');
    await rig.mouse('wheel_up', at.x + 3, at.y);
    await waitFor(() => posts(rig), text => /○ Live/.test(text) && /27\/28/.test(text), {label: 'the wheel leaves Live'});
    for (let n = 0; n < 6; n++) await rig.mouse('wheel_up', at.x + 3, at.y);
    await waitFor(() => posts(rig), text => /21\/28/.test(text), {label: 'it keeps stepping'});
    await act(async () => {say('fresh note 2');});
    await waitFor(() => posts(rig), text => /21\/29/.test(text), {label: 'the total grows, the selection stays'});
    assert.ok(!posts(rig).includes('fresh note 2') && /○ Live/.test(posts(rig)), 'a view that left Live is not moved');
    // ◀ and ▶ are buttons.
    const arrows = rig.find('◀ ▶');
    await rig.click(arrows.x, arrows.y);
    await waitFor(() => posts(rig), text => /20\/29/.test(text), {label: '◀ steps back'});
    await rig.click(arrows.x + 2, arrows.y);
    await waitFor(() => posts(rig), text => /21\/29/.test(text), {label: '▶ steps forward'});
    // Live returns to the newest post.
    await rig.clickText('○ Live', 2);
    await waitFor(() => posts(rig), text => /● Live/.test(text) && text.includes('fresh note 2') && /29\/29/.test(text), {label: 'Live follows the tail again'});
    // End from the keyboard does the same.
    await rig.mouse('wheel_up', at.x + 3, at.y);
    await waitFor(() => posts(rig), text => /○ Live/.test(text), {label: 'left again'});
    await focusSidebar(rig);
    await rig.send('\x1b[F');
    await waitFor(() => posts(rig), text => /● Live/.test(text), {label: 'End returns to Live'});
  } finally {if (rig) await unmount(rig); await f.close();}
});

test('the stage above the feed: its cards filter by click and open the actor page by double click, Play replays the posts one by one and ends on Live', {timeout: 60000}, async () => {
  const f = await fixture(); let rig!: Rig;
  try {
    const app = await f.open();
    seed(app);
    rig = await mount(app, 120, 40);
    await act(async () => {await app.submit('/team');});
    await waitFor(() => posts(rig), text => /● Live/.test(text) && text.includes('Kalon') && text.includes('Techne') && text.includes('▶ Play'), {label: 'the stage'});
    // A click on the Kalon card filters the feed to Kalon; a second click on it (same card, slowly) clears the filter.
    const kalon = rig.find('Kalon');
    await rig.click(kalon.x + 1, kalon.y);
    await waitFor(() => posts(rig), text => /kalon ▾/.test(text) && !text.includes('✓ you → @logox'), {label: 'filtered to kalon by the card'});
    await delay(450);
    await rig.click(kalon.x + 1, kalon.y);
    await waitFor(() => posts(rig), text => /all members ▾/.test(text), {label: 'the card clears the filter again'});
    // A double click opens the actor page: state, workers, messages and the jump to its window.
    await rig.click(kalon.x + 1, kalon.y); await rig.click(kalon.x + 1, kalon.y);
    await waitFor(() => surface(app)?.kind, kind => kind === 'page', {label: 'the actor page'});
    const page = surface(app) as Extract<CommandSurface, {kind: 'page'}>;
    assert.match(page.title, /^Team · /);
    assert.deepEqual(page.tabs[0]!.actions?.map(action => action.key), ['o']);
    assert.match(JSON.stringify(page.tabs[0]), /Workers/);
    assert.match(JSON.stringify(page.tabs[0]), /techne/);
    app.surfaces.cancel();
    await waitFor(() => surface(app), current => current === null, {label: 'closed'});
    // Play restarts from the first post and ends on Live; the button says Pause meanwhile.
    const play = rig.find('▶ Play');
    await rig.click(play.x + 2, play.y);
    await waitFor(() => posts(rig), text => text.includes('❚❚ Pause') && /1\/3/.test(text) && /○ Live/.test(text), {label: 'playing from the first post'});
    await waitFor(() => posts(rig), text => /● Live/.test(text) && text.includes('▶ Play') && /3\/3/.test(text), {label: 'the end switches to Live', timeoutMs: 8000});
    // The speed control cycles.
    const speed = rig.find('1×');
    await rig.click(speed.x, speed.y);
    await waitFor(() => posts(rig), text => text.includes('2×'), {label: 'speed 2x'});
    // Space plays and pauses from the keyboard.
    await focusSidebar(rig);
    await rig.send(' ');
    await waitFor(() => posts(rig), text => text.includes('❚❚ Pause'), {label: 'space plays'});
    await rig.send(' ');
    await waitFor(() => posts(rig), text => text.includes('▶ Play'), {label: 'space pauses'});
  } finally {if (rig) await unmount(rig); await f.close();}
});

test('the Team layout is rebuilt only when the events, the width or the filter change, never for an unrelated store change', {timeout: 60000}, async () => {
  const f = await fixture(); let rig!: Rig;
  try {
    const app = await f.open();
    seed(app);
    rig = await mount(app, 120, 34);
    await act(async () => {await app.submit('/team');});
    await waitFor(() => posts(rig), text => /● Live/.test(text), {label: 'the feed'});
    const builds = teamStats.builds;
    await act(async () => {app.store.message(app.sessionId, 'logox', 'assistant', 'TIMELINE chatter that is no team event');});
    await waitFor(() => rig.screen(), text => text.includes('TIMELINE chatter'), {label: 'an unrelated change rendered'});
    await rig.mouse('move', rig.sidebarX + 10, 8);
    await rig.mouse('move', rig.sidebarX + 12, 9);
    assert.equal(teamStats.builds, builds, 'no rebuild for an unrelated store change or the pointer');
    await act(async () => {app.store.message(app.sessionId, 'kalon', 'user', '[Message from techne · n]\nOne more post', {activityId: 'kal', inputKind: 'collaboration', source: 'techne'});});
    await waitFor(() => posts(rig), text => text.includes('One more post'), {label: 'a new event'});
    assert.ok(teamStats.builds > builds);
  } finally {if (rig) await unmount(rig); await f.close();}
});
