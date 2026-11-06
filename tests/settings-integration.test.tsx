import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {act} from 'react';
import {PassThrough} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {mkdir, mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../src/application.js';
import {loadConfig} from '../src/config/config.js';
import {palette, applyTheme} from '../src/config/theme-palette.js';
import {applyUiSettings, defaultUiSettings} from '../src/config/ui-settings.js';
import {userLabel, setUserLabel} from '../src/config/user-profile.js';
import {waitFor} from './wait-for.js';
import {ApplicationStage} from '../src/tui/application.js';
import {renderTerminal} from '../src/tui/terminal/terminal.js';
import {TerminalScreen} from './terminal-screen.js';
Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
class Input extends PassThrough {isTTY = true; setRawMode(): this {return this;} ref(): this {return this;} unref(): this {return this;}}
afterEach(() => {applyUiSettings(defaultUiSettings);});

async function fixture(columns = 100, rows = 30, preferences?: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'logox-settings-app-'));
  if (preferences) {await mkdir(join(root, '.logox'), {recursive: true}); await writeFile(join(root, '.logox', 'ui-preferences.json'), JSON.stringify({version: 1, ...preferences}));}
  const oldTheme = {...palette};
  const config = await loadConfig(root, {permissions: {mode: 'default'}, provider: {model: 'test-model', context_window: 8192}}, {}, root, root);
  let calls = 0;
  const app = await createApplication({cwd: root, config, env: {}, resourceOptions: {home: root, boundary: root}, authPath: join(root, 'auth.json'),
    fetcher: async () => {throw new Error('No network request is allowed for settings');},
    provider: {respond: async () => {calls++; throw new Error('No model call is allowed for settings');}}});
  const input = new Input(), output = new TerminalScreen(); output.columns = columns; output.rows = rows;
  let instance!: ReturnType<typeof renderTerminal>;
  await act(async () => {instance = renderTerminal(<ApplicationStage application={app}/>, {stdin: input, stdout: output, stderr: output,
    interactive: true, alternateScreen: true, patchConsole: false, exitOnCtrlC: false, maxFps: 100});});
  const flush = async () => {await act(async () => {await instance.waitUntilRenderFlush();});};
  const settle = async () => {
    for (let round = 0; round < 200; round++) {
      const surface = app.surfaces.getSnapshot();
      if (surface?.kind !== 'settings' || !surface.saving) return;
      await delay(10);
    }
    throw new Error('Settings save did not settle');
  };
  const key = async (text: string) => {await act(async () => {input.write(text); await delay(text === '\x1b' ? 40 : 5); await settle();}); await flush();};
  await flush();
  return {app, root, key, flush, text: () => output.lines.join('\n'), lines: () => output.lines, output, uiPath: join(root, '.logox', 'ui-preferences.json'),
    get calls() {return calls;},
    open: async (command = '/settings') => {await act(async () => {await app.submit(command);}); await flush();},
    click: async (x: number, y: number) => {await key(`\x1b[<0;${x + 1};${y + 1}M`); await key(`\x1b[<0;${x + 1};${y + 1}m`);},
    close: async () => {
      try {await act(async () => {instance.unmount(); await app.close();}); await instance.waitUntilExit();}
      finally {input.destroy(); output.destroy(); applyTheme(oldTheme); setUserLabel(undefined); await rm(root, {recursive: true, force: true});}
    },
  };
}
const down = (count: number) => '\x1b[B'.repeat(count);

test('/settings and its legacy alias open the data-driven page, the old two-tab page is gone', async () => {
  const f = await fixture();
  try {
    for (const command of ['/settings', '/animations']) {
      await f.open(command);
      const surface = f.app.surfaces.getSnapshot(); assert.equal(surface?.kind, 'settings');
      assert.ok(surface?.kind === 'settings' && surface.items.length === 16 && surface.pages.map(page => page.id).join() === 'statusbar,permissions,models,shortcuts');
      assert.match(f.text(), /Settings/); assert.match(f.text(), /‹ logox-dark ›/); assert.doesNotMatch(f.text(), /Theme preset:|Cursor style:|UI animations/);
      await f.key('\x1b'); assert.equal(f.app.surfaces.getSnapshot(), null);
    }
    assert.equal(f.calls, 0);
  } finally {await f.close();}
});

test('Default mode and Your name save through the same stores as /permissions and /name, with a success receipt', async () => {
  const f = await fixture();
  try {
    await f.open();
    await f.key(down(15)); assert.match(f.text(), /❯ Default mode/);
    await f.key('\x1b[C'); assert.match(f.text(), /‹ auto ›/); assert.equal(f.app.permissions.mode, 'default', 'a draft changes nothing until saved');
    await f.key(down(0) + '\x1b[A'.repeat(6)); assert.match(f.text(), /❯ Your name/);
    await f.key('\r'); await f.key('Ada'); await f.key('\r'); assert.match(f.text(), /Settings · 2 unsaved/);
    await f.key('\x13');
    assert.equal(f.app.surfaces.getSnapshot(), null, 'saving closes the page');
    assert.equal(f.app.permissions.mode, 'auto');
    assert.equal(userLabel(), 'Ada', 'the live timeline label follows');
    assert.equal(JSON.parse(await readFile(join(f.root, '.logox', 'user-profile.json'), 'utf8')).name, 'Ada');
    const receipts = f.app.store.getSnapshot().messages.filter(message => message.systemPresentation === 'status' && message.text === 'Settings saved');
    assert.equal(receipts.length, 1);
    await f.open(); await f.key(down(15)); assert.match(f.text(), /❯ Default mode +‹ auto ›/, 'reopening reads the saved mode');
    assert.equal(f.calls, 0);
  } finally {await f.close();}
});

test('Theme previews live while a draft and reverts on discard; saving keeps it', async () => {
  const f = await fixture();
  try {
    const original = palette.bg, accent = palette.accent;
    await f.open();
    let changed = false;
    for (let step = 0; step < 6 && !changed; step++) {await f.key('\x1b[C'); changed = palette.bg !== original || palette.accent !== accent;}
    assert.ok(changed, 'the palette changed while the page was still a draft'); assert.match(f.text(), /1 unsaved/);
    await f.key('\x1b'); assert.match(f.text(), /Discard 1 unsaved change\?/);
    await f.key('n'); assert.ok(palette.bg !== original || palette.accent !== accent, 'keeping the draft keeps the preview');
    await f.key('\x1b'); await f.key('y');
    assert.equal(f.app.surfaces.getSnapshot(), null);
    assert.equal(palette.bg, original); assert.equal(palette.accent, accent, 'discard puts the saved theme back');
    await assert.rejects(readFile(f.uiPath, 'utf8'), {code: 'ENOENT'}, 'nothing was written');
    await f.open(); await f.key('\x1b[C'); const previewed = palette.accent;
    await f.key('\r');
    assert.equal(palette.accent, previewed);
    assert.equal(JSON.parse(await readFile(f.uiPath, 'utf8')).theme !== 'logox-dark', true);
  } finally {await f.close();}
});

/** Selects the n-th Pages row (End goes to the last one) and opens it with Enter. */
const openPage = async (f: Awaited<ReturnType<typeof fixture>>, index: number) => {
  await f.key('\x1b[F'); if (index < 3) await f.key('\x1b[A'.repeat(3 - index)); await f.key('\r');
};

test('every Pages row opens its sub-page and Esc returns to the settings', async () => {
  const f = await fixture();
  try {
    await f.open();
    const expectations: [string, RegExp][] = [
      ['Status bar', /Style:/], ['Permissions', /Mode +default +auto +creative/], ['Models & pricing', /No providers configured|anthropic|\(\d+\)|Source/], ['Shortcuts', /Composer/],
    ];
    for (const [index, [label, pattern]] of expectations.entries()) {
      await openPage(f, index);
      const surface = f.app.surfaces.getSnapshot(); assert.ok(surface?.kind === 'settings' && surface.sub, label + ' opened a sub-page');
      assert.match(f.text(), pattern, label); assert.doesNotMatch(f.text(), /Appearance/);
      await f.key('\x1b');
      const back = f.app.surfaces.getSnapshot(); assert.ok(back?.kind === 'settings' && !back.sub, label + ' returned');
      assert.match(f.text(), /Settings/); assert.match(f.text(), new RegExp('❯ ' + label.replace('&', "&") + ''));
    }
    await openPage(f, 3);
    assert.match(f.text(), /Ctrl\+T/); assert.match(f.text(), /rebinding/i);
    await f.key('\x1b');
  } finally {await f.close();}
});

test('the permissions sub-page edits the same mode as /permissions and returns afterwards', async () => {
  const f = await fixture();
  try {
    await f.open();
    await openPage(f, 1);
    assert.match(f.text(), /Mode +default +auto +creative/);
    await f.key('\x1b[C'); assert.match(f.text(), /unsaved/); await f.key('\r');
    await waitFor(async () => f.app.permissions.mode, mode => mode === 'auto', {label: 'mode saved'}); await f.flush();
    const surface = f.app.surfaces.getSnapshot(); assert.ok(surface?.kind === 'settings' && !surface.sub, 'saving a sub-page mode returns to the settings');
  } finally {await f.close();}
});

test('a failed save keeps the page, the drafts and shows the error; fixing the cause lets Enter retry', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'blocker'), 'x');
    await f.open();
    await f.key(down(1) + '\x1b[C');
    await act(async () => {await import('node:fs/promises').then(fs => fs.mkdir(join(f.root, '.logox'), {recursive: true}));});
    await writeFile(f.uiPath, '{broken');
    await f.key('\r');
    const failed = f.app.surfaces.getSnapshot(); assert.ok(failed?.kind === 'settings' && failed.error, 'the surface carries the error');
    assert.match(f.text(), /Cursor was not saved/); assert.match(f.text(), /1 unsaved/);
    assert.ok(f.app.store.getSnapshot().messages.some(message => message.systemEventKind === 'command_error' && /Cursor was not saved/.test(message.text)), 'the notification line gets the error');
    assert.equal(await readFile(f.uiPath, 'utf8'), '{broken', 'the original file is preserved');
    await writeFile(f.uiPath, JSON.stringify({version: 1, theme: 'logox-dark', cursor: 'Block █'}));
    await f.key('\r');
    assert.equal(f.app.surfaces.getSnapshot(), null);
    assert.equal(JSON.parse(await readFile(f.uiPath, 'utf8')).cursor, 'Underline _');
  } finally {await f.close();}
});

test('Start page: the welcome splash shows by default and plain text replaces it when turned off', async () => {
  const on = await fixture();
  try {assert.match(on.text(), /A terminal coding ensemble/); assert.match(on.text(), /Session /);} finally {await on.close();}
  const off = await fixture(100, 30, {startPage: false});
  try {
    assert.doesNotMatch(off.text(), /A terminal coding ensemble/); assert.doesNotMatch(off.text(), /[█▀▄]{4}/);
    assert.match(off.text(), /Session /, 'the welcome text is still there');
  } finally {await off.close();}
});

test('Tagline rotation and Emblem size reach the splash', async () => {
  const day = await fixture(100, 30, {tagline: 'rotate'});
  try {
    const today = new Date(), index = Math.floor(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) / 86_400_000);
    const {TAGLINES} = await import('../src/tui/appearance/emblem.js');
    assert.ok(day.text().includes(TAGLINES[index % TAGLINES.length]!), 'the splash shows today\'s tagline');
  } finally {await day.close();}
});

test('Enter key: newline mode keeps Enter in the composer and Ctrl+S sends the whole draft', async () => {
  const f = await fixture(100, 30, {enterKey: 'newline'});
  try {
    const sent = () => f.app.store.getSnapshot().messages.filter(message => message.role === 'user').map(message => message.text);
    await f.key('hi'); await f.key('\r'); await f.key('yo');
    assert.deepEqual(sent(), [], 'Enter only added a line');
    assert.match(f.text(), /Enter newline · Ctrl\+S send/);
    await f.key('\x13');
    await act(async () => {await delay(20);}); await f.flush();
    assert.deepEqual(sent(), ['hi\nyo'], 'Ctrl+S sent the two-line draft');
  } finally {await f.close();}
});

test('Enter key: the default still sends with Enter and breaks a line with Ctrl+J', async () => {
  const f = await fixture();
  try {
    const sent = () => f.app.store.getSnapshot().messages.filter(message => message.role === 'user').map(message => message.text);
    await f.key('a'); await f.key('\n'); await f.key('b'); await f.key('\r');
    await act(async () => {await delay(20);}); await f.flush();
    assert.deepEqual(sent(), ['a\nb']);
  } finally {await f.close();}
});
