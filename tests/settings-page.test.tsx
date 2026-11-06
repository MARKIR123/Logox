import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import chalk from 'chalk';
import {act, type ReactElement} from 'react';
import {setTimeout as delay} from 'node:timers/promises';
import {renderTerminal as render} from '../src/tui/terminal/terminal.js';
import {TerminalScreen} from './terminal-screen.js';
import {MouseHost, type SgrMouseEvent} from '../src/tui/terminal/mouse.js';
import {SettingsPage} from '../src/tui/panels/settings-page.js';
import {settingsLayout, changedDrafts, type DraftValue} from '../src/tui/panels/settings-layout.js';
import {palette} from '../src/tui/appearance/theme.js';
import type {CommandTab, SettingsItem, SettingsPageLink, SettingsSubPage} from '../src/runtime/command-surface.js';
import {settingsFixture} from './settings-fixture.js';
Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
class Input extends PassThrough {isTTY = true; setRawMode(): this {return this;} ref(): this {return this;} unref(): this {return this;}}
chalk.level = 3;
const HOVER = '#ff8800', HOVER_SGR = '38;2;255;136;0';

interface Calls {saved: Record<string, DraftValue>[]; previews: [string, DraftValue][]; discards: number; opened: string[]; closedSub: number}
interface Extra {saving?: boolean; error?: string; sub?: SettingsSubPage}
async function mount(items: SettingsItem[], pages: SettingsPageLink[], columns = 100, rows = 30, extra: Extra = {}) {
  const input = new Input(), output = new TerminalScreen(); output.columns = columns; output.rows = rows;
  const calls: Calls = {saved: [], previews: [], discards: 0, opened: [], closedSub: 0};
  const listeners = new Set<(event: SgrMouseEvent) => void>();
  let instance!: ReturnType<typeof render>;
  const element = (current: Extra): ReactElement => <MouseHost subscribe={handler => {listeners.add(handler); return () => {listeners.delete(handler);};}} color={HOVER}>
    <SettingsPage items={items} pages={pages} width={columns} height={rows} saving={current.saving ?? false} error={current.error ?? ''} sub={current.sub}
      onSave={changes => {calls.saved.push(changes);}} onPreview={(key, value) => {calls.previews.push([key, value]);}} onDiscard={() => {calls.discards++;}}
      onOpenPage={id => {calls.opened.push(id);}} onCloseSub={() => {calls.closedSub++;}}/>
  </MouseHost>;
  await act(async () => {instance = render(element(extra), {stdin: input, stdout: output, stderr: output, interactive: true, alternateScreen: true, patchConsole: false, exitOnCtrlC: false, maxFps: 100});});
  const flush = async () => {await act(async () => {await instance.waitUntilRenderFlush();});};
  const key = async (value: string) => {await act(async () => {input.write(value); await delay(value === '\x1b' ? 40 : 5);}); await flush();};
  const send = async (button: number, x: number, y: number, action: SgrMouseEvent['action']) => {
    await act(async () => {for (const listener of listeners) listener({button, x, y, action}); await delay(5);}); await flush();
  };
  await flush();
  return {key, calls, output, screen: () => output.lines.join('\n'), lines: () => output.lines,
    click: async (x: number, y: number) => {await send(0, x, y, 'press'); await send(0, x, y, 'release');},
    move: (x: number, y: number) => send(0, x, y, 'move'),
    wheel: (x: number, y: number, direction: 1 | -1) => send(0, x, y, direction > 0 ? 'wheel_down' : 'wheel_up'),
    rerender: async (next: Extra) => {await act(async () => {instance.rerender(element(next));}); await flush();},
    close: async () => {await act(async () => {instance.unmount();}); await instance.waitUntilExit(); input.destroy(); output.destroy();}};
}
const rowOf = (lines: readonly string[], text: string) => {const at = lines.findIndex(line => line.includes(text)); assert.ok(at >= 0, 'row with ' + text + '\n' + lines.join('\n')); return at;};
const stripped = (value: string) => value.trimEnd();
const width = (value: string) => [...value].length;

test('render tiers: full at 120 columns, the same plan at 80, arrows only on the selected row at 60', async () => {
  const f = await settingsFixture();
  try {
    for (const [columns, rows] of [[120, 30], [80, 26], [60, 22]] as const) {
      const ui = await mount(f.items(), f.pages, columns, rows);
      try {
        const lines = ui.lines().map(stripped);
        assert.ok(lines.every(line => width(line) <= columns), columns + ': no row is wider than the screen');
        const text = ui.screen();
        assert.match(lines[1]!, /^ {2}Settings/); assert.doesNotMatch(lines[1]!, /unsaved/);
        assert.ok(text.indexOf('Appearance') < text.indexOf('Theme') && text.indexOf('Theme') < text.indexOf('Splash') && text.indexOf('Splash') < text.indexOf('Conversation'));
        assert.match(lines[rowOf(lines, 'Theme')]!, /^ {2}❯ Theme +‹ logox-dark ›$/, columns + ': values are right-aligned with arrows on a select');
        assert.match(lines[rowOf(lines, 'Animations')]!, /\[✓\]$/, columns + ': booleans are checkboxes at the right edge');
        assert.match(lines[rowOf(lines, 'Your name')]!, /\(none\)$/, 'text rows show their value plainly');
        assert.match(text, /Colour theme; the page previews/, 'the selected row has a description');
        assert.match(lines.at(-2)!, /^ {2}↑↓ choose · ←→ change · Enter save/, 'footer hints');
        if (columns >= 70) {
          assert.match(lines[1]!, /\/ search$/, 'the search control sits at the right of the header');
          assert.match(lines[rowOf(lines, 'Cursor')]!, /‹ Block █ ›$/);
        } else {
          assert.doesNotMatch(lines[1]!, /search/, 'the header drops the search control on a narrow screen');
          assert.match(lines[rowOf(lines, 'Cursor')]!, /Block █$/); assert.doesNotMatch(lines[rowOf(lines, 'Cursor')]!, /[‹›]/, 'unselected rows lose their arrows');
        }
      } finally {await ui.close();}
    }
  } finally {await f.close();}
});

test('a tall page wraps the description onto a second row; a long list scrolls with the selection', async () => {
  const f = await settingsFixture();
  const tall = await mount(f.items(), f.pages, 60, 40);
  try {
    assert.match(tall.screen(), /Colour theme; the page previews it live and puts the old\s*\n.*one back when you discard\./);
  } finally {await tall.close();}
  const short = await mount(f.items(), f.pages, 80, 12);
  try {
    assert.doesNotMatch(short.screen(), /Pages/, 'only part of the list fits');
    await short.key('\x1b[F');
    assert.match(short.screen(), /❯ Shortcuts/, 'End selects the last row and scrolls it into view');
    assert.match(short.screen(), /Pages/);
    await short.key('\x1b[H');
    assert.match(short.screen(), /❯ Theme/);
    assert.match(short.screen(), /Appearance/, 'the group heading comes back with its first row');
  } finally {await short.close(); await f.close();}
});

test('keyboard: arrows choose and change, Space toggles, the unsaved count follows the drafts, Enter saves only what changed', async () => {
  const f = await settingsFixture();
  const ui = await mount(f.items(), f.pages);
  try {
    await ui.key('\x1b[C');
    assert.match(ui.screen(), /Settings · 1 unsaved/); assert.match(ui.screen(), /‹ claude-warm ›/);
    assert.deepEqual(ui.calls.previews, [['theme', 'claude-warm']], 'a theme draft previews live');
    await ui.key('\x1b[D'); assert.doesNotMatch(ui.screen(), /unsaved/, 'back to the saved value is no change');
    await ui.key('\x1b[D'); assert.match(ui.screen(), /‹ mist-light ›/, 'left wraps around');
    await ui.key('\x1b[B'); await ui.key(' ');
    assert.match(ui.screen(), /❯ Cursor +‹ Underline _ ›/, 'Space advances a select');
    await ui.key('\x1b[B'); await ui.key(' ');
    assert.match(ui.screen(), /❯ Animations +\[ \]/); assert.match(ui.screen(), /Settings · 3 unsaved/);
    await ui.key('\x1b[B'); await ui.key('\x1b[B'); await ui.key('\x1b[B'); await ui.key('\x1b[C'); await ui.key('\x1b[C');
    assert.match(ui.screen(), /❯ Context bar width +‹ 24 ›/, 'a number steps by 4 and stops at its maximum');
    await ui.key('\x1b[C'); assert.match(ui.screen(), /‹ 24 ›/);
    await ui.key('\r');
    assert.deepEqual(ui.calls.saved, [{theme: 'mist-light', cursor: 'Underline _', animations: false, contextBarWidth: 24}]);
    assert.equal(ui.calls.discards, 0);
  } finally {await ui.close(); await f.close();}
});

test('Enter without changes closes like a discard; Ctrl+S saves from a page row', async () => {
  const f = await settingsFixture();
  const ui = await mount(f.items(), f.pages);
  try {
    await ui.key('\r'); assert.equal(ui.calls.discards, 1); assert.deepEqual(ui.calls.saved, []);
    await ui.key('\x1b[C'); await ui.key('\x1b[F'); assert.match(ui.screen(), /Enter open · Ctrl\+S save/);
    await ui.key('\x13'); assert.equal(ui.calls.saved.length, 1);
  } finally {await ui.close(); await f.close();}
});

test('a text row edits in place: Enter starts, typing and Backspace change the draft, Enter commits, Esc cancels', async () => {
  const f = await settingsFixture();
  const ui = await mount(f.items(), f.pages);
  try {
    for (let step = 0; step < 9; step++) await ui.key('\x1b[B');
    assert.match(ui.screen(), /❯ Your name/); assert.match(ui.screen(), /Enter edit · Ctrl\+S save/);
    await ui.key('\r'); assert.match(ui.screen(), /▌/);
    await ui.key('Adx'); await ui.key('\x7f'); await ui.key('a');
    assert.match(ui.screen(), /Ada▌/);
    await ui.key('\x1b'); assert.match(ui.screen(), /\(none\)/, 'Esc drops the edit, not the page'); assert.equal(ui.calls.discards, 0);
    await ui.key('\r'); await ui.key('Ada'); await ui.key('\r');
    assert.match(ui.screen(), /Ada/); assert.match(ui.screen(), /Settings · 1 unsaved/); assert.doesNotMatch(ui.screen(), /▌/);
    await ui.key('\x13'); assert.deepEqual(ui.calls.saved, [{userName: 'Ada'}]);
  } finally {await ui.close(); await f.close();}
});

test('search filters rows by label, description and group; Esc clears, no match says so', async () => {
  const f = await settingsFixture();
  const ui = await mount(f.items(), f.pages);
  try {
    await ui.key('/'); assert.match(ui.screen(), /\/▌/);
    await ui.key('diff layout'); assert.match(ui.screen(), /\/diff layout▌ +1\/20/, 'the header shows matches over all rows');
    assert.match(ui.screen(), /Diff layout/); assert.doesNotMatch(ui.screen(), /Cursor/); assert.match(ui.screen(), /Conversation/);
    assert.match(ui.screen(), /Enter done · Esc clear/);
    await ui.key('\r'); assert.match(ui.screen(), /\/diff layout +1\/20/, 'Enter keeps the filter and returns to the list');
    await ui.key('\x1b[C'); assert.match(ui.screen(), /‹ unified ›/, 'the filtered row is editable');
    await ui.key('\x1b'); assert.match(ui.screen(), /Cursor/, 'Esc clears the filter first'); assert.equal(ui.calls.discards, 0);
    await ui.key('/'); await ui.key('splash'); assert.match(ui.screen(), /Start page/); assert.match(ui.screen(), /Tagline/); assert.doesNotMatch(ui.screen(), /Theme/);
    await ui.key('\x7f\x7f\x7f\x7f\x7f\x7f'); await ui.key('zzzz'); assert.match(ui.screen(), /No setting matches "zzzz"/);
    await ui.key('\x1b'); assert.match(ui.screen(), /Theme/);
  } finally {await ui.close(); await f.close();}
});

test('Esc with unsaved changes asks inline; n keeps editing, y discards, both are buttons', async () => {
  const f = await settingsFixture();
  const ui = await mount(f.items(), f.pages);
  try {
    await ui.key('\x1b'); assert.equal(ui.calls.discards, 1, 'nothing to lose, nothing to ask');
    await ui.key('\x1b[C'); await ui.key('\x1b');
    assert.match(ui.screen(), /Discard 1 unsaved change\?  y Discard · n Keep editing/);
    assert.equal(ui.calls.discards, 1);
    await ui.key('\r'); assert.equal(ui.calls.discards, 1, 'Enter never discards by accident');
    await ui.key('n'); assert.doesNotMatch(ui.screen(), /Discard 1/); assert.match(ui.screen(), /Settings · 1 unsaved/);
    await ui.key('\x1b'); await ui.key('\x1b'); assert.doesNotMatch(ui.screen(), /Discard 1/, 'Esc answers no');
    await ui.key('\x1b'); await ui.key('y'); assert.equal(ui.calls.discards, 2);
    await ui.key('n');
    // The question is clickable too.
    await ui.key('\x1b');
    let row = rowOf(ui.lines(), 'y Discard · n');
    await ui.click(ui.lines()[row]!.indexOf('n Keep editing') + 2, row); assert.doesNotMatch(ui.screen(), /Discard 1/);
    await ui.key('\x1b');
    row = rowOf(ui.lines(), 'y Discard · n');
    await ui.click(ui.lines()[row]!.indexOf('y Discard') + 2, row);
    assert.equal(ui.calls.discards, 3);
  } finally {await ui.close(); await f.close();}
});

test('mouse: click selects, ‹ › change, a checkbox toggles, wheel moves, page rows open, footer buttons run', async () => {
  const f = await settingsFixture();
  const ui = await mount(f.items(), f.pages);
  try {
    const cursor = rowOf(ui.lines(), 'Cursor');
    await ui.click(6, cursor); assert.match(ui.screen(), /❯ Cursor/, 'a click selects the row'); assert.deepEqual(ui.calls.previews, []);
    await ui.click(ui.lines()[cursor]!.trimEnd().lastIndexOf('›'), cursor); assert.match(ui.screen(), /‹ Underline _ ›/, '› steps forward');
    await ui.click(ui.lines()[cursor]!.indexOf('‹ Underline'), cursor); assert.match(ui.screen(), /‹ Block █ ›/, '‹ steps back'); assert.doesNotMatch(ui.screen(), /unsaved/);
    const animations = rowOf(ui.lines(), 'Animations');
    await ui.click(ui.lines()[animations]!.trimEnd().length - 2, animations);
    assert.match(ui.screen(), /❯ Animations +\[ \]/, 'the checkbox toggles'); assert.match(ui.screen(), /1 unsaved/);
    await ui.click(ui.lines()[animations]!.trimEnd().length - 2, animations); assert.match(ui.screen(), /Animations +\[✓\]/);
    await ui.click(6, cursor);
    await ui.wheel(30, cursor, 1); assert.match(ui.screen(), /❯ Animations/, 'wheel down moves the selection');
    await ui.wheel(30, cursor, -1); assert.match(ui.screen(), /❯ Cursor/, 'wheel up moves it back');
    // Footer buttons.
    const footer = ui.lines().findIndex(text => text.includes('↑↓ choose'));
    await ui.click(ui.lines()[footer]!.indexOf('←→ change') + 2, footer); assert.match(ui.screen(), /‹ Underline _ ›/, '←→ change is a button');
    await ui.click(ui.lines()[footer]!.indexOf('/ search') + 2, footer); assert.match(ui.screen(), /\/▌/, '/ search is a button');
    await ui.key('\x1b');
    await ui.click(ui.lines()[footer]!.indexOf('Enter save') + 2, footer); assert.deepEqual(ui.calls.saved, [{cursor: 'Underline _'}]);
    await ui.click(ui.lines()[footer]!.indexOf('Esc discard') + 2, footer); assert.match(ui.screen(), /Discard 1 unsaved change/, 'Esc discard is a button and asks first');
    await ui.key('n');
    // Page rows open on a click, wherever on the row.
    await ui.key('\x1b[F'); const pages = rowOf(ui.lines(), 'Permissions');
    await ui.click(8, pages); assert.deepEqual(ui.calls.opened, ['permissions']);
    await ui.click(ui.lines()[pages]!.trimEnd().length - 1, rowOf(ui.lines(), 'Models & pricing')); assert.deepEqual(ui.calls.opened, ['permissions', 'models']);
  } finally {await ui.close(); await f.close();}
});

test('hover recolours the pointed row, its arrows and the footer buttons in the window colour', async () => {
  const f = await settingsFixture();
  const ui = await mount(f.items(), f.pages);
  try {
    const cursor = rowOf(ui.lines(), 'Cursor'), count = () => ui.output.text.split(HOVER_SGR).length;
    const initial = count();
    await ui.move(6, cursor); assert.match(ui.screen(), /❯ Theme/, 'hover never moves the selection');
    assert.ok(count() > initial, 'the hovered row repaints in the window colour');
    const footer = ui.lines().findIndex(text => text.includes('↑↓ choose')), mark = count();
    await ui.move(ui.lines()[footer]!.indexOf('Esc discard') + 2, footer);
    assert.ok(count() > mark, 'a footer button repaints too');
  } finally {await ui.close(); await f.close();}
});

test('a sub-page draws over the settings, Esc returns, and the drafts underneath are kept', async () => {
  const f = await settingsFixture();
  const tabs: CommandTab[] = [{id: 'shortcuts', title: 'Shortcuts', lines: ['Ctrl+S  save']}];
  const sub: SettingsSubPage = {id: 'shortcuts', title: 'Shortcuts', tabs, initialTab: 'shortcuts'};
  const ui = await mount(f.items(), f.pages);
  try {
    await ui.key('\x1b[C'); assert.match(ui.screen(), /1 unsaved/);
    await ui.rerender({sub});
    assert.match(ui.screen(), /Shortcuts/); assert.match(ui.screen(), /Ctrl\+S {2}save/); assert.doesNotMatch(ui.screen(), /Appearance/);
    await ui.key('\x1b[B'); await ui.key('\r'); assert.deepEqual(ui.calls.saved, [], 'settings keys are inert while the sub-page is open');
    await ui.key('\x1b'); assert.equal(ui.calls.closedSub, 1);
    await ui.rerender({});
    assert.match(ui.screen(), /Settings · 1 unsaved/, 'the draft survived the round trip'); assert.match(ui.screen(), /‹ claude-warm ›/);
  } finally {await ui.close(); await f.close();}
});

test('saving locks the page and an error stays in the footer with the drafts intact', async () => {
  const f = await settingsFixture();
  const ui = await mount(f.items(), f.pages);
  try {
    await ui.key('\x1b[C');
    await ui.rerender({saving: true}); assert.match(ui.screen(), /Saving…/);
    await ui.key('\x1b[C'); await ui.key('\r'); assert.deepEqual(ui.calls.saved, []); assert.match(ui.screen(), /‹ claude-warm ›/);
    await ui.rerender({error: 'Cursor was not saved: disk full'});
    assert.match(ui.screen(), /Cursor was not saved: disk full/); assert.match(ui.screen(), /1 unsaved/);
    await ui.rerender({}); assert.match(ui.screen(), /↑↓ choose/);
  } finally {await ui.close(); await f.close();}
});

test('the layout plan is the single source for drawing and hit regions', async () => {
  const f = await settingsFixture();
  try {
    const items = f.items(), common = {items, pages: f.pages, width: 100, height: 30, y: 0, pointer: null, hoverColor: HOVER};
    const view = {drafts: {theme: 'claude-warm'}, query: '', searching: false, selected: 0, scroll: 0, confirming: false, saving: false, error: '', notice: ''};
    const plan = settingsLayout({...common, view});
    assert.equal(plan.dirty, 1); assert.equal(plan.header.map(seg => seg.text).join('').trim().startsWith('Settings · 1 unsaved'), true);
    assert.ok(plan.header.some(seg => seg.text === '1 unsaved' && seg.color === palette.warning), 'the unsaved count uses the warning colour');
    const theme = plan.hits.filter(hit => hit.region.y === 3);
    assert.deepEqual(theme.map(hit => hit.command.kind), ['change', 'change', 'select'], 'narrow regions come before the row-wide one');
    assert.ok(theme[0]!.region.x1 === theme[0]!.region.x0 + 1 && theme[1]!.region.x1 === 98, 'the arrows are one cell at the value block edges');
    assert.deepEqual(changedDrafts(items, {theme: 'logox-dark', cursor: 'Bar |', ghost: 1}), {cursor: 'Bar |'}, 'unchanged and unknown drafts are not changes');
  } finally {await f.close();}
});
