import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PassThrough} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {act, type ReactElement} from 'react';
import {RuntimeStore} from '../src/runtime/store.js';
import {NoticeBoard, mainAction, type NoticeTone, pendingNotices, persistentNotices, type NoticeInput, type PersistentNotice} from '../src/runtime/notices.js';
import {Journal} from '../src/store/journal.js';
import {createNotices} from '../src/app/notices.js';
import {CommandSurfaces} from '../src/commands/surfaces.js';
import {commandCatalog} from '../src/commands.js';
import {App, type AppProps} from '../src/tui/app.js';
import {renderTerminal} from '../src/tui/terminal/terminal.js';
import {MouseHost, type SgrMouseEvent} from '../src/tui/terminal/mouse.js';
import {SettingsPage} from '../src/tui/panels/settings-page.js';
import {settingsLayout} from '../src/tui/panels/settings-layout.js';
import {noticeRow, clipWords} from '../src/tui/status/notice-line.js';
import {TerminalScreen} from './terminal-screen.js';
import {settingsFixture} from './settings-fixture.js';
import type {StageStatus} from '../src/runtime/stage-status.js';

Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
class Input extends PassThrough {
  isTTY = true; setRawMode(): this {return this;} ref(): this {return this;} unref(): this {return this;}
}
const status = (ownerId: string): StageStatus => ({ownerId, name: ownerId === 'logox' ? 'Logox' : ownerId, state: 'Running', color: '#7a9ee0',
  model: {provider: 'anthropic', model: 'claude-opus-5-5'}, effort: 'high', permission: 'auto',
  modelInfo: {window: 200000, maxOutput: 64000}, context: {tokens: 121300, window: 200000, high: 168000, estimated: false, over: false,
    categories: {system: 9200, prompt: 6400, assistant: 26000, thinking: 7700, tools: 72000}},
  usage: {window: {input: 100, output: 50, cached: 900}, session: {input: 100, output: 50, cached: 900}}});
const flat = (line: string) => line.trimEnd();

const permission = (store: RuntimeStore, ownerId = 'techne', tool = 'Shell') => store.interactions.open({kind: 'permission', sessionId: 's', activityId: 'a-' + ownerId, ownerId,
  title: 'Allow ' + tool + '?', tool, arguments: {command: 'ls'}, reason: 'lists files', mode: 'auto', suggestion: {tool, pattern: 'ls', label: 'ls *'}});
const question = (store: RuntimeStore, ownerId = 'kalon') => store.interactions.open({kind: 'question', sessionId: 's', activityId: 'q-' + ownerId, ownerId, title: 'Pick a palette',
  questions: [{id: 'q1', header: 'Palette', question: 'Which palette?', options: [{id: 'a', label: 'Warm', description: ''}, {id: 'b', label: 'Cool', description: ''}]}]});
const read = (text: string, parts: NoticeInput['parts'] = [], tone: NoticeTone = 'info'): NoticeInput =>
  ({kind: 'read', tone, parts: [{text}, ...parts]});
const asModel = {text: 'recap', action: {kind: 'command' as const, name: 'anamnesis'}};

async function mount(extra: Partial<AppProps> = {}, rows = 24, columns = 100) {
  const input = new Input(), output = new TerminalScreen(), submitted: string[] = [];
  const store = new RuntimeStore(), board = new NoticeBoard('s'), surfaces = new CommandSurfaces(() => {});
  output.columns = columns; output.rows = rows;
  let instance!: ReturnType<typeof renderTerminal>;
  await act(async () => {
    instance = renderTerminal(<App store={store} sessionId="s" stage getStatus={status} notices={board} surfaces={surfaces} onSubmit={async text => {submitted.push(text);}}
      onCancel={() => {}} onClose={async () => {}} {...extra}/>, {stdin: input, stdout: output, stderr: output, interactive: true,
      alternateScreen: true, patchConsole: false, exitOnCtrlC: false, maxFps: 100});
  });
  const flush = async () => {await act(async () => {await instance.waitUntilRenderFlush();});};
  const change = async (fn: () => void) => {await act(async () => fn()); await flush();};
  const mouse = async (x: number, y: number, code = 35, end = 'M') => {await act(async () => {input.write(`\x1b[<${code};${x};${y}${end}`); await delay(30);}); await flush();};
  /** A press and release at 0-based screen cell (x, y). */
  const click = async (x: number, y: number) => {await mouse(x + 1, y + 1, 0, 'M'); await mouse(x + 1, y + 1, 0, 'm');};
  const post = async (input: NoticeInput) => {let id = ''; await act(async () => {id = board.postNotice(input);}); await flush(); return id;};
  const open = async <T,>(make: () => T): Promise<T> => {let value!: T; await act(async () => {value = make();}); await flush(); return value;};
  const respond = async (raw: unknown) => {await act(async () => {store.interactions.respond(raw);}); await flush();};
  const key = async (value: string) => {await act(async () => {input.write(value); await delay(value === '\x1b' ? 40 : 20);}); await flush();};
  await flush();
  const lines = () => output.lines;
  const note = () => flat(output.lines[rows - 1]!);
  const close = async () => {await act(async () => {surfaces.close(); store.interactions.close(); instance.unmount();}); await instance.waitUntilExit(); input.destroy(); output.destroy();};
  return {store, board, surfaces, submitted, lines, note, flush, change, post, open, respond, mouse, click, key, close, output, screen: () => output.lines.join('\n')};
}
/** 0-based column of `needle` in `line`, in cells. */
const cellOf = (line: string, needle: string) => [...line.slice(0, line.indexOf(needle))].length;

test('a pending notice shows for every open approval and question and goes when it is answered', {timeout: 15000}, async () => {
  const f = await mount();
  try {
    assert.match(f.note(), /Enter send/);
    const approval = await f.open(() => permission(f.store, 'techne'));
    await f.flush();
    assert.match(f.note(), /▲ Techne awaits approval · Shell/);
    const asked = await f.open(() => question(f.store, 'kalon'));
    await f.flush();
    assert.match(f.note(), /Kalon asks you · Pick a palette/, 'the newest pending notice leads');
    assert.match(f.note(), /\+1$/, 'the other one is a badge');
    assert.doesNotMatch(f.note(), /×/, 'a pending notice cannot be dismissed by hand');
    const open = f.store.getSnapshot().interactions;
    const reply = open.find(item => item.kind === 'permission')!;
    await f.respond({kind: 'permission', requestId: reply.requestId, sessionId: 's', activityId: reply.activityId, ownerId: reply.ownerId, decision: 'allow_once'});
    await f.flush();
    assert.match(f.note(), /Kalon asks you/); assert.doesNotMatch(f.note(), /\+1/);
    const q = f.store.getSnapshot().interactions.find(item => item.kind === 'question')!;
    await f.respond({kind: 'question', requestId: q.requestId, sessionId: 's', activityId: q.activityId, ownerId: q.ownerId, answers: {q1: {type: 'option', optionId: 'a'}}});
    await f.flush();
    assert.match(f.note(), /Enter send/, 'both answered: the key hints are back');
    assert.equal((await approval.result).status, 'answered'); assert.equal((await asked.result).status, 'answered');
  } finally {await f.close();}
});

test('a click on a pending notice from another window opens the Director window, focuses the approval and a key answers it', {timeout: 15000}, async () => {
  const f = await mount();
  try {
    await f.change(() => f.surfaces.requestWindow('techne'));
    const ticket = await f.open(() => permission(f.store, 'kalon'));
    await f.flush();
    assert.match(f.note(), /Kalon awaits approval · Shell/, 'the notice belongs to the session, not to the Techne window');
    await f.click(cellOf(f.note(), 'Kalon') + 1, 23);
    await f.flush();
    assert.match(f.screen(), /Awaiting approval/);
    await f.key('y');
    const outcome = await Promise.race([ticket.result, delay(1500).then(() => undefined)]);
    assert.ok(outcome?.status === 'answered' && outcome.response.kind === 'permission' && outcome.response.decision === 'allow_once', 'the click focused the card: y allowed it once');
  } finally {await f.close();}
});

test('a read notice survives a window switch, `×` dismisses it and the footer goes back to the hints', {timeout: 15000}, async () => {
  const f = await mount();
  try {
    await f.post(read('Harvested 23:39', [asModel], 'success'));
    await f.flush();
    assert.match(f.note(), /^✓ Harvested 23:39 · recap\s+×$/);
    await f.change(() => f.surfaces.requestWindow('techne'));
    assert.match(f.note(), /Harvested 23:39 · recap/, 'switching windows does not clear a persistent notice');
    await f.change(() => f.surfaces.requestWindow('logox'));
    await f.click(f.note().length - 1, 23);
    assert.equal(f.board.getSnapshot().length, 0);
    assert.match(f.note(), /Enter send/);
  } finally {await f.close();}
});

test('a flash and a hover detail only cover the persistent notice, which comes back', {timeout: 20000}, async () => {
  const f = await mount({}, 24, 140);
  try {
    await f.post(read('Harvested 23:39', [asModel]));
    await f.flush();
    await f.change(() => f.store.system({id: randomUUID(), sessionId: 's', ownerId: 'logox', time: Date.now(), text: 'Settings saved', presentation: 'status'}));
    assert.match(f.note(), /Settings saved/); assert.doesNotMatch(f.note(), /Harvested/);
    await delay(3700); await f.flush();
    assert.match(f.note(), /Harvested 23:39/, 'the flash expired');
    const at = cellOf(f.lines()[22]!, 'claude-opus-5-5') + 2;
    await f.mouse(at, 23);
    assert.match(f.note(), /claude-opus-5-5.*window 200k/); assert.doesNotMatch(f.note(), /Harvested/);
    await f.mouse(2, 5);
    assert.match(f.note(), /Harvested 23:39/, 'the hover ended');
  } finally {await f.close();}
});

test('a part with an action runs it: a command, a result page, a jump to a card that is gone', {timeout: 15000}, async () => {
  const f = await mount();
  try {
    await f.post(read('Harvested', [asModel, {text: '2 memories', action: {kind: 'open-page', title: 'Memory changes', text: '# Created\n- one\n- two', markdown: true}},
      {text: 'ghost', action: {kind: 'jump-activity', activityId: 'nope'}}]));
    await f.flush();
    await f.click(cellOf(f.note(), 'recap') + 1, 23);
    assert.deepEqual(f.submitted, ['/anamnesis']);
    await f.click(cellOf(f.note(), '2 memories') + 1, 23);
    assert.equal(f.surfaces.getSnapshot()?.kind, 'result');
    assert.equal(f.surfaces.getSnapshot()?.title, 'Memory changes');
    await f.change(() => f.surfaces.cancel());
    await f.click(cellOf(f.note(), 'ghost') + 1, 23);
    assert.match(f.note(), /no longer in the timeline/);
    assert.equal(f.board.getSnapshot().length, 1, 'running an action never dismisses');
  } finally {await f.close();}
});

test('hovering a part or the `×` recolours it, the `×` in the error colour', {timeout: 15000}, async () => {
  const pending = noticeRow({top: {id: 'r', kind: 'read', sessionId: 's', at: 1, tone: 'info', parts: [{text: 'Done'}, {text: 'recap', action: {kind: 'command', name: 'anamnesis'}}]}, total: 1, width: 60, hoverColor: '#123456'});
  const hot = noticeRow({top: {id: 'r', kind: 'read', sessionId: 's', at: 1, tone: 'info', parts: [{text: 'Done'}, {text: 'recap', action: {kind: 'command', name: 'anamnesis'}}]}, total: 1, width: 60, hoverColor: '#123456', hovered: 'part:1'});
  const cross = noticeRow({top: {id: 'r', kind: 'read', sessionId: 's', at: 1, tone: 'info', parts: [{text: 'Done'}]}, total: 1, width: 60, hoverColor: '#123456', hovered: 'dismiss'});
  assert.notEqual(pending.segments.find(s => s.text === 'recap')!.color, '#123456');
  assert.equal(hot.segments.find(s => s.text === 'recap')!.color, '#123456');
  const {palette} = await import('../src/tui/appearance/theme.js');
  assert.equal(cross.segments.find(s => s.text === '×')!.color, palette.error);
});

test('the +N badge opens the Notices page: pending first, keyboard and mouse run the same commands', {timeout: 30000}, async () => {
  const f = await mount();
  try {
    await f.post(read('First notice', [asModel]));
    await delay(3); await f.post(read('Second notice', [{text: 'open', action: {kind: 'open-page', title: 'Changes', text: 'body'}}]));
    await f.flush();
    assert.match(f.note(), /Second notice · open\s+\+1 ×$/, 'newest first, with a badge for the rest');
    const ticket = await f.open(() => permission(f.store, 'techne'));
    await f.flush();
    assert.match(f.note(), /Techne awaits approval · Shell\s+\+2$/);
    await f.click(f.note().length - 2, 23);
    assert.equal(f.surfaces.getSnapshot()?.kind, 'notices');
    let text = f.screen();
    assert.ok(text.indexOf('Needs you') < text.indexOf('Techne awaits approval') && text.indexOf('Techne awaits approval') < text.indexOf('Kept until dismissed'), 'pending first');
    assert.ok(text.indexOf('Second notice') < text.indexOf('First notice'), 'newest first within a kind');
    assert.match(f.lines().find(line => line.includes('Techne awaits'))!, /^ +❯ ▲ Techne awaits approval/, 'the first row is selected');
    // Keyboard: down to the second notice, d dismisses it, D dismisses the rest, Esc leaves.
    await f.key('\x1b[B');
    assert.match(f.lines().find(line => line.includes('Second notice'))!, /❯/);
    await f.key('d');
    assert.equal(f.board.getSnapshot().length, 1); assert.doesNotMatch(f.screen(), /Second notice/);
    await f.key('\x1b[A'); await f.key('d');
    assert.equal(f.board.getSnapshot().length, 1, 'd on a pending notice dismisses nothing');
    await f.key('D');
    assert.equal(f.board.getSnapshot().length, 0); assert.match(f.screen(), /Techne awaits approval/);
    await f.key('\x1b');
    assert.equal(f.surfaces.getSnapshot(), null);
    // Enter on the pending notice closes the page and focuses the approval.
    await f.change(() => f.surfaces.openNotices());
    await f.flush();
    await f.key('\r');
    assert.equal(f.surfaces.getSnapshot(), null);
    await f.key('y');
    const outcome = await Promise.race([ticket.result, delay(1500).then(() => undefined)]);
    assert.ok(outcome?.status === 'answered', 'Enter jumped to the approval and y allowed it');
  } finally {await f.close();}
});

test('Notices page mouse: click runs a part, `×` dismisses, the footer label dismisses all, the wheel moves the selection', {timeout: 30000}, async () => {
  const f = await mount();
  try {
    await f.post(read('Older', [asModel]));
    await delay(3); await f.post(read('Newer', [{text: 'show', action: {kind: 'open-page', title: 'Shown', text: 'x'}}]));
    await delay(3); await f.post(read('Newest'));
    await f.change(() => f.surfaces.openNotices()); await f.flush();
    const row = (needle: string) => f.lines().findIndex(line => line.includes(needle));
    // Wheel down moves the selection from the first notice to the second.
    await f.mouse(10, row('Newer') + 1, 65);
    assert.match(f.lines()[row('Newer')]!, /❯/);
    // `×` on the Newest row.
    const newest = row('Newest');
    await f.click(f.lines()[newest]!.trimEnd().length - 1, newest);
    assert.deepEqual(f.board.getSnapshot().map(item => item.parts[0]!.text), ['Newer', 'Older']);
    // A click on a part closes the page and runs its action.
    await f.click(cellOf(f.lines()[row('Older')]!, 'recap') + 1, row('Older'));
    assert.equal(f.surfaces.getSnapshot(), null); assert.deepEqual(f.submitted, ['/anamnesis']);
    await f.change(() => f.surfaces.openNotices()); await f.flush();
    const footer = f.lines().length - 2;
    assert.match(f.lines()[footer]!, /D Dismiss all/);
    await f.click(cellOf(f.lines()[footer]!, 'D Dismiss all') + 1, footer);
    assert.equal(f.board.getSnapshot().length, 0);
    assert.match(f.screen(), /No notices/);
  } finally {await f.close();}
});

test('/notices is a catalog command and opens the page', {timeout: 15000}, async () => {
  assert.ok(commandCatalog.some(command => command.name === 'notices'));
  const f = await mount();
  try {
    await f.change(() => f.surfaces.openNotices()); await f.flush();
    assert.match(f.screen(), /Notices/); assert.match(f.screen(), /No notices/);
    await f.key('\x1b');
    assert.equal(f.surfaces.getSnapshot(), null);
  } finally {await f.close();}
});

test('a one-row footer (under 8 rows) keeps today\'s behaviour and shows no persistent notice', {timeout: 15000}, async () => {
  const f = await mount({}, 6);
  try {
    await f.post(read('Harvested 23:39'));
    await f.change(() => {permission(f.store, 'techne');});
    assert.doesNotMatch(f.screen(), /Harvested|awaits approval/);
  } finally {await f.close();}
});

test('read notices are saved with the session and come back after a reload; dismissals are saved too', {timeout: 15000}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-notices-'));
  try {
    const first = await createNotices({session: 's1', journal: new Journal(root), notice: () => {}});
    first.board.postNotice(read('Harvested 23:39', [asModel, {text: 'open', action: {kind: 'open-page', title: 'T', text: 'body', markdown: true}}], 'success'));
    first.board.postNotice({...read('Other'), id: 'fixed'});
    first.board.postNotice({...read('Other, replaced'), id: 'fixed'});
    await first.tail();
    const stored = JSON.parse(await readFile(join(root, 's1', 'notices.json'), 'utf8')) as {id: string}[];
    assert.equal(stored.length, 2, 'the same id replaces');
    const second = await createNotices({session: 's1', journal: new Journal(root), notice: () => {}});
    assert.deepEqual(second.board.getSnapshot(), first.board.getSnapshot());
    assert.equal(second.board.getSnapshot()[0]!.parts[0]!.text, 'Other, replaced');
    second.board.dismiss('fixed');
    await second.tail();
    const third = await createNotices({session: 's1', journal: new Journal(root), notice: () => {}});
    assert.deepEqual(third.board.getSnapshot().map(item => item.parts[0]!.text), ['Harvested 23:39']);
    const elsewhere = await createNotices({session: 's2', journal: new Journal(root), notice: () => {}});
    assert.equal(elsewhere.board.getSnapshot().length, 0, 'notices belong to their session');
    assert.equal(third.board.dismissAll(), 1);
    await third.tail();
    assert.equal((await createNotices({session: 's1', journal: new Journal(root), notice: () => {}})).board.getSnapshot().length, 0);
  } finally {await rm(root, {recursive: true, force: true});}
});

test('pending notices are derived: an Anamnesis run that cannot use its model stays until the failed card is gone', () => {
  const store = new RuntimeStore();
  store.activities.create({sessionId: 's', activityId: 'dream', ownerId: 'anamnesis', kind: 'anamnesis', title: 'Anamnesis', status: 'failed', stage: 'Recap failed',
    detail: 'Anamnesis has no usable model (openai/gpt-x). Choose one under /anamnesis.', createdAt: 5} as never);
  const list = pendingNotices(store.getSnapshot(), 's');
  assert.equal(list.length, 1);
  assert.equal(list[0]!.tone, 'error');
  assert.match(list[0]!.parts[0]!.text, /Anamnesis has no usable model \(openai\/gpt-x\)/);
  assert.deepEqual(mainAction(list[0]!), {kind: 'command', name: 'anamnesis'});
  assert.equal(pendingNotices(store.getSnapshot(), 'other').length, 0, 'another session has none');
  store.activities.remove('s', 'dream');
  assert.equal(pendingNotices(store.getSnapshot(), 's').length, 0);
  store.activities.create({sessionId: 's', activityId: 'dream2', ownerId: 'anamnesis', kind: 'anamnesis', title: 'Anamnesis', status: 'failed', stage: 'Recap failed', detail: 'Provider returned 500', createdAt: 6} as never);
  assert.equal(pendingNotices(store.getSnapshot(), 's').length, 0, 'other failures stay on the card');
  const board = new NoticeBoard('s'); board.postNotice(read('Kept'));
  const ticket = permission(store); void ticket;
  const all: readonly PersistentNotice[] = persistentNotices(board.getSnapshot(), store.getSnapshot(), 's');
  assert.deepEqual(all.map(item => item.kind), ['pending', 'read']);
  store.interactions.close();
});

test('the notice row never clips mid-word: parts drop from the right, the badge and `×` stay', () => {
  const top: PersistentNotice = {id: 'h', kind: 'read', sessionId: 's', at: 1, tone: 'success', parts: [{text: 'Harvested 23:39'},
    {text: 'recap', action: {kind: 'jump-activity', activityId: 'a'}}, {text: '2 memories', action: {kind: 'open-page', title: 'm', text: 't'}}, {text: '1 skill'},
    {text: 'compacted 52% → 21%'}, {text: 'Keep full context', button: true, action: {kind: 'command', name: 'compact'}}]};
  const wide = noticeRow({top, total: 3, width: 110, hoverColor: '#fff'});
  const line = wide.segments.map(segment => segment.text).join('');
  assert.equal([...line].length, 110);
  assert.match(line, /^✓ Harvested 23:39 · recap · 2 memories · 1 skill · compacted 52% → 21%  \[Keep full context\]\s+\+2 ×$/);
  assert.deepEqual(wide.regions.map(region => region.id), ['part:1', 'part:2', 'part:5', 'badge', 'dismiss']);
  for (const region of wide.regions) assert.ok(line.slice(0).length >= region.x1);
  assert.equal([...line].slice(wide.regions.find(region => region.id === 'dismiss')!.x0)[0], '×');
  assert.deepEqual(wide.effect('badge'), {kind: 'notices'}); assert.deepEqual(wide.effect('dismiss'), {kind: 'dismiss'});
  assert.deepEqual(wide.effect('part:5'), {kind: 'action', action: {kind: 'command', name: 'compact'}});
  const parts = ['Harvested 23:39', 'recap', '2 memories', '1 skill', 'compacted 52% → 21%', '[Keep full context]'];
  for (let width = 110; width >= 24; width--) {
    const row = noticeRow({top, total: 3, width, hoverColor: '#fff'});
    const text = row.segments.map(segment => segment.text).join('');
    assert.ok([...text].length <= width, width + ': fits');
    assert.match(text, /\+2 ×$/, width + ': badge and × stay');
    const body = text.replace(/\s+\+2 ×$/, '').replace(/^✓ /, '');
    const shown = body.split(/ · |  /);
    shown.forEach((piece, index) => assert.ok(parts[index] === piece || (index === 0 && piece.endsWith('…') && parts[0]!.startsWith(piece.slice(0, -1))), width + ': "' + piece + '" is a whole part'));
  }
  const tiny = noticeRow({top, total: 3, width: 20, hoverColor: '#fff'}).segments.map(segment => segment.text).join('');
  assert.match(tiny, /^✓ Harvested…\s+\+2 ×$/);
  assert.equal(clipWords('one two three', 8), 'one two…'); assert.equal(clipWords('abcdefghij', 5), 'abcd…'); assert.equal(clipWords('abc', 0), '');
});

test('/settings shows the description of the hovered row, and the selected row\'s again when a key is pressed or the pointer leaves', async () => {
  const f = await settingsFixture();
  try {
    const items = f.items(), pages = f.pages;
    const plan = (pointer: {x: number; y: number} | null, extra = {}) => settingsLayout({items, pages, view: {drafts: {}, query: '', searching: false, selected: 0, scroll: 0, confirming: false, saving: false, error: '', notice: '', ...extra},
      width: 100, height: 30, y: 0, pointer, hoverColor: '#fff'});
    const text = (layout: ReturnType<typeof plan>) => layout.rows.slice(-2).map(row => row.map(seg => seg.text).join('').trim()).join(' ').trim();
    const base = plan(null);
    const selectedDescription = text(base);
    assert.ok(selectedDescription.length > 0);
    const second = base.entries[2]!;
    // Find the screen row of the third entry: list rows start under the frame rows.
    let hoverRow = -1;
    for (let y = 2; y < 30; y++) {
      const probe = plan({x: 5, y});
      if (text(probe) === second.description.slice(0, text(probe).length) && text(probe) !== selectedDescription) {hoverRow = y; break;}
    }
    assert.ok(hoverRow > 0, 'hovering some row shows its own description');
    assert.equal(text(plan({x: 5, y: hoverRow})).startsWith(second.description.slice(0, 20)), true);
    assert.equal(text(plan({x: 5, y: hoverRow}, {hoverMuted: {x: 5, y: hoverRow}})), selectedDescription, 'a key press mutes the hover until the pointer moves');
    assert.equal(text(plan({x: 5, y: 0})), selectedDescription, 'off the list the selected row describes itself');
  } finally {await f.close();}
});

test('/settings mounted: moving the pointer onto a row changes the description, an arrow key returns to the selected row', {timeout: 20000}, async () => {
  const f = await settingsFixture();
  const input = new Input(), output = new TerminalScreen(); output.columns = 100; output.rows = 30;
  const listeners = new Set<(event: SgrMouseEvent) => void>();
  let instance!: ReturnType<typeof renderTerminal>;
  const element: ReactElement = <MouseHost subscribe={handler => {listeners.add(handler); return () => {listeners.delete(handler);};}} color="#ff8800">
    <SettingsPage items={f.items()} pages={f.pages} width={100} height={30} onSave={() => {}} onDiscard={() => {}} onOpenPage={() => {}} onCloseSub={() => {}}/></MouseHost>;
  try {
    await act(async () => {instance = renderTerminal(element, {stdin: input, stdout: output, stderr: output, interactive: true, alternateScreen: true, patchConsole: false, exitOnCtrlC: false, maxFps: 100});});
    const flush = async () => {await act(async () => {await instance.waitUntilRenderFlush();});};
    const move = async (x: number, y: number) => {await act(async () => {for (const listener of listeners) listener({button: 0, x, y, action: 'move'}); await delay(5);}); await flush();};
    await flush();
    const lines = () => output.lines.map(line => line.trimEnd());
    const descriptionRows = () => lines().slice(lines().length - 6, lines().length - 3).join('\n');
    const items = f.items();
    const labelRow = (label: string) => {const at = lines().findIndex(line => line.includes(label)); assert.ok(at >= 0, label); return at;};
    const other = items.find(item => item.label !== items[0]!.label && lines().some(line => line.includes(item.label)))!;
    const before = descriptionRows();
    await move(10, labelRow(other.label));
    assert.ok(descriptionRows().replace(/\s+/g, ' ').includes(other.description.slice(0, 30)), 'the hovered row describes itself:\n' + lines().join('\n'));
    assert.notEqual(descriptionRows(), before);
    await act(async () => {input.write('\x1b[B'); await delay(20);}); await flush();
    assert.ok(!descriptionRows().replace(/\s+/g, ' ').includes(other.description.slice(0, 30)) || items[1]!.description === other.description, 'a key returns to the selected row');
    await move(0, 0);
  } finally {await act(async () => {instance?.unmount();}); await instance?.waitUntilExit(); input.destroy(); output.destroy(); await f.close();}
});
