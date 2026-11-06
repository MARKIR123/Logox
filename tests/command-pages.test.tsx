import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {act} from 'react';
import {setTimeout as delay} from 'node:timers/promises';
import stringWidth from 'string-width';
import {renderTerminal} from '../src/tui/terminal/terminal.js';
import {TerminalScreen} from './terminal-screen.js';
import {TabbedPage, tabDisplay} from '../src/tui/panels/tabbed-page.js';
import {Picker} from '../src/tui/panels/picker.js';
import {CommandResultPanel} from '../src/tui/panels/command-result.js';
import {row, rowText, tabContent} from '../src/commands/tab-rows.js';
import {doctorLines, formatDoctorReport, type DoctorReport} from '../src/doctor.js';
import {commandCatalog, commandHelp} from '../src/commands.js';
import {CommandSurfaces} from '../src/commands/surfaces.js';
import type {CommandTab} from '../src/runtime/command-surface.js';

Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
class TerminalInput extends PassThrough {
  isTTY = true; setRawMode(): this {return this;} ref(): this {return this;} unref(): this {return this;}
}
type Instance = ReturnType<typeof renderTerminal>;
async function mount(element: React.ReactElement, columns = 60, rows = 16) {
  const output = new TerminalScreen(), input = new TerminalInput();
  output.columns = columns; output.rows = rows;
  let instance!: Instance;
  await act(async () => {instance = renderTerminal(element, {stdout: output, stdin: input, stderr: new PassThrough(), interactive: true, alternateScreen: true, patchConsole: false, exitOnCtrlC: false});});
  await act(async () => {await instance.waitUntilRenderFlush();});
  const press = async (value: string) => {await act(async () => {input.write(value); await delay(value === '\x1b' ? 40 : 10);}); await instance.waitUntilRenderFlush();};
  const frame = () => output.lines.join('\n');
  const close = async () => {await act(async () => {instance.unmount();}); await instance.waitUntilExit();};
  return {press, frame, close, output};
}
const cells = (display: ReturnType<typeof tabDisplay>) => display.map(line => line.map(cell => cell.text).join(''));

test('tab rows: word wrap keeps a hanging indent and never splits mid-word', () => {
  const tab: CommandTab = {id: 't', title: 'T', lines: [], rows: [
    row.field('Description', 'alpha beta gamma delta epsilon zeta eta theta iota kappa'),
    row.bullet('one two three four five six seven eight nine ten eleven twelve')]};
  const out = cells(tabDisplay(tab, 30));
  assert.ok(out.length > 2);
  // Field continuation rows align under the value (after "Description: ").
  assert.ok(out.slice(1, 3).every(line => !line.trim() || line.startsWith(' '.repeat('Description: '.length)) || line.startsWith('• ') || line.startsWith('  ')));
  for (const line of out) assert.ok(stringWidth(line) <= 30, line);
  const words = out.join(' ').split(/\s+/).filter(Boolean);
  for (const word of ['alpha', 'epsilon', 'kappa', 'twelve']) assert.ok(words.includes(word), word + ' stays whole');
  // Bullet continuation lines indent under the text, not under the bullet.
  const bulletStart = out.findIndex(line => line.trimStart().startsWith('• '));
  assert.ok(bulletStart >= 0 && out[bulletStart + 1]!.startsWith('    '), 'bullet continuation is indented under the text');
});

test('tab rows: rules and labels come from explicit rows and rules span the page width', () => {
  const tab: CommandTab = {id: 't', title: 'T', lines: [], rows: [row.heading('Title'), row.rule(), row.field('Model', 'x'), row.rule('Section')]};
  for (const columns of [20, 44, 90]) {
    const out = cells(tabDisplay(tab, columns));
    assert.equal(stringWidth(out[1]!), columns);
    assert.equal(stringWidth(out[3]!), columns);
  }
  const plain = tabContent([row.field('Provider', 'a'), 'free: text']);
  assert.deepEqual(plain.lines, ['Provider: a', 'free: text']);
  assert.equal(plain.rows?.length, 2);
  assert.deepEqual(tabContent(['only', 'strings']), {lines: ['only', 'strings']});
  // Plain strings are never promoted to label/value rows by guessing at a colon.
  const legacy = tabDisplay({id: 't', title: 'T', lines: ['Heading', 'Key: value goes here']}, 40);
  assert.equal(legacy[1]!.length, 1);
  assert.equal(rowText(row.rule('Q')), '── Q ──');
});

test('permissions page edits a draft: Space marks it unsaved, Enter applies, Esc leaves without applying', async () => {
  const modes = [{id: 'default', description: 'Ask first'}, {id: 'auto', description: 'Auto'}, {id: 'creative', description: 'Rules only'}];
  const tabs: CommandTab[] = [{id: 'permissions', title: 'Permissions', mode: {current: 'default', options: modes}, ...tabContent([row.field('Readonly concurrency', 4)])}];
  const actions: string[] = []; let closed = 0;
  const view = await mount(<TabbedPage title="Permissions" tabs={tabs} initialTab="permissions" width={70} height={14}
    onAction={(_tab, action) => {actions.push(action);}} onClose={() => {closed++;}}/>, 70, 14);
  assert.match(view.frame(), /Mode: default/);
  assert.doesNotMatch(view.frame(), /unsaved/);
  await view.press(' '); await view.press(' ');
  assert.match(view.frame(), /Mode: creative · unsaved/);
  assert.deepEqual(actions, [], 'changing the draft saves nothing');
  await view.press('\r');
  assert.deepEqual(actions, ['set_mode:creative']);
  await view.press('\x1b');
  assert.equal(closed, 1);
  await view.close();
});

test('permissions page: Esc with a draft closes without ever sending an action', async () => {
  const tabs: CommandTab[] = [{id: 'permissions', title: 'Permissions', lines: [], mode: {current: 'default', options: [{id: 'default', description: 'a'}, {id: 'auto', description: 'b'}]}}];
  const actions: string[] = []; let closed = 0;
  const view = await mount(<TabbedPage title="P" tabs={tabs} initialTab="permissions" width={60} height={12}
    onAction={(_tab, action) => {actions.push(action);}} onClose={() => {closed++;}}/>, 60, 12);
  await view.press('\x1b[C');
  assert.match(view.frame(), /Mode: auto · unsaved/);
  await view.press('\x1b');
  assert.equal(closed, 1);
  assert.deepEqual(actions, []);
  await view.close();
});

test('an inline confirmation captures keys: y confirms, anything else cancels, Esc does not close the page', async () => {
  const tabs: CommandTab[] = [{id: 'providers', title: 'Providers', lines: ['x']}];
  const actions: string[] = []; let closed = 0;
  const view = await mount(<TabbedPage title="Providers" tabs={tabs} initialTab="providers" width={70} height={12}
    confirm={{tabId: 'providers', action: 'confirm_logout', prompt: "Log out of provider 'a'?"}}
    onAction={(_tab, action) => {actions.push(action);}} onClose={() => {closed++;}}/>, 70, 12);
  assert.match(view.frame(), /Log out of provider 'a'\?/);
  await view.press('\x1b');
  await view.press('n');
  await view.press('y');
  assert.deepEqual(actions, ['cancel_confirm', 'cancel_confirm', 'confirm_logout']);
  assert.equal(closed, 0);
  await view.close();
});

test('surfaces: a tab action can ask for confirmation, and the confirmation clears on the next action', async () => {
  const done: string[] = [];
  const surfaces = new CommandSurfaces(result => {if (result.message) done.push(result.message);});
  surfaces.openPage('P', [{id: 'providers', title: 'Providers', lines: []}], 'providers', {
    onSaveToggles: () => ({}),
    onTabAction: (_tab, action) => action === 'logout' ? {confirm: {action: 'confirm_logout', prompt: 'Sure?'}}
      : action === 'confirm_logout' ? {message: 'Logged out', presentation: 'status', close: true} : {}});
  const id = surfaces.getSnapshot()!.id;
  await surfaces.triggerTabAction(id, 'providers', 'logout');
  const asking = surfaces.getSnapshot();
  assert.equal(asking?.kind === 'page' && asking.confirm?.prompt, 'Sure?');
  await surfaces.triggerTabAction(id, 'providers', 'confirm_logout');
  assert.equal(surfaces.getSnapshot(), null, 'close dismisses the page');
  assert.deepEqual(done, ['Logged out']);
});

test('picker: an empty list shows the next action instead of a dead search box', async () => {
  const view = await mount(<Picker title="Resume Session" description="d" items={[]} emptyText="No saved sessions yet. Keep working, then use /resume again."
    width={70} height={10} onSelect={() => {}} onCancel={() => {}}/>, 70, 10);
  assert.match(view.frame(), /No saved sessions yet/);
  assert.doesNotMatch(view.frame(), /Search:/);
  await view.close();
});

test('picker: the description column grows with the width instead of a 30-cell cap', async () => {
  const description = 'a long description that clearly exceeds thirty cells of room';
  const items = [{id: 'a', label: 'model-a', description}];
  const wide = await mount(<Picker title="T" description="" items={items} width={110} height={10} onSelect={() => {}} onCancel={() => {}}/>, 110, 10);
  assert.ok(wide.frame().includes(description), 'wide terminals show the whole description');
  await wide.close();
  const narrow = await mount(<Picker title="T" description="" items={items} width={40} height={10} onSelect={() => {}} onCancel={() => {}}/>, 40, 10);
  assert.ok(!narrow.frame().includes(description));
  assert.match(narrow.frame(), /model-a/);
  await narrow.close();
});

test('doctor: panel lines are structured tones with no raw ANSI, and the command is discoverable', async () => {
  const report: DoctorReport = {allPassed: false, checks: [
    {name: 'Node.js Runtime', status: 'pass', message: 'v22'}, {name: 'Playwright', status: 'warn', message: 'missing', detail: 'npm run browser:install'},
    {name: 'Credentials', status: 'fail', message: 'none'}]};
  const lines = doctorLines(report);
  assert.ok(lines.every(line => !line.text.includes('\x1b')));
  assert.deepEqual(lines.filter(line => line.tone === 'pass' || line.tone === 'warn' || line.tone === 'fail').map(line => line.tone), ['pass', 'warn', 'fail']);
  assert.ok(formatDoctorReport(report).includes('\x1b'), 'the CLI report keeps its own terminal styling');
  assert.ok(commandCatalog.some(command => command.name === 'doctor'));
  assert.match(commandHelp(), /\/doctor/);
  const view = await mount(<CommandResultPanel title="Logox Doctor" text={lines.map(line => line.text).join('\n')} styled={lines} width={80} height={16}
    onClose={() => {}} onCopy={() => {}}/>, 80, 16);
  assert.match(view.frame(), /Node\.js Runtime/);
  assert.doesNotMatch(view.frame(), /\[1m|\[0m/);
  await view.close();
});
