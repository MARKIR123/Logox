import test from 'node:test';
import assert from 'node:assert/strict';
import {commandCatalog, commandHelp, emptyCommandContext} from '../src/commands.js';
import {commandSuggestions} from '../src/tui/commands/completion.js';
import {act} from 'react';
import {PassThrough} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {waitFor} from './wait-for.js';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../src/application.js';
import {loadConfig} from '../src/config/config.js';
import {defaultStatusbar} from '../src/config/statusbar-preferences.js';
import {palette, applyTheme} from '../src/config/theme-palette.js';
import {ApplicationStage} from '../src/tui/application.js';
import {renderTerminal} from '../src/tui/terminal/terminal.js';
import {TerminalScreen} from './terminal-screen.js';
Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
class Input extends PassThrough {isTTY = true; setRawMode(): this {return this;} ref(): this {return this;} unref(): this {return this;}}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'logox-statusbar-composition-')), path = join(root, '.logox', 'statusbar.json');
  const oldTheme = {...palette};
  const config = await loadConfig(root, {permissions: {mode: 'default'}, provider: {model: 'test-model', context_window: 8192}}, {}, root, root);
  let calls = 0, networkCalls = 0;
  const app = await createApplication({cwd: root, config, env: {}, resourceOptions: {home: root, boundary: root}, authPath: join(root, 'auth.json'),
    fetcher: async () => {networkCalls++; throw new Error('No network request is allowed for settings configuration');},
    provider: {respond: async () => {calls++; throw new Error('No model call is allowed for statusbar configuration');}}});
  const input = new Input(), output = new TerminalScreen(); output.columns = 100; output.rows = 24;
  let instance!: ReturnType<typeof renderTerminal>;
  await act(async () => {instance = renderTerminal(<ApplicationStage application={app}/>, {stdin: input, stdout: output, stderr: output,
    interactive: true, alternateScreen: true, patchConsole: false, exitOnCtrlC: false, maxFps: 100});});
  const flush = async () => {await act(async () => {await instance.waitUntilRenderFlush();});};
  const key = async (text: string) => {await act(async () => {
    input.write(text); await delay(text === '\x1b' ? 40 : 5);
    if (text === '\r') {
      for (let round = 0; round < 200; round++) {
        const surface = app.surfaces.getSnapshot();
        if ((surface?.kind !== 'page' && surface?.kind !== 'settings') || !surface.saving) break;
        if (round === 199) throw new Error('Configuration save did not settle');
        await delay(10);
      }
    }
  }); await flush();};
  await flush();
  return {app, output, path, uiPath: join(root, '.logox', 'ui-preferences.json'), key, flush, text: () => output.lines.join('\n'),
    async until(pattern: RegExp) {await waitFor(async () => {await flush(); return output.lines.join('\n');}, text => pattern.test(text), {label: 'screen matches ' + pattern});},
    get calls() {return calls;}, get networkCalls() {return networkCalls;},
    async open(command: string) {await act(async () => {await app.submit(command);}); await flush();},
    async resize(columns: number, rows: number) {await act(async () => {output.resize(columns, rows);}); await flush();},
    async clickLabel(label: string, column = 3) {const row = output.lines.findIndex(line => line.includes(label)); assert.ok(row >= 0, label + ' exists'); await key(`\x1b[<0;${column + 1};${row + 1}M`); await key(`\x1b[<0;${column + 1};${row + 1}m`);},
    async close() {try {await act(async () => {instance.unmount(); await app.close();}); await instance.waitUntilExit();}
      finally {input.destroy(); output.destroy(); applyTheme(oldTheme); await rm(root, {recursive: true, force: true});}},
  };
}

test('statusbar is discoverable through command completion and public help', () => {
  assert.ok(commandSuggestions({text: '/statusb', cursor: 8}, emptyCommandContext).some(item => item.label === '/statusbar'));
  assert.match(commandHelp(), /\/statusbar/);
});

test('settings and read-only config are separately discoverable in catalog, help and completion', () => {
  for (const name of ['settings', 'config']) {
    const definition = commandCatalog.find(command => command.name === name);
    assert.ok(definition);
    assert.equal(definition.usage, '/' + name);
    const prefix = '/' + name.slice(0, 4);
    const suggestion = commandSuggestions({text: prefix, cursor: prefix.length}, emptyCommandContext)
      .find(item => item.label === '/' + name);
    assert.ok(suggestion);
    assert.equal(suggestion.description, definition.description);
    assert.equal(suggestion.replacement, '/' + name);
    assert.equal(suggestion.execute, true);
  }
  assert.match(commandHelp(), /\/settings: .*Appearance.*status bar/);
  assert.match(commandHelp(), /\/config: .*effective.*configuration.*read-only/);
});

test('typing the discoverable statusbar command opens the live editor without a model request', async () => {
  const f = await fixture();
  try {
    await f.key('/statusb'); await f.until(/\/statusbar/); assert.match(f.text(), /\/statusbar/);
    await f.key('\t'); await f.key('\r');
    await f.until(/Style: Pipes/); await f.until(/Preview/); assert.match(f.text(), /Style: Pipes/); assert.match(f.text(), /Preview/);
    assert.doesNotMatch(f.text(), /Style: Native/); assert.equal(f.calls, 0);
    await f.key('\x1b'); await waitFor(() => f.app.surfaces.getSnapshot(), snapshot => snapshot === null, {label: 'statusbar surface closed'});
  } finally {await f.close();}
});

test('style, palette and modules preview locally; rapid edits accumulate and Escape discards the whole composition', async () => {
  const f = await fixture();
  try {
    const original = f.app.statusbar.getSnapshot();
    await f.open('/statusbar');
    await f.key('\x1b[C\x1b[C'); assert.match(f.text(), /Style: Pipes/, 'Two rapid cycles return to Pipes');
    await f.key('\x1b[C'); assert.match(f.text(), /Style: Starship/);
    await f.key('\x1b[B'); await f.key('\x1b[C\x1b[C'); assert.match(f.text(), /Palette: dracula/);
    await f.key('\x1b[B'); await f.key('\x1b[B'); await f.key(' '); await f.key('\x1b[C');
    assert.ok(f.text().indexOf('[■] Model') < f.text().indexOf('[ ] Role'), 'Reordering affects the selected module, not Style or Palette');
    assert.match(f.text(), /\ue0b0|\ue0b6/, 'Preview uses actual Starship framing');
    assert.equal(f.app.statusbar.getSnapshot(), original, 'Preview never publishes live preferences');
    await assert.rejects(readFile(f.path, 'utf8'), {code: 'ENOENT'});
    await f.key('\x1b'); await f.open('/statusbar');
    assert.match(f.text(), /Style: Pipes/); assert.match(f.text(), /Palette: theme/);
    assert.ok(f.text().indexOf('[■] Role') < f.text().indexOf('[■] Model'));
    assert.equal(f.calls, 0);
  } finally {await f.close();}
});

test('settings saves appearance and motion through the data-driven page and keeps the statusbar sub-page separate', async () => {
  const f = await fixture();
  try {
    await f.open('/settings');
    const page = f.app.surfaces.getSnapshot(); assert.ok(page?.kind === 'settings');
    assert.match(f.text(), /Settings/); assert.match(f.text(), /Appearance/); assert.match(f.text(), /Animations/);
    await f.key('\x1b[C');
    const themeDraft = f.text().match(/‹ (\S+) ›/)?.[1]; assert.ok(themeDraft);
    await f.key('\x1b[B'); await f.key('\x1b[C');
    await f.key('\x1b[B'); await f.key('\x1b[D');
    assert.match(f.text(), /1? ?unsaved/); assert.match(f.text(), /\[ \]/);
    await f.key('\r');
    assert.equal(f.app.surfaces.getSnapshot(), null, 'Enter saves and closes with a receipt');
    assert.ok(f.app.store.getSnapshot().messages.some(message => message.text === 'Settings saved'));
    const ui = JSON.parse(await readFile(f.uiPath, 'utf8'));
    assert.equal(ui.theme, themeDraft); assert.equal(ui.cursor, 'Underline _');
    const saved = JSON.parse(await readFile(f.path, 'utf8'));
    assert.equal(saved.motion, false); assert.equal(f.app.statusbar.getSnapshot().motion, false);
    assert.equal(f.calls, 0); assert.equal(f.networkCalls, 0);
  } finally {await f.close();}
});

test('config is read-only: edit/save inputs and forged toggle saves have no persistence or receipt effects', async () => {
  const f = await fixture();
  try {
    const before = f.app.statusbar.getSnapshot(), messages = f.app.store.getSnapshot().messages;
    await f.open('/config');
    const page = f.app.surfaces.getSnapshot(); assert.ok(page?.kind === 'page');
    assert.equal(page.title, 'Effective Configuration');
    assert.equal(page.initialTab, 'config');
    assert.deepEqual(page.tabs.map(tab => tab.id), ['config']);
    const tab = page.tabs[0]!;
    assert.equal(tab.toggles, undefined); assert.equal(tab.statusbar, undefined);
    assert.match(tab.lines.join('\n'), /Model: test-model/);
    assert.match(tab.lines.join('\n'), /Execution Limits/);
    assert.match(f.text(), /Effective Configuration/);
    assert.doesNotMatch(f.text(), /Theme preset:|Cursor style:|UI animations|Enter (Save|Apply)/);
    await f.key('\x1b[C'); await f.key(' '); await f.key('\r'); await f.key('\t');
    await act(async () => {
      await f.app.surfaces.saveToggles(page.id, 'config', [{id: 'motion', enabled: false}]);
      await f.app.surfaces.saveToggles(page.id, 'settings', [{id: 'motion', enabled: false}]);
      await f.app.surfaces.saveToggles(page.id, 'statusbar', []);
    });
    assert.equal(f.app.surfaces.getSnapshot(), page, 'Read-only input never invokes a save or changes the page');
    assert.equal(f.app.statusbar.getSnapshot(), before);
    assert.deepEqual(f.app.store.getSnapshot().messages, messages, 'Inspection emits no settings-saved receipt');
    await assert.rejects(readFile(f.path, 'utf8'), {code: 'ENOENT'});
    await assert.rejects(readFile(f.uiPath, 'utf8'), {code: 'ENOENT'});
    await f.key('\x1b'); assert.equal(f.app.surfaces.getSnapshot(), null);
    assert.equal(f.calls, 0); assert.equal(f.networkCalls, 0);
  } finally {await f.close();}
});

test('failed composition save retains the exact draft and original file, then retry saves appearance and modules together', async () => {
  const f = await fixture();
  try {
    await act(async () => {await f.app.statusbar.save(defaultStatusbar);});
    const original = await readFile(f.path, 'utf8'), before = f.app.statusbar.getSnapshot();
    await f.open('/statusbar'); await f.key('\x1b[C');
    await f.key('\x1b[B\x1b[B\x1b[B'); await f.key(' ');
    await writeFile(f.path, '{broken');
    await f.key('\r');
    const failed = f.app.surfaces.getSnapshot(); assert.equal(failed?.kind, 'page');
    assert.ok(failed?.kind === 'page' && failed.error);
    assert.match(f.text(), /Style: Starship/); assert.match(f.text(), /\[ \] Role/);
    assert.equal(f.app.statusbar.getSnapshot(), before); assert.equal(await readFile(f.path, 'utf8'), '{broken');
    await writeFile(f.path, original); await f.key('\r');
    assert.equal(f.app.surfaces.getSnapshot(), null);
    const saved = JSON.parse(await readFile(f.path, 'utf8'));
    assert.equal(saved.style, 'starship'); assert.equal(saved.modules.find((item: {id: string}) => item.id === 'role').enabled, false);
    assert.equal(f.calls, 0);
  } finally {await f.close();}
});

test('mouse controls match keyboard and narrow layouts retain an editable module instead of clipping it away', async () => {
  const f = await fixture();
  try {
    await f.open('/statusbar'); await f.clickLabel('Style:'); assert.match(f.text(), /Style: Starship/);
    await f.clickLabel('Style:', 94); assert.match(f.text(), /Style: Pipes/, 'Left chevron cycles backward');
    await f.clickLabel('Palette:'); assert.match(f.text(), /Palette: gruvbox/);
    await f.key('\x1b[B'); await f.key('\x1b[B');
    await f.resize(32, 10); assert.match(f.text(), /\[■\] Role/);
    await f.resize(24, 6); assert.match(f.text(), /\[■\] Role/);
    await f.key(' '); await f.resize(100, 24); assert.match(f.text(), /\[ \] Role/);
    assert.equal(f.app.statusbar.getSnapshot().modules[0]?.enabled, true, 'Mouse and resize edits remain local until saved');
    await f.resize(16, 6); await f.clickLabel('[ ]', 11);
    await f.resize(100, 24);
    assert.match(f.text(), /\[■\] Role/, 'When chevrons are hidden, the right side of a module row toggles rather than reordering');
  } finally {await f.close();}
});

test('statusbar sub-page of /settings takes the mouse: the row opens it, wheel selects rows, Esc returns', async () => {
  const f = await fixture();
  try {
    await f.open('/settings');
    const click = async (x: number, y: number) => {await f.key(`\x1b[<0;${x + 1};${y + 1}M`); await f.key(`\x1b[<0;${x + 1};${y + 1}m`);};
    await f.key('\x1b[F'); await f.key('\x1b[A'.repeat(3));
    const row = f.text().split('\n').findIndex(line => line.includes('Status bar')); assert.ok(row >= 0, 'Pages row is scrolled into view');
    await click(5, row);
    assert.match(f.text(), /Style:/, 'clicking the Status bar row opens the editor');
    const style = f.text().split('\n').findIndex(line => line.includes('Style:'));
    await f.key(`\x1b[<65;11;${style + 1}M`); assert.match(f.text(), /❯ Palette:/, 'wheel down selects the next row');
    await f.key(`\x1b[<64;11;${style + 1}M`); assert.match(f.text(), /❯ Style:/, 'wheel up selects the previous row');
    await f.key('\x1b'); assert.match(f.text(), /❯ Status bar/, 'Esc returns to Settings with the row still selected');
    assert.equal(f.app.surfaces.getSnapshot()?.kind, 'settings');
  } finally {await f.close();}
});
