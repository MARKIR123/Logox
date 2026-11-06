import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import chalk from 'chalk';
import {act, type ReactElement} from 'react';
import {Box} from 'ink';
import {setTimeout as delay} from 'node:timers/promises';
import {renderTerminal as render} from '../src/tui/terminal/terminal.js';
import {TerminalScreen} from './terminal-screen.js';
import {MouseHost} from '../src/tui/terminal/mouse.js';
import {Picker} from '../src/tui/panels/picker.js';
import {TabbedPage} from '../src/tui/panels/tabbed-page.js';
import {QuestionPanel} from '../src/tui/interactions/question-panel.js';
import {CommandSuggestions} from '../src/tui/commands/command-suggestions.js';
import {CommandResultPanel} from '../src/tui/panels/command-result.js';
import {initialPermissionsUi, permissionsView, reduceClick, type EditorClick} from '../src/tui/panels/permissions-editor.js';
import {footerParts, hitFooter, panelRows} from '../src/tui/components/panel-frame.js';
import {toggleZone} from '../src/tui/panels/toggle-list.js';
import {palette} from '../src/tui/appearance/theme.js';
import type {CommandTab, CommandToggle, PermissionsPageData, PickerItem} from '../src/runtime/command-surface.js';
Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
class Input extends PassThrough {isTTY = true; setRawMode(): this {return this;} ref(): this {return this;} unref(): this {return this;}}

chalk.level = 3;
const HOVER = '#ff8800', HOVER_SGR = '38;2;255;136;0';
async function mount(element: ReactElement, columns = 80, rows = 24) {
  const input = new Input(), output = new TerminalScreen(); output.columns = columns; output.rows = rows;
  const listeners = new Set<(event: import('../src/tui/terminal/mouse.js').SgrMouseEvent) => void>();
  let instance!: ReturnType<typeof render>;
  await act(async () => {instance = render(<MouseHost subscribe={handler => {listeners.add(handler); return () => {listeners.delete(handler);};}} color={HOVER}>{element}</MouseHost>,
    {stdin: input, stdout: output, stderr: output, interactive: true, alternateScreen: true, patchConsole: false, exitOnCtrlC: false, maxFps: 100});});
  const flush = async () => {await act(async () => {await instance.waitUntilRenderFlush();});};
  const key = async (value: string) => {await act(async () => {input.write(value); await delay(value === '\x1b' ? 40 : 5);}); await flush();};
  // Mouse events reach the surface through the shared subscriber exactly as App forwards them.
  const send = async (button: number, x: number, y: number, action: 'press' | 'release' | 'move' | 'wheel_up' | 'wheel_down') => {
    await act(async () => {for (const listener of listeners) listener({button, x, y, action}); await delay(5);}); await flush();
  };
  await flush();
  return {key, output, screen: () => output.lines.join('\n'), lines: () => output.lines,
    click: async (x: number, y: number) => {await send(0, x, y, 'press'); await send(0, x, y, 'release');},
    move: (x: number, y: number) => send(0, x, y, 'move'),
    wheel: (x: number, y: number, direction: 1 | -1) => send(0, x, y, direction > 0 ? 'wheel_down' : 'wheel_up'),
    close: async () => {await act(async () => {instance.unmount();}); await instance.waitUntilExit(); input.destroy(); output.destroy();}};
}
const rowOf = (lines: readonly string[], text: string) => { const at = lines.findIndex(line => line.includes(text)); assert.ok(at >= 0, 'row with ' + text); return at; };
const colOf = (lines: readonly string[], text: string) => { const row = lines.find(line => line.includes(text)); assert.ok(row, text); return row.indexOf(text); };

const models: PickerItem[] = Array.from({length: 8}, (_, index) => ({id: 'm' + index, label: 'model-' + index, description: 'desc ' + index, ...(index === 3 ? {disabled: true} : {})}));

test('picker: click focuses then activates, wheel moves, disabled rows ignore clicks, footer actions are clickable', async () => {
  const chosen: string[] = []; let cancelled = 0;
  const ui = await mount(<Picker title="Pick" description="d" items={models} current="m0" width={60} height={14} y={0} onSelect={id => {chosen.push(id);}} onCancel={() => {cancelled++;}}/>, 60, 14);
  try {
    assert.match(ui.screen(), /❯ model-0/);
    const row2 = rowOf(ui.lines(), 'model-2');
    await ui.click(6, row2);
    assert.match(ui.screen(), /❯ model-2/, 'first click only moves focus');
    assert.deepEqual(chosen, []);
    await ui.click(6, row2);
    assert.deepEqual(chosen, ['m2'], 'clicking the focused row activates it');
    await ui.click(6, rowOf(ui.lines(), 'model-3'));
    assert.match(ui.screen(), /❯ model-2/, 'disabled row cannot be focused');
    await ui.wheel(6, row2, 1);
    assert.match(ui.screen(), /❯ model-4/, 'wheel skips the disabled row');
    await ui.wheel(6, row2, -1);
    assert.match(ui.screen(), /❯ model-2/);
    const footerY = 13, back = ui.lines()[footerY]!.indexOf('Esc Back');
    assert.ok(back >= 0, 'footer shows Esc Back');
    await ui.click(back + 2, footerY);
    assert.equal(cancelled, 1, 'Esc Back is a button');
    await ui.click(ui.lines()[footerY]!.indexOf('Enter Confirm') + 1, footerY);
    assert.deepEqual(chosen, ['m2', 'm2']);
  } finally {await ui.close();}
});

test('picker: provider tabs and the effort bar are clickable', async () => {
  const grouped: PickerItem[] = [
    {id: 'a1', label: 'alpha-1', group: 'Alpha', effortLevels: ['low', 'medium', 'high']}, {id: 'a2', label: 'alpha-2', group: 'Alpha', effortLevels: ['low', 'medium', 'high']},
    {id: 'b1', label: 'beta-1', group: 'Beta', effortLevels: ['low', 'medium', 'high']},
  ];
  const picks: [string, string | undefined][] = [];
  const ui = await mount(<Picker title="Models" description="" items={grouped} current="a1" effort="low" effortLevels={['low', 'medium', 'high']} width={70} height={16} y={0}
    onSelect={(id, effort) => {picks.push([id, effort]);}} onCancel={() => {}}/>, 70, 16);
  try {
    assert.match(ui.screen(), /\[ Alpha \]/);
    await ui.click(colOf(ui.lines(), 'Beta') + 1, rowOf(ui.lines(), 'Beta'));
    assert.match(ui.screen(), /\[ Beta \]/, 'clicking a tab switches provider');
    assert.match(ui.screen(), /beta-1/);
    await ui.click(colOf(ui.lines(), 'Alpha') + 1, rowOf(ui.lines(), 'Alpha'));
    const effortRow = rowOf(ui.lines(), 'Thinking');
    const line = ui.lines()[effortRow]!;
    const markers = [...line.matchAll(/\[[ ■]\]/g)].map(match => match.index!);
    assert.equal(markers.length, 3, 'three effort levels drawn');
    await ui.click(markers[2]! + 1, effortRow);
    assert.match(ui.lines()[effortRow]!, /high/, 'clicking the third marker selects high');
    const focused = rowOf(ui.lines(), '❯ alpha-1');
    await ui.click(6, focused);
    assert.deepEqual(picks, [['a1', 'high']], 'activation carries the clicked effort');
  } finally {await ui.close();}
});

test('picker: hovering a row recolours it in the window colour without moving focus', async () => {
  const ui = await mount(<Picker title="Pick" description="d" items={models} current="m0" width={60} height={14} y={0} onSelect={() => {}} onCancel={() => {}}/>, 60, 14);
  try {
    const before = ui.output.text.length, row = rowOf(ui.lines(), 'model-2');
    await ui.move(6, row);
    assert.match(ui.screen(), /❯ model-0/, 'hover never changes focus');
    const emitted = ui.output.text.slice(before);
    assert.match(emitted, /model-2/, 'the hovered row is redrawn');
    assert.ok(!ui.output.text.slice(0, before).includes(HOVER_SGR), 'nothing is tinted before the pointer arrives');
    assert.ok(emitted.includes(HOVER_SGR), 'the hovered row repaints in the window colour');
  } finally {await ui.close();}
});

const toggles: CommandToggle[] = [
  {id: 'theme', label: 'Theme preset', enabled: true, value: 'dark', options: ['dark', 'light', 'warm']},
  {id: 'motion', label: 'UI animations', enabled: false},
];
test('tabbed page: tab bar is derived from layout, clicks switch tabs, ‹ › change values, rows toggle, footer saves', async () => {
  const saved: (readonly CommandToggle[])[] = [];
  const tabs: CommandTab[] = [{id: 'one', title: 'One', lines: ['first page']}, {id: 'settings', title: 'Settings', lines: [], toggles}];
  for (const y of [0, 3]) {
    const ui = await mount(<Box marginTop={y}><TabbedPage title="Cfg" tabs={tabs} initialTab="one" width={60} height={14} y={y} onClose={() => {}} onSave={(_id, items) => {saved.push(items);}}/></Box>, 60, 20);
    try {
      const barY = y + 2, x = ui.lines()[barY]!.indexOf('Settings');
      assert.ok(x > 0, 'tab bar sits two rows under the page top (y=' + y + ')');
      await ui.click(x + 1, barY);
      assert.match(ui.screen(), /Theme preset: dark/);
      const top = y + 4;
      await ui.click(2, top);
      assert.match(ui.screen(), /Theme preset: light/, 'row click advances an enum');
      const width = 60 - 4, controlsX = 2 + width - 4;
      await ui.click(controlsX + 1, top);
      assert.match(ui.screen(), /Theme preset: dark/, '‹ steps back');
      await ui.click(controlsX + 3, top);
      assert.match(ui.screen(), /Theme preset: light/, '› steps forward');
      await ui.click(2, top + 1);
      assert.match(ui.screen(), /❯ \[■\] UI animations/, 'boolean row toggles on click');
      await ui.wheel(5, top, -1);
      assert.match(ui.screen(), /❯ Theme preset/, 'wheel moves the focused row');
      const footerY = y + panelRows(14).footerY, enter = ui.lines()[footerY]!.indexOf('Enter');
      await ui.click(enter + 1, footerY);
      assert.equal(saved.at(-1)?.find(item => item.id === 'motion')?.enabled, true, 'footer Enter button saves the draft');
    } finally {await ui.close();}
  }
});

test('tabbed page: plain pages scroll with the wheel and Esc Back is a button', async () => {
  let closed = 0;
  const tab: CommandTab = {id: 'long', title: 'Long', lines: Array.from({length: 40}, (_, index) => 'row ' + index)};
  const ui = await mount(<TabbedPage title="Long" tabs={[tab]} initialTab="long" width={50} height={12} onClose={() => {closed++;}}/>, 50, 12);
  try {
    assert.match(ui.screen(), /row 0/);
    await ui.wheel(5, 4, 1);
    assert.doesNotMatch(ui.screen(), /row 0\b/);
    assert.match(ui.screen(), /row 3\b/, 'wheel scrolls three rows');
    await ui.wheel(5, 4, -1);
    assert.match(ui.screen(), /row 0\b/);
    const footerY = panelRows(12).footerY, x = ui.lines()[footerY]!.indexOf('Esc Back');
    await ui.click(x + 1, footerY);
    assert.equal(closed, 1);
  } finally {await ui.close();}
});

const permissions = (): PermissionsPageData => ({
  mode: {current: 'default', options: [{id: 'default', description: 'Ask before risky tools'}, {id: 'auto', description: 'Review model decides'}, {id: 'creative', description: 'Allow writes in scratch'}]},
  rules: [{id: 'r1', scope: 'project', decision: 'allow', tool: 'Shell', pattern: 'npm test *', hits: 2, lastHit: Date.now()}, {id: 'r2', scope: 'session', decision: 'deny', tool: 'Write', pattern: 'secrets/**', hits: 0}],
  stats: {approvals: 1, asked: 1, reviewed: 0, tokens: 0}, userScope: false,
});

test('permissions page model: every hit maps to the keyboard transitions', () => {
  const data = permissions();
  const click = (ui = initialPermissionsUi, hit: EditorClick) => reduceClick(data, ui, hit);
  assert.equal(click(undefined, {kind: 'mode', id: 'auto'}).ui.draftMode, 'auto');
  assert.equal(click(undefined, {kind: 'mode', id: 'default'}).ui.draftMode, undefined, 'the saved mode is not a draft');
  const dirty = click(undefined, {kind: 'mode', id: 'auto'}).ui;
  assert.equal(click(dirty, {kind: 'save-mode'}).action, 'set_mode:auto');
  assert.equal(click(undefined, {kind: 'rule', index: 1}).ui.selected, 1);
  const asked = click(undefined, {kind: 'delete', index: 1}).ui;
  assert.equal(asked.confirmDelete, 'r2');
  assert.equal(click(asked, {kind: 'confirm', yes: true}).action, 'delete_rule:r2');
  assert.equal(click(asked, {kind: 'confirm', yes: false}).ui.confirmDelete, undefined);
  const form = click(undefined, {kind: 'add'}).ui;
  assert.ok(form.form);
  assert.equal(click(form, {kind: 'field', field: 0, delta: 1}).ui.form?.decision, 1);
  assert.equal(click(form, {kind: 'field', field: 2}).ui.form?.field, 2);
  assert.match(click(form, {kind: 'submit'}).ui.form?.error ?? '', /\S/, 'an empty form reports its error instead of submitting');
  assert.equal(click(form, {kind: 'cancel'}).ui.form, undefined);
  const view = permissionsView(data, initialPermissionsUi, 60);
  const hits = view.rows.flat().flatMap(cell => cell.hit ? [cell.hit.kind] : []);
  for (const kind of ['mode', 'rule', 'delete', 'add']) assert.ok(hits.includes(kind as never), kind + ' cells exist');
});

test('permissions page: click mode, rule rows, Delete with inline y/n, + Add rule and form fields', async () => {
  const actions: string[] = [];
  const tab: CommandTab = {id: 'permissions', title: 'Permissions', lines: [], permissions: permissions()};
  const ui = await mount(<TabbedPage title="Permissions" tabs={[tab]} initialTab="permissions" width={80} height={24} onClose={() => {}} onAction={(_id, action) => {actions.push(action);}}/>, 80, 24);
  try {
    const modeY = rowOf(ui.lines(), 'Mode'), autoX = ui.lines()[modeY]!.indexOf('auto');
    await ui.click(autoX + 1, modeY);
    assert.match(ui.screen(), /unsaved/);
    await ui.click(ui.lines()[modeY]!.indexOf('unsaved') + 1, modeY);
    assert.deepEqual(actions, ['set_mode:auto'], 'the unsaved badge saves the draft');
    const second = rowOf(ui.lines(), 'secrets/**');
    await ui.click(12, second);
    assert.match(ui.lines()[rowOf(ui.lines(), 'secrets/**')]!, /❯/, 'clicking a rule selects it');
    const del = ui.lines()[second]!.indexOf('[Delete]');
    assert.ok(del > 0, 'the selected rule shows a Delete button');
    await ui.click(del + 2, second);
    assert.match(ui.screen(), /Delete this rule\? y \/ n/);
    await ui.click(ui.lines()[second]!.indexOf('y /') , second);
    assert.deepEqual(actions, ['set_mode:auto', 'delete_rule:r2']);
    await ui.click(ui.lines()[rowOf(ui.lines(), '+ Add rule')]!.indexOf('+ Add') + 1, rowOf(ui.lines(), '+ Add rule'));
    assert.match(ui.screen(), /New rule/);
    const tool = rowOf(ui.lines(), 'Tool');
    await ui.click(14, tool);
    assert.match(ui.lines()[tool]!, /❯/, 'clicking a form field focuses it');
    const decision = rowOf(ui.lines(), 'Decision'), next = ui.lines()[decision]!.indexOf('›');
    await ui.click(next, decision);
    assert.match(ui.lines()[decision]!, /‹ ask/, 'the › control cycles the choice');
    const cancel = rowOf(ui.lines(), '[ Cancel ]');
    await ui.click(ui.lines()[cancel]!.indexOf('[ Cancel ]') + 2, cancel);
    assert.doesNotMatch(ui.screen(), /New rule/);
    await ui.wheel(10, second, -1);
    assert.match(ui.lines()[rowOf(ui.lines(), 'npm test')]!, /❯/, 'wheel moves the selected rule');
  } finally {await ui.close();}
});

test('providers page: footer actions are buttons and the logout confirmation answers by click', async () => {
  const actions: string[] = [];
  const tab: CommandTab = {id: 'providers', title: 'Providers', lines: ['openai: connected']};
  const make = (confirm?: {tabId: string; action: string; prompt: string}) => <TabbedPage title="Providers" tabs={[tab]} initialTab="providers" width={90} height={12}
    onClose={() => {}} onAction={(_id, action) => {actions.push(action);}} {...(confirm ? {confirm} : {})}/>;
  const ui = await mount(make(), 90, 12);
  try {
    const y = panelRows(12).footerY, line = ui.lines()[y]!;
    for (const [label, action] of [['[t] Test', 'test'], ['[r] Refresh', 'refresh'], ['[x] Logout', 'logout']] as const) await ui.click(line.indexOf(label) + 1, y), assert.equal(actions.at(-1), action);
    await ui.click(line.indexOf('[←') + 1, y); assert.equal(actions.at(-1), 'prev_provider');
    await ui.click(line.indexOf('→]') + 1, y); assert.equal(actions.at(-1), 'next_provider');
  } finally {await ui.close();}
  const confirming = await mount(make({tabId: 'providers', action: 'confirm_logout', prompt: 'Log out?'}), 90, 12);
  try {
    const row = rowOf(confirming.lines(), 'Confirm');
    await confirming.click(confirming.lines()[row]!.indexOf('[y]') + 1, row);
    assert.equal(actions.at(-1), 'confirm_logout');
    await confirming.click(confirming.lines()[row]!.indexOf('any other key') + 1, row);
    assert.equal(actions.at(-1), 'cancel_confirm');
  } finally {await confirming.close();}
});

test('command result panel: wheel scrolls and footer Copy all / Esc Back are buttons', async () => {
  let closed = 0; const copied: string[] = [];
  const text = Array.from({length: 40}, (_, index) => 'line ' + index).join('\n');
  const ui = await mount(<CommandResultPanel title="Result" text={text} width={60} height={12} onClose={() => {closed++;}} onCopy={value => {copied.push(value);}}/>, 60, 12);
  try {
    assert.match(ui.screen(), /line 0\b/);
    await ui.wheel(5, 5, 1);
    assert.match(ui.screen(), /line 3\b/);
    const y = panelRows(12).footerY, line = ui.lines()[y]!;
    await ui.click(line.indexOf('Ctrl+C') + 1, y);
    assert.equal(copied.length, 1);
    await ui.click(ui.lines()[y]!.indexOf('Esc Back') + 1, y);
    assert.equal(closed, 1);
  } finally {await ui.close();}
});

test('shared geometry helpers: footer parts and toggle zones come from the rendered text', () => {
  const parts = footerParts('↑↓ Select · Enter Confirm · Esc Back', [{label: 'Enter Confirm', run: () => {}}, {label: 'Esc Back', run: () => {}}], 60, 5, 12, true);
  const confirm = parts.find(part => part.text === 'Enter Confirm')!;
  assert.equal(confirm.region?.y, 5 + panelRows(12, true).footerY);
  assert.equal(confirm.region?.x0, 2 + '↑↓ Select · '.length);
  assert.equal(hitFooter(parts, {x: confirm.region!.x0, y: confirm.region!.y})?.text, 'Enter Confirm');
  assert.equal(hitFooter(parts, {x: confirm.region!.x1, y: confirm.region!.y}), undefined, 'x1 is exclusive');
  const clipped = footerParts('abcdef Esc Back', [{label: 'Esc Back', run: () => {}}], 12, 0, 8);
  assert.ok(!clipped.some(part => part.region), 'a label cut by the width is not clickable');
  const toggle: CommandToggle = {id: 'a', enabled: true};
  assert.equal(toggleZone(toggle, 30, 25), 'row');
  assert.equal(toggleZone(toggle, 30, 27), 'dec');
  assert.equal(toggleZone(toggle, 30, 29), 'inc');
  assert.equal(toggleZone(toggle, 10, 9), 'row', 'narrow boolean rows have no controls');
  void palette;
});

test('hover uses the window colour on tabs, footer buttons, toggle controls and permission cells; leaving restores', async () => {
  const tabs: CommandTab[] = [{id: 'one', title: 'One', lines: ['first']}, {id: 'settings', title: 'Settings', lines: [], toggles}];
  const ui = await mount(<TabbedPage title="Cfg" tabs={tabs} initialTab="settings" width={60} height={14} onClose={() => {}}/>, 60, 14);
  try {
    const painted = async (x: number, y: number) => {const before = ui.output.text.length; await ui.move(x, y); return ui.output.text.slice(before).includes(HOVER_SGR);};
    assert.equal(await painted(30, 7), false, 'blank cells are not hover targets');
    assert.equal(await painted(ui.lines()[2]!.indexOf('One') + 1, 2), true, 'inactive tab');
    assert.equal(await painted(30, 7), false, 'moving away stops the highlight');
    const y = panelRows(14).footerY;
    assert.equal(await painted(ui.lines()[y]!.indexOf('Enter') + 1, y), true, 'footer button');
    assert.equal(await painted(2 + 56 - 1, 5), true, 'the ‹ › controls of a row');
  } finally {await ui.close();}
  const tab: CommandTab = {id: 'permissions', title: 'Permissions', lines: [], permissions: permissions()};
  const page = await mount(<TabbedPage title="Permissions" tabs={[tab]} initialTab="permissions" width={80} height={24} onClose={() => {}}/>, 80, 24);
  try {
    const row = rowOf(page.lines(), '+ Add rule'), before = page.output.text.length;
    await page.move(page.lines()[row]!.indexOf('+ Add') + 1, row);
    assert.ok(page.output.text.slice(before).includes(HOVER_SGR), '+ Add rule');
  } finally {await page.close();}
});

test('question panel and command menu: rows hover in the window colour, click selects, wheel steps', async () => {
  const answers: unknown[] = [];
  const ui = await mount(<QuestionPanel question={{header: 'Approach', question: 'Choose', options: [{label: 'Alpha'}, {label: 'Beta'}]}} position={1} total={1} answered={0} width={60} height={16}
    onAnswer={value => {answers.push(value);}} onCancel={() => {}} onToggleFold={() => {}}/>, 60, 16);
  try {
    const row = rowOf(ui.lines(), 'Beta'), before = ui.output.text.length;
    await ui.move(ui.lines()[row]!.indexOf('Beta') + 1, row);
    assert.ok(ui.output.text.slice(before).includes(HOVER_SGR), 'hovered option');
    await ui.click(ui.lines()[row]!.indexOf('Beta') + 1, row);
    assert.match(ui.lines()[rowOf(ui.lines(), 'Beta')]!, /❯|■/, 'click focuses the option');
  } finally {await ui.close();}
  const picked: number[] = []; const steps: number[] = [];
  const menu = await mount(<Box marginTop={2}><CommandSuggestions commands={[{name: '/alpha', description: 'a'}, {name: '/beta', description: 'b'}, {name: '/gamma', description: 'c'}]} selectedIndex={0} columns={60} y={2}
    onPick={index => {picked.push(index);}} onWheelStep={direction => {steps.push(direction);}}/></Box>, 60, 10);
  try {
    const row = rowOf(menu.lines(), '/gamma'), before = menu.output.text.length;
    await menu.move(6, row);
    assert.ok(menu.output.text.slice(before).includes(HOVER_SGR), 'hovered command');
    await menu.click(6, row);
    await menu.wheel(6, row, 1);
    assert.deepEqual(picked, [2]); assert.deepEqual(steps, [1]);
  } finally {await menu.close();}
});
