import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import chalk from 'chalk';
import {act, useSyncExternalStore, type ReactElement} from 'react';
import {setTimeout as delay} from 'node:timers/promises';
import {Text} from 'ink';
import {renderTerminal as render} from '../src/tui/terminal/terminal.js';
import {TerminalScreen} from './terminal-screen.js';
import {MouseHost, type SgrMouseEvent} from '../src/tui/terminal/mouse.js';
import {ThemePage} from '../src/tui/panels/theme-page.js';
import {themeLayout, stepSelectable, normalizeSelection} from '../src/tui/panels/theme-layout.js';
import {directRows, rowText, sampleRows, sampleScene} from '../src/tui/panels/theme-sample.js';
import {sample} from '../src/tui/panels/theme-sample-data.js';
import {CommandSurfaces} from '../src/commands/surfaces.js';
import {applyTheme, palette} from '../src/config/theme-palette.js';
import {applyThemePreset, listThemes, loadThemePresets, themeListing} from '../src/config/theme-presets.js';
import {UiPreferences} from '../src/config/ui-settings.js';
import {commandCatalog, commandHelp} from '../src/commands.js';
import type {CommandResult} from '../src/runtime/command-surface.js';

Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
class Input extends PassThrough {isTTY = true; setRawMode(): this {return this;} ref(): this {return this;} unref(): this {return this;}}
chalk.level = 3;

const night = {base: 'logox-dark', colors: {accent: '#112233', bg: '#010203', fg: '#F0F0F0', muted: '#304050'}};
const plain = {base: 'logox-dark', colors: {accent: '#445566'}};

/** The /theme page on a real CommandSurfaces, a temporary home with user themes, and a recorded preferences file. */
async function setup(options: {columns?: number; rows?: number; users?: Record<string, string | object>} = {}) {
  const {columns = 120, rows = 30, users = {'my-night': night, 'my-plain': plain}} = options;
  const root = await mkdtemp(join(tmpdir(), 'logox-theme-page-'));
  await mkdir(join(root, '.logox', 'themes'), {recursive: true});
  for (const [name, content] of Object.entries(users)) await writeFile(join(root, '.logox', 'themes', name + '.json'), typeof content === 'string' ? content : JSON.stringify(content));
  loadThemePresets(root);
  const original = {...palette};
  const palettes: Record<string, Record<string, string>> = {};
  for (const theme of listThemes()) palettes[theme.name] = {...applyThemePreset(theme.name)};
  applyTheme({...original});
  const ui = new UiPreferences(root); await ui.load();
  const prefsFile = join(root, '.logox', 'ui-preferences.json');
  const done: CommandResult[] = [];
  const surfaces = new CommandSurfaces(result => {done.push(result);});
  const open = () => surfaces.openTheme({themes: themeListing(), current: ui.get().theme}, {
    apply: name => {applyThemePreset(name);},
    save: async name => {await ui.save({theme: name}); applyThemePreset(name);},
  });
  const input = new Input(), output = new TerminalScreen(); output.columns = columns; output.rows = rows;
  const listeners = new Set<(event: SgrMouseEvent) => void>();
  let size = {columns, rows};
  function Host() {
    const surface = useSyncExternalStore(surfaces.subscribe, surfaces.getSnapshot);
    if (surface?.kind !== 'theme') return <Text>closed</Text>;
    return <ThemePage key={surface.id} themes={surface.themes} current={surface.current} width={size.columns} height={size.rows} saving={surface.saving ?? false} error={surface.error ?? ''}
      onPreview={name => surfaces.previewTheme(surface.id, name)} onChoose={name => {void surfaces.chooseTheme(surface.id, name);}} onCancel={() => surfaces.cancel()}/>;
  }
  const element = (): ReactElement => <MouseHost subscribe={handler => {listeners.add(handler); return () => {listeners.delete(handler);};}} color={palette.accent}><Host/></MouseHost>;
  let instance!: ReturnType<typeof render>;
  open();
  await act(async () => {instance = render(element(), {stdin: input, stdout: output, stderr: output, interactive: true, alternateScreen: true, patchConsole: false, exitOnCtrlC: false, maxFps: 100});});
  const flush = async () => {await act(async () => {await instance.waitUntilRenderFlush();});};
  const key = async (value: string) => {await act(async () => {input.write(value); await delay(value === '\x1b' ? 40 : 5);}); await flush();};
  const send = async (button: number, x: number, y: number, action: SgrMouseEvent['action']) => {
    await act(async () => {for (const listener of listeners) listener({button, x, y, action}); await delay(5);}); await flush();
  };
  await flush();
  /** The list row of a theme (the header and the sample may mention its name too). */
  const rowOf = (name: string) => {
    const pattern = new RegExp('^ {2}(?:❯| ) ' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const at = output.lines.findIndex(line => pattern.test(line)); assert.ok(at >= 0, 'list row of ' + name + '\n' + output.lines.join('\n')); return at;
  };
  return {
    root, ui, surfaces, done, palettes, original, prefsFile, output, key, rowOf, open, flush,
    screen: () => output.lines.join('\n'),
    move: (x: number, y: number) => send(0, x, y, 'move'),
    click: async (x: number, y: number) => {await send(0, x, y, 'press'); await send(0, x, y, 'release');},
    wheel: (x: number, y: number, direction: 1 | -1) => send(0, x, y, direction > 0 ? 'wheel_down' : 'wheel_up'),
    resize: async (nextColumns: number, nextRows: number) => {size = {columns: nextColumns, rows: nextRows}; output.resize(nextColumns, nextRows); await act(async () => {instance.rerender(element());}); await flush();},
    close: async () => {
      await act(async () => {instance.unmount();}); await instance.waitUntilExit(); input.destroy(); output.destroy();
      applyTheme({...original}); loadThemePresets(join(root, 'nowhere')); await rm(root, {recursive: true, force: true});
    },
  };
}
const names = () => listThemes().map(theme => theme.name);
const sameTokens = (actual: Record<string, string>, expected: Record<string, string>, label: string) => assert.deepEqual({...actual}, {...expected}, label);

test('the list shows shipped themes first, then user themes marked · user, the saved theme with a check, and the cursor on it', async () => {
  const f = await setup();
  try {
    const text = f.screen();
    const shipped = listThemes().filter(theme => theme.source === 'shipped').map(theme => theme.name);
    assert.deepEqual(themeListing().map(theme => theme.name), [...shipped, 'my-night', 'my-plain'], 'shipped themes in their existing order, then user themes');
    assert.ok(shipped.every((name, index) => index === 0 || text.indexOf(shipped[index - 1]!) < text.indexOf(name)));
    assert.ok(text.indexOf(shipped.at(-1)!) < text.indexOf('my-night') && text.indexOf('my-night') < text.indexOf('my-plain'));
    assert.match(f.output.lines[f.rowOf('my-night')]!, /my-night · user/); assert.doesNotMatch(f.output.lines[f.rowOf('nord-polar')]!, /user/);
    assert.match(f.output.lines[f.rowOf('logox-dark')]!, /^ {2}❯ logox-dark +✓ /, 'the saved theme is checked and holds the cursor');
    assert.match(text, /Theme · current/); assert.match(text, /↑↓ preview · Enter use · Esc cancel/);
  } finally {await f.close();}
});

test('a theme file that fails to load is listed as unavailable with its reason, is skipped by the cursor and ignores clicks', async () => {
  const f = await setup({users: {'my-plain': plain, broken: '{"colors": {'}});
  try {
    const listing = themeListing(), broken = listing.find(theme => theme.name === 'broken')!;
    assert.ok(broken.unavailable && broken.source === 'user'); assert.equal(listing.at(-1)!.name, 'broken', 'unavailable files close the list');
    const row = f.rowOf('broken'); assert.match(f.output.lines[row]!, /broken ✗ /);
    assert.equal(stepSelectable(listing, listing.length - 2, 1), 0, 'the cursor wraps over the unavailable row');
    assert.equal(normalizeSelection(listing, listing.length - 1, 'logox-dark'), 0, 'an unavailable highlight falls back to the saved theme');
    await f.click(6, row); assert.equal(f.surfaces.getSnapshot()?.kind, 'theme', 'a click on an unavailable row does nothing');
    await f.move(6, row); assert.match(f.output.lines[f.rowOf('logox-dark')]!, /❯ logox-dark/, 'hover does not highlight it');
    sameTokens(palette, f.original, 'and nothing was previewed');
    await f.key('\x1b[A'); assert.match(f.screen(), /❯ my-plain/, 'Up from the first row wraps to the last usable theme');
  } finally {await f.close();}
});

test('moving the highlight applies the theme to the whole palette and writes nothing', async () => {
  const f = await setup();
  try {
    const order = names();
    await f.key('\x1b[B');
    sameTokens(palette, f.palettes[order[1]!]!, 'Down previews the second theme on every token');
    assert.match(f.screen(), new RegExp('Theme · previewing ' + order[1]));
    await f.key('\x1b[B'); sameTokens(palette, f.palettes[order[2]!]!, 'and the next one');
    await f.key('\x1b[F'); sameTokens(palette, f.palettes['my-plain']!, 'End previews the last theme');
    await f.key('\x1b[H'); sameTokens(palette, f.palettes[order[0]!]!, 'Home goes back to the first');
    await assert.rejects(readFile(f.prefsFile, 'utf8'), {code: 'ENOENT'}, 'the preferences file was never written');
    assert.deepEqual(f.done, [], 'no receipt, the page is still open');
  } finally {await f.close();}
});

test('Enter saves the highlighted theme through the preference file, keeps it applied and closes with a receipt', async () => {
  const f = await setup();
  try {
    await f.key('\x1b[B'); await f.key('\x1b[B');
    const chosen = names()[2]!;
    await f.key('\r');
    await delay(30); await f.flush();
    assert.equal(f.surfaces.getSnapshot(), null, 'the page closed');
    assert.equal(JSON.parse(await readFile(f.prefsFile, 'utf8')).theme, chosen);
    sameTokens(palette, f.palettes[chosen]!, 'the saved theme stays on the palette');
    assert.deepEqual(f.done.map(result => result.message), ['Theme set to ' + chosen]);
    // Closing now must not roll the saved theme back.
    f.surfaces.close(); sameTokens(palette, f.palettes[chosen]!, 'a later close leaves a saved theme alone');
  } finally {await f.close();}
});

test('Esc puts the original palette back token by token', async () => {
  const f = await setup();
  try {
    await f.key('\x1b[B'); await f.key('\x1b[B'); await f.key('\x1b[B');
    assert.notDeepEqual({...palette}, f.original);
    await f.key('\x1b');
    assert.equal(f.surfaces.getSnapshot(), null); sameTokens(palette, f.original, 'every token is back');
    await assert.rejects(readFile(f.prefsFile, 'utf8'), {code: 'ENOENT'});
    assert.deepEqual(f.done, []);
  } finally {await f.close();}
});

test('every other way of closing restores too: cancel(), close() on shutdown, and reopening starts from the restored theme', async () => {
  const f = await setup();
  try {
    await f.key('\x1b[B'); assert.notDeepEqual({...palette}, f.original);
    f.surfaces.cancel(); sameTokens(palette, f.original, 'cancel() is the close path of the host, not a key handler');
    f.open(); await f.flush(); await f.key('\x1b[B'); await f.key('\x1b[B'); assert.notDeepEqual({...palette}, f.original);
    f.surfaces.close(); sameTokens(palette, f.original, 'the application closing restores the theme');
    await f.flush(); assert.match(f.screen(), /closed/);
    // A second restore is harmless, and a preview cannot start without an open page.
    f.surfaces.close(); f.surfaces.previewTheme('gone', names()[3]!); sameTokens(palette, f.original, 'nothing applies once the page is closed');
  } finally {await f.close();}
});

test('a failed save keeps the page and the preview, shows the reason, and Esc still restores', async () => {
  const f = await setup();
  try {
    await mkdir(join(f.root, '.logox', 'ui-preferences.json'), {recursive: true}); // a directory where the file belongs: the write fails
    await f.key('\x1b[B'); const previewed = {...palette};
    await f.key('\r'); await delay(60); await f.flush();
    const surface = f.surfaces.getSnapshot();
    assert.equal(surface?.kind, 'theme'); assert.ok(surface?.kind === 'theme' && surface.error && !surface.saving, 'the page reports why it was not saved');
    sameTokens(palette, previewed, 'the preview stays while the page is open');
    await f.key('\x1b'); sameTokens(palette, f.original, 'closing restores the original palette');
  } finally {await f.close();}
});

test('hovering a row previews it without choosing, and a click saves it', async () => {
  const f = await setup();
  try {
    const order = names(), target = order[3]!;
    const row = f.rowOf(target);
    await f.move(8, row);
    sameTokens(palette, f.palettes[target]!, 'the pointer over a row previews that theme'); assert.match(f.output.lines[f.rowOf(target)]!, /^ {2}❯ /, 'and the row holds the cursor');
    assert.equal(f.surfaces.getSnapshot()?.kind, 'theme'); await assert.rejects(readFile(f.prefsFile, 'utf8'), {code: 'ENOENT'});
    await f.move(8, f.rowOf(order[5]!)); sameTokens(palette, f.palettes[order[5]!]!, 'moving on previews the next one');
    await f.click(8, f.rowOf(order[4]!)); await delay(30); await f.flush();
    assert.equal(f.surfaces.getSnapshot(), null, 'the click chose and closed');
    assert.equal(JSON.parse(await readFile(f.prefsFile, 'utf8')).theme, order[4]);
    sameTokens(palette, f.palettes[order[4]!]!, 'the clicked theme is applied');
  } finally {await f.close();}
});

test('the footer buttons run the keyboard commands: Esc cancel restores, Enter use saves', async () => {
  const f = await setup();
  try {
    await f.key('\x1b[B');
    const footer = f.output.lines.findIndex(line => line.includes('Esc cancel'));
    await f.move(f.output.lines[footer]!.indexOf('↑↓ preview') + 2, footer);
    await f.click(f.output.lines[footer]!.indexOf('↑↓ preview') + 2, footer); sameTokens(palette, f.palettes[names()[2]!]!, '↑↓ preview is a button');
    await f.click(f.output.lines[footer]!.indexOf('Esc cancel') + 2, footer);
    assert.equal(f.surfaces.getSnapshot(), null); sameTokens(palette, f.original, 'Esc cancel restores');
    f.open(); await f.flush(); await f.key('\x1b[B');
    await f.click(f.output.lines[footer]!.indexOf('Enter use') + 2, footer); await delay(30); await f.flush();
    assert.equal(JSON.parse(await readFile(f.prefsFile, 'utf8')).theme, names()[1]);
  } finally {await f.close();}
});

test('user themes from the home directory appear and preview', async () => {
  const f = await setup();
  try {
    await f.click(8, f.rowOf('my-night'));
    await delay(30); await f.flush();
    assert.equal(palette.accent, '#112233'); assert.equal(palette.bg, '#010203'); assert.equal(JSON.parse(await readFile(f.prefsFile, 'utf8')).theme, 'my-night');
    f.open(); await f.flush();
    assert.match(f.output.lines[f.rowOf('my-night')]!, /❯ my-night · user +✓/, 'reopening starts on the saved user theme');
    await f.key('\x1b[B'); assert.equal(palette.accent, '#445566', 'the next user theme previews its own colours');
  } finally {await f.close();}
});

test('the wheel scrolls a list longer than the viewport, one preview at a time', async () => {
  const f = await setup({columns: 120, rows: 12, users: {'my-night': night, 'my-plain': plain, 'zz-a': plain, 'zz-b': night}});
  try {
    const layout = themeLayout({themes: themeListing(), current: 'logox-dark', view: {selected: 0, scroll: 0, sampleScroll: 0}, width: 120, height: 12, y: 0, saving: false, error: ''});
    assert.equal(layout.mode, 'list'); assert.ok(themeListing().length > layout.listRows, 'more themes than rows');
    assert.doesNotMatch(f.screen(), /zz-b/, 'the last theme starts below the viewport');
    for (let step = 0; step < 13; step++) await f.wheel(30, 4, 1);
    assert.match(f.screen(), /❯ zz-b/, 'wheel down scrolled to the last theme'); assert.doesNotMatch(f.screen(), /^ {2}(?:❯| ) logox-dark/m, 'and the first one scrolled out');
    sameTokens(palette, f.palettes['zz-b']!, 'each wheel step previewed its theme');
    for (let step = 0; step < 13; step++) await f.wheel(30, 4, -1);
    assert.match(f.screen(), /^ {2}❯ logox-dark/m); assert.doesNotMatch(f.screen(), /zz-b/);
  } finally {await f.close();}
});

test('layout tiers: wide puts the list beside the sample, narrow stacks them, very narrow or short shows the list alone', async () => {
  const themes = themeListing(), view = {selected: 0, scroll: 0, sampleScroll: 0};
  const plan = (width: number, height: number) => themeLayout({themes, current: 'logox-dark', view, width, height, y: 0, saving: false, error: ''});
  assert.equal(plan(120, 30).mode, 'wide'); assert.equal(plan(96 + 4, 30).mode, 'wide');
  assert.equal(plan(70, 30).mode, 'stacked'); assert.equal(plan(70, 14).mode, 'list', 'short: list only'); assert.equal(plan(44, 30).mode, 'list', 'very narrow: list only');
  for (const [width, height] of [[120, 30], [70, 30], [44, 30], [120, 9], [20, 6]] as const) {
    const {rows} = plan(width, height), body = Math.max(0, height - (height >= 4 ? 4 : 3));
    assert.equal(rows.length, body, width + 'x' + height + ' fills the body'); assert.ok(rows.every(row => row.reduce((sum, seg) => sum + [...seg.text].length, 0) <= width));
  }
  const wide = await setup({columns: 120, rows: 30});
  try {
    const lines = wide.output.lines, at = lines.findIndex(line => line.includes('Fix the failing login test'));
    assert.ok(at >= 0 && lines[at]!.indexOf('Fix the failing login test') > lines[wide.rowOf('logox-dark')]!.indexOf('logox-dark') + 20, 'wide: the sample is to the right of the list');
    assert.match(wide.screen(), /Legible|below threshold/);
    await wide.resize(70, 30);
    const stacked = wide.output.lines, listRow = wide.rowOf('logox-dark'), sampleRow = stacked.findIndex(line => line.includes('Fix the failing login test'));
    assert.ok(sampleRow > listRow, 'stacked: the sample is below the list'); assert.ok(stacked[listRow]!.indexOf('logox-dark') < 10);
    await wide.resize(44, 30);
    assert.doesNotMatch(wide.screen(), /Fix the failing login test|Legible|below threshold/, 'very narrow: the list only'); assert.match(wide.screen(), /logox-dark/);
    await wide.key('\x1b[B'); sameTokens(palette, wide.palettes[names()[1]!]!, 'the list-only page still previews through its own colours');
    await wide.resize(120, 30); assert.match(wide.screen(), /Fix the failing login test/, 'growing back restores the sample');
  } finally {await wide.close();}
});

test('the legibility block sits under the sample and follows the highlighted theme', async () => {
  const f = await setup();
  try {
    assert.match(f.screen(), /(Legible|\d+ below threshold)\n/);
    for (const label of ['text ', 'muted ', 'muted on card', 'text on card', 'dream text', 'dream muted', 'selection', 'diff +', 'diff −', 'border']) assert.ok(f.screen().includes(label), label);
    const ratios = () => f.output.lines.map(line => /(?:^|\s)text +(\d+\.\d\d)/.exec(line)?.[1]).find(Boolean);
    const before = ratios(); assert.ok(before, 'the text pair shows its ratio');
    await f.key('\x1b[F'); // my-plain: accent only differs, text contrast equals logox-dark; my-night changes fg and bg
    await f.key('\x1b[A');
    assert.notEqual(ratios(), before, 'the numbers follow the highlighted theme (my-night has its own fg and bg)');
  } finally {await f.close();}
});

test('the sample contains every required region, from the real timeline where it can', () => {
  const rows = sampleRows(100), text = rows.map(rowText).join('\n');
  const regions: [string, RegExp][] = [
    ['user message', /Fix the failing login test and tell me what changed\./],
    ['Director speaker header and reply', /◈ Logox|Logox · /],
    ['Director reply sentence', /The retry loop never resets attempts, so the second login fails\./],
    ['running companion card: name, main title, subtitle', /Techne · Fix retry loop · Patching[^·]*· Edit\(src\/sample\/retry\.ts\)/],
    ['running companion card: clock', /14\.0s/],
    ['collapsed tool row', /▮ Glob\(src\/sample\/\*\*\/\*\.ts\) · 3 files/],
    ['expanded tool card', /▾ Edit\(src\/sample\/login\.ts\) · added 3 · removed 2/],
    ['diff gutter and lines', /\d +[−] {1,3}while \(!ok\) \{[\s\S]*\d +\+ {1,3}while \(!ok && attempts < MAX_ATTEMPTS\)/],
    ['search hit with a path', /src\/sample\/login\.ts +2 *\n[^\n]*12 +let attempts/],
    ['link', /https:\/\/example\.com\/docs\/retry/],
    ['dream card', /Anamnesis · Recapping the session/],
    ['success mark', /✓ Tests passed/], ['warning mark', /▲ One test skipped/], ['error mark', /✗ Build failed/],
    ['effort colours', /effort off low medium high max auto/], ['permission colours', /mode +default auto creative/],
    ['selection', / selected /], ['question prompt', /Which branch should I use\?/], ['secondary text on a card', /secondary text on the card/], ['composer', /❯ Ask Logox to continue…/],
  ];
  for (const [label, pattern] of regions) assert.match(text, pattern, label);
  assert.ok(rows.every(row => row.reduce((sum, seg) => sum + [...seg.text].length, 0) === 100), 'every row is exactly the sample width');
});

test('the sample is painted from palette tokens: diff, dream, card, question, selection, effort, permission, link and highlight', () => {
  applyThemePreset('logox-dark');
  const segs = sampleRows(100).flat(), has = (pick: (seg: (typeof segs)[number]) => boolean) => segs.some(pick);
  assert.ok(has(seg => seg.bg === palette.diffAddedBg && seg.color === palette.diffAdded), 'added line: text and background');
  assert.ok(has(seg => seg.bg === palette.diffRemovedBg && seg.color === palette.diffRemoved), 'removed line: text and background');
  assert.ok(has(seg => seg.color === palette.diffAddedGutter) && has(seg => seg.color === palette.diffRemovedGutter), 'both gutters');
  assert.ok(has(seg => seg.bg === palette.dreamCollapsed && seg.color === palette.dreamText), 'dream card text on dreamCollapsed');
  assert.ok(has(seg => seg.bg === palette.dreamCollapsed && seg.color === palette.dreamMuted), 'dream card status in dreamMuted');
  assert.ok(has(seg => seg.bg === palette.cardExpanded && seg.color === palette.muted), 'muted secondary text on cardExpanded');
  assert.ok(has(seg => seg.bg === palette.cardExpanded && seg.color === palette.question), 'question-coloured prompt');
  assert.ok(has(seg => seg.bg === palette.selectionBg && seg.color === palette.selectionFg), 'selection colours');
  for (const token of ['effortOff', 'effortLow', 'effortMedium', 'effortHigh', 'effortMax', 'effortAuto', 'permissionDefault', 'permissionAuto', 'permissionCreative', 'success', 'warning', 'error', 'composerFg', 'composerBorder', 'path', 'highlight', 'user'] as const)
    assert.ok(has(seg => seg.color === palette[token]), token + ' is drawn');
  assert.ok(has(seg => seg.color === palette.link && seg.underline === true), 'the link is underlined in the link colour');
  assert.ok(has(seg => seg.bg === palette.bg), 'on the theme background');
  assert.ok(sampleScene(100).some(row => row.animation?.clockStart !== undefined), 'the running card carries a live clock');
  assert.equal(directRows(40).length, 10);
  assert.ok(sample.efforts.length === 6 && sample.modes.length === 3);
});

test('the sample follows the palette: other themes change its colours, same width reuses the rows', () => {
  const original = {...palette};
  try {
    applyThemePreset('logox-dark'); const dark = sampleRows(90);
    assert.equal(sampleRows(90), dark, 'unchanged palette and width reuse the rows');
    const darkBg = palette.bg;
    const other = listThemes().find(theme => applyThemePreset(theme.name).bg !== darkBg);
    assert.ok(other, 'a shipped theme with another background exists'); applyThemePreset(other.name); const warm = sampleRows(90);
    assert.notEqual(warm, dark); assert.notEqual(palette.bg, darkBg);
    assert.ok(warm.flat().some(seg => seg.bg === palette.bg), 'the new background is on the sample'); assert.ok(!warm.flat().some(seg => seg.bg === darkBg), 'the old one is gone');
  } finally {applyTheme(original);}
});

test('the page and its sample use no colour literal: every colour comes from the palette', () => {
  const root = fileURLToPath(new URL('../../src/tui/panels/', import.meta.url));
  for (const file of ['theme-page.tsx', 'theme-layout.ts', 'theme-sample.ts', 'theme-sample-data.ts']) {
    const source = readFileSync(join(root, file), 'utf8');
    assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b/, file + ' has no hex colour'); assert.doesNotMatch(source, /\\x1b\[[\d;]*m/, file + ' has no SGR');
    assert.doesNotMatch(source, /(?:color|backgroundColor|bg)\s*[:=]\s*['"][a-z]+['"]/i, file + ' has no named colour');
  }
});

test('/theme is in the command catalog and help', () => {
  const command = commandCatalog.find(entry => entry.name === 'theme');
  assert.ok(command && command.usage === '/theme' && command.argument === 'none' && command.description.length > 10);
  assert.match(commandHelp(), /\/theme: /);
});
