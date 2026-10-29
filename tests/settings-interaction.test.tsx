import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {act} from 'react';
import {setTimeout as delay} from 'node:timers/promises';
import {renderTerminal as render} from '../src/tui/terminal/terminal.js';
import {TerminalScreen} from './terminal-screen.js';
import {App} from '../src/tui/app.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {CommandSurfaces} from '../src/commands/surfaces.js';
import {createCommandTabsFor, type ApplicationCommandContext} from '../src/application-commands.js';
import type {StatusbarAppearance} from '../src/config/statusbar-preferences.js';
import type {CommandToggle, CommandTab} from '../src/runtime/command-surface.js';
Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
class Input extends PassThrough {isTTY = true; setRawMode(): this {return this;} ref(): this {return this;} unref(): this {return this;}}
const context: ApplicationCommandContext = {
  session: 'settings', pageOwner: 'logox', currentTheme: 'dark', themeOptions: ['dark', 'light', 'warm'],
  currentCursor: 'Block █', motion: false, permissions: {mode: 'default', description: '', lines: [], readonly_concurrency: 1, approvalTokens: 0},
  statusbarModules: [{id: 'role', label: 'Role', enabled: true}, {id: 'model', label: 'Model', enabled: true}, {id: 'context', label: 'Context', enabled: false}],
  statusLines: [], usageLines: [], providersLines: [], actorsLines: [], commandsLines: [],
};
async function mount(command = '/settings', saveGate?: Promise<void>) {
  const page = createCommandTabsFor(command, context)!;
  const surfaces = new CommandSurfaces(() => {}), saved: (readonly CommandToggle[])[] = [], appearances: (StatusbarAppearance | undefined)[] = [];
  const store = new RuntimeStore(), input = new Input(), output = new TerminalScreen(); output.columns = 100; output.rows = 18;
  const open = (tabs: readonly CommandTab[] = page.tabs, initialTab = page.initialTab) => surfaces.openPage(page.title, tabs, initialTab,
    {onSaveToggles: (_id, items, appearance) => {saved.push(items); appearances.push(appearance); return saveGate ? saveGate.then(() => ({})) : {};}});
  open(); let instance!: ReturnType<typeof render>;
  await act(async () => {instance = render(<App stage store={store} sessionId="settings" surfaces={surfaces}
    onSubmit={async () => {}} onCancel={() => {}} onClose={async () => {surfaces.close();}}/>,
    {stdin: input, stdout: output, stderr: output, interactive: true, alternateScreen: true, patchConsole: false, exitOnCtrlC: false, maxFps: 100});});
  const flush = async () => {await act(async () => {await instance.waitUntilRenderFlush();});};
  const key = async (value: string) => {await act(async () => {input.write(value); await delay(value === '\x1b' ? 40 : 5);}); await flush();};
  const click = async (x: number, y: number) => {await key(`\x1b[<0;${x + 1};${y + 1}M`); await key(`\x1b[<0;${x + 1};${y + 1}m`);};
  await flush();
  return {surfaces, saved, appearances, key, click, output, screen: () => output.lines.join('\n'),
    reopen: async () => {await act(async () => {open();}); await flush();},
    close: async () => {await act(async () => {surfaces.close(); instance.unmount();}); await instance.waitUntilExit(); input.destroy(); output.destroy();},
  };
}
function ordered(screen: string) {
  const theme = screen.indexOf('Theme preset:'), cursor = screen.indexOf('Cursor style:'), motion = screen.indexOf('UI animations');
  assert.ok(theme >= 0 && cursor > theme && motion > cursor, 'Settings order stays Theme → Cursor → Animations');
}
test('Settings arrows never reorder: boolean left=off/right=on; Space toggles; Enter saves', async () => {
  const ui = await mount();
  try {
    ordered(ui.screen()); await ui.key('\x1b[B'); await ui.key('\x1b[B');
    await ui.key('\x1b[C'); ordered(ui.screen()); assert.match(ui.screen(), /❯ \[■\] UI animations/);
    await ui.key('\x1b[C'); assert.match(ui.screen(), /❯ \[■\] UI animations/, 'Right is idempotent');
    await ui.key('\x1b[D'); ordered(ui.screen()); assert.match(ui.screen(), /❯ \[ \] UI animations/);
    await ui.key('\x1b[D'); assert.match(ui.screen(), /❯ \[ \] UI animations/, 'Left is idempotent');
    await ui.key(' '); assert.match(ui.screen(), /❯ \[■\] UI animations/);
    assert.match(ui.screen(), /← Off.*→ On/); assert.doesNotMatch(ui.screen(), /Reorder/);
    assert.equal(ui.saved.length, 0); await ui.key('\r');
    assert.deepEqual(ui.saved[0]?.map(item => item.id), ['theme', 'cursor', 'motion']);
    assert.equal(ui.saved[0]?.find(item => item.id === 'motion')?.enabled, true); assert.equal(ui.surfaces.getSnapshot(), null);
  } finally {await ui.close();}
});
test('Settings enum arrows cycle values; Space advances; Escape discards all changes', async () => {
  const ui = await mount();
  try {
    await ui.key('\x1b[C'); assert.match(ui.screen(), /Theme preset: light/);
    await ui.key('\x1b[D'); assert.match(ui.screen(), /Theme preset: dark/);
    await ui.key('\x1b[D'); assert.match(ui.screen(), /Theme preset: warm/);
    await ui.key(' '); assert.match(ui.screen(), /Theme preset: dark/);
    await ui.key('\x1b[B'); await ui.key('\x1b[C'); assert.match(ui.screen(), /Cursor style: Underline/);
    ordered(ui.screen()); await ui.key('\x1b'); assert.equal(ui.saved.length, 0);
    await ui.reopen(); assert.match(ui.screen(), /Theme preset: dark/); assert.match(ui.screen(), /Cursor style: Block/); ordered(ui.screen());
  } finally {await ui.close();}
});
test('Settings mouse left/right controls match keyboard, never reorder or hit empty rows', async () => {
  const ui = await mount();
  try {
    const themeRow = ui.output.lines.findIndex(line => line.includes('Theme preset:'));
    const motionRow = ui.output.lines.findIndex(line => line.includes('UI animations'));
    // App uses columns-1; content padding is two cells and controls occupy the last four content cells.
    await ui.click(94, themeRow); assert.match(ui.screen(), /Theme preset: warm/, 'Left chevron chooses previous value');
    await ui.click(96, themeRow); assert.match(ui.screen(), /Theme preset: dark/);
    await ui.click(96, motionRow); ordered(ui.screen()); assert.match(ui.screen(), /❯ \[■\] UI animations/);
    await ui.click(94, motionRow); ordered(ui.screen()); assert.match(ui.screen(), /❯ \[ \] UI animations/);
    await ui.click(3, motionRow); assert.match(ui.screen(), /❯ \[■\] UI animations/);
    const before = ui.screen();
    await ui.click(0, motionRow); assert.equal(ui.screen(), before, 'Left padding is not an item control');
    await ui.click(3, motionRow + 1); assert.equal(ui.screen(), before, 'Empty rows are not item controls');
    await ui.key('\r'); assert.equal(ui.saved[0]?.find(item => item.id === 'motion')?.enabled, true);
  } finally {await ui.close();}
});
test('Settings rapid repeated value changes accumulate instead of overwriting drafts', async () => {
  const ui = await mount();
  try {
    await ui.key('\x1b[C\x1b[C'); assert.match(ui.screen(), /Theme preset: warm/);
    await ui.key('\r'); assert.equal(ui.saved[0]?.[0]?.value, 'warm');
    assert.deepEqual(ui.saved[0]?.map(item => item.id), ['theme', 'cursor', 'motion']);
  } finally {await ui.close();}
});
test('Settings save locks keyboard and mouse changes and prevents duplicate submission', async () => {
  let finish!: () => void;
  const gate = new Promise<void>(resolve => {finish = resolve;});
  const ui = await mount('/settings', gate);
  try {
    await ui.key('\r'); assert.match(ui.screen(), /Saving/);
    const before = ui.screen();
    await ui.key('\x1b[C'); await ui.key('\x1b[B'); await ui.key(' ');
    await ui.key('\r'); await ui.key('\x1b');
    await ui.click(96, ui.output.lines.findIndex(line => line.includes('Theme preset:')));
    assert.equal(ui.screen(), before); assert.equal(ui.saved.length, 1); assert.ok(ui.surfaces.getSnapshot());
    await act(async () => {finish(); await delay(5);});
    assert.equal(ui.surfaces.getSnapshot(), null);
  } finally {finish(); await ui.close();}
});

test('Statusbar rapid style and module edits are included when Enter arrives in the same chunk', async () => {
  let finish!: () => void;
  const gate = new Promise<void>(resolve => {finish = resolve;});
  const ui = await mount('/statusbar', gate);
  try {
    await ui.key('\x1b[C\r');
    assert.equal(ui.appearances[0]?.style, 'starship', 'Save receives the most recent style, not the previous render');
    await act(async () => {finish(); await delay(5);});
    await ui.reopen(); await ui.key('\x1b[B\x1b[B'); await ui.key('\x1b[32u\r');
    assert.equal(ui.saved[1]?.find(item => item.id === 'role')?.enabled, false, 'Save receives the most recent module toggle');
  } finally {finish(); await ui.close();}
});

test('Statusbar locks edits immediately when Enter and edit keys arrive in the same input chunk', async () => {
  let finish!: () => void;
  const gate = new Promise<void>(resolve => {finish = resolve;});
  const ui = await mount('/statusbar', gate);
  try {
    await ui.key('\r\x1b[C');
    assert.match(ui.screen(), /Style: Pipes/, 'Pending save must freeze the appearance before React commits');
    assert.doesNotMatch(ui.screen(), /Style: Starship/);
    assert.match(ui.screen(), /Saving/); assert.equal(ui.saved.length, 1);
    await ui.click(96, ui.output.lines.findIndex(line => line.includes('Style:')));
    await ui.key('\r\t\x1b[B '); assert.match(ui.screen(), /Style: Pipes/); assert.equal(ui.saved.length, 1);
    await act(async () => {finish(); await delay(5);});
    assert.equal(ui.surfaces.getSnapshot(), null);
  } finally {finish(); await ui.close();}
});

test('Only Status Bar arrows reorder; Space toggles independently and help names reordering', async () => {
  const ui = await mount('/statusbar');
  try {
    assert.match(ui.screen(), /Style: Pipes/);
    await ui.key('\x1b[C'); assert.match(ui.screen(), /Style: Starship/);
    await ui.key('\x1b[B'); await ui.key('\x1b[B');
    assert.match(ui.screen(), /←→ Reorder/);
    assert.match(ui.screen(), /Space Toggle/);
    await ui.key('\x1b[C'); assert.ok(ui.screen().indexOf('Model') < ui.screen().indexOf('Role'));
    await ui.key(' '); await ui.key('\r');
    assert.deepEqual(ui.saved[0]?.map(item => item.id), ['model', 'role', 'context']);
    assert.equal(ui.saved[0]?.find(item => item.id === 'role')?.enabled, false);
  } finally {await ui.close();}
});
