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
  session: 'settings', pageOwner: 'logox', permissions: {mode: 'default', description: '', lines: [], readonly_concurrency: 1, approvalTokens: 0},
  statusbarModules: [{id: 'role', label: 'Role', enabled: true}, {id: 'model', label: 'Model', enabled: true}, {id: 'context', label: 'Context', enabled: false}],
  statusLines: [], usageLines: [], providersLines: [], commandsLines: [],
};
async function mount(command = '/statusbar', saveGate?: Promise<void>) {
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
test('Statusbar rapid style and module edits are included when Enter arrives in the same chunk', async () => {
  let finish!: () => void;
  const gate = new Promise<void>(resolve => {finish = resolve;});
  const ui = await mount('/statusbar', gate);
  try {
    await ui.key('\x1b[C\r');
    assert.equal(ui.appearances[0]?.style, 'starship', 'Save receives the most recent style, not the previous render');
    await act(async () => {finish(); await delay(5);});
    await ui.reopen(); await ui.key('\x1b[B\x1b[B\x1b[B'); await ui.key('\x1b[32u\r');
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
    await ui.key('\x1b[B'); await ui.key('\x1b[B'); await ui.key('\x1b[B');
    assert.match(ui.screen(), /←→ Reorder/);
    assert.match(ui.screen(), /Space Toggle/);
    await ui.key('\x1b[C'); assert.ok(ui.screen().indexOf('Model') < ui.screen().indexOf('Role'));
    await ui.key(' '); await ui.key('\r');
    assert.deepEqual(ui.saved[0]?.map(item => item.id), ['model', 'role', 'context']);
    assert.equal(ui.saved[0]?.find(item => item.id === 'role')?.enabled, false);
  } finally {await ui.close();}
});
