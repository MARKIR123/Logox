import test from 'node:test';
import assert from 'node:assert/strict';
import {commandCatalog, commandHelp, emptyCommandContext} from '../src/commands.js';
import {commandSuggestions} from '../src/tui/commands/completion.js';
import {act} from 'react';
import {PassThrough} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
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
  const config = await loadConfig(root, {provider: {model: 'test-model', context_window: 8192}}, {}, root, root);
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
        if (surface?.kind !== 'page' || !surface.saving) break;
        if (round === 199) throw new Error('Configuration save did not settle');
        await delay(10);
      }
    }
  }); await flush();};
  await flush();
  return {app, output, path, uiPath: join(root, '.logox', 'ui-preferences.json'), key, flush, text: () => output.lines.join('\n'),
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
  assert.match(commandHelp(), /\/settings: .*theme.*cursor.*animations.*statusbar/);
  assert.match(commandHelp(), /\/config: .*effective.*configuration.*read-only/);
});

test('typing the discoverable statusbar command opens the live editor without a model request', async () => {
  const f = await fixture();
  try {
    await f.key('/statusb'); assert.match(f.text(), /\/statusbar/);
    await f.key('\t'); await f.key('\r');
    assert.match(f.text(), /Style: Pipes/); assert.match(f.text(), /Preview/);
    assert.doesNotMatch(f.text(), /Style: Native/); assert.equal(f.calls, 0);
    await f.key('\x1b'); assert.equal(f.app.surfaces.getSnapshot(), null);
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
    await f.key('\x1b[B'); await f.key(' '); await f.key('\x1b[C');
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

test('settings persists appearance and motion while retaining the page and other tab drafts across saves', async () => {
  const f = await fixture();
  try {
    await f.open('/settings');
    const page = f.app.surfaces.getSnapshot(); assert.ok(page?.kind === 'page');
    assert.deepEqual(page.tabs.map(tab => tab.id), ['settings', 'statusbar']);
    await f.key('\x1b[C');
    const themeDraft = f.text().match(/Theme preset: (\S+)/)?.[1]; assert.ok(themeDraft);
    await f.key('\x1b[B'); await f.key('\x1b[C');
    await f.key('\x1b[B'); await f.key('\x1b[D');
    assert.match(f.text(), /\[ \] UI animations/);
    await f.key('\t'); await f.key('\x1b[B'); await f.key('\x1b[C');
    assert.match(f.text(), /Style: Starship/);
    await act(async () => {f.app.store.message(f.app.sessionId, 'logox', 'assistant', 'Background refresh');}); await f.flush();
    assert.match(f.text(), /Style: Starship/, 'Background refresh does not overwrite the local draft');
    await f.key('\r');
    assert.equal(f.app.surfaces.getSnapshot()?.id, page.id, 'Applying statusbar retains the same settings page');
    assert.equal(f.app.statusbar.getSnapshot().style, 'starship');
    await f.key('\x1b[B'); await f.key('\x1b[C');
    assert.match(f.text(), /Palette: gruvbox/);
    await f.key('\t'); assert.equal(f.text().match(/Theme preset: (\S+)/)?.[1], themeDraft);
    assert.match(f.text(), /Cursor style: Underline/); assert.match(f.text(), /\[ \] UI animations/);
    await f.key('\r'); assert.equal(f.app.surfaces.getSnapshot()?.id, page.id, 'Applying settings retains the same page');
    assert.deepEqual(JSON.parse(await readFile(f.uiPath, 'utf8')), {version: 1, theme: themeDraft, cursor: 'Underline _'});
    const saved = JSON.parse(await readFile(f.path, 'utf8'));
    assert.equal(saved.motion, false); assert.equal(saved.style, 'starship'); assert.equal(saved.colorScheme, 'theme');
    assert.equal(f.app.statusbar.getSnapshot().motion, false);
    await f.key('\t'); assert.match(f.text(), /Palette: gruvbox/, 'Settings save preserves the unsaved statusbar draft');
    await f.key('\x1b'); assert.equal(f.app.surfaces.getSnapshot(), null);
    await f.open('/settings');
    assert.equal(f.text().match(/Theme preset: (\S+)/)?.[1], themeDraft);
    assert.match(f.text(), /Cursor style: Underline/); assert.match(f.text(), /\[ \] UI animations/);
    await f.key('\t'); assert.match(f.text(), /Style: Starship/); assert.match(f.text(), /Palette: theme/, 'Escape discarded only the unsaved palette');
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
    await f.key('\x1b[B\x1b[B'); await f.key(' ');
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
    await f.key('\x1b[B');
    await f.resize(32, 10); assert.match(f.text(), /\[■\] Role/);
    await f.resize(24, 6); assert.match(f.text(), /\[■\] Role/);
    await f.key(' '); await f.resize(100, 24); assert.match(f.text(), /\[ \] Role/);
    assert.equal(f.app.statusbar.getSnapshot().modules[0]?.enabled, true, 'Mouse and resize edits remain local until saved');
    await f.resize(16, 6); await f.clickLabel('[ ]', 11);
    await f.resize(100, 24);
    assert.match(f.text(), /\[■\] Role/, 'When chevrons are hidden, the right side of a module row toggles rather than reordering');
  } finally {await f.close();}
});
