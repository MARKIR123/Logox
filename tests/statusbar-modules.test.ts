import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StatusbarPreferences, statusbarIds, statusbarLabels, type StatusbarAppearance} from '../src/config/statusbar-preferences.js';
import {statusbarParts, statusbarText, extractStatusBarSlice} from '../src/tui/status/statusbar.js';
import type {StageStatus} from '../src/runtime/stage-status.js';
import {applyTheme, palette} from '../src/tui/appearance/theme.js';
import stringWidth from 'string-width';

const status: StageStatus = {ownerId: 'logox', name: 'Logox', state: 'running', model: {provider: 'demo', model: 'flash'}, effort: 'high', permission: 'auto', context: {tokens: 20, window: 100}};

test('legacy layouts retain order, enabled flags and motion while missing modules append disabled', async () => {
  const home = await mkdtemp(join(tmpdir(), 'logox-test-'));
  try {
    const path = join(home, 'statusbar.json');
    await writeFile(path, JSON.stringify({version: 1, modules: [{id: 'context', enabled: true}, {id: 'role', enabled: false}], motion: false}));
    const prefs = new StatusbarPreferences(path);
    await prefs.load();
    const snapshot = prefs.getSnapshot();
    assert.deepEqual(snapshot.modules.slice(0, 2), [{id: 'context', enabled: true}, {id: 'role', enabled: false}]);
    assert.equal(snapshot.modules.length, 10);
    assert.ok(snapshot.modules.slice(2).every(module => !module.enabled));
    assert.deepEqual(new Set(snapshot.modules.map(module => module.id)), new Set(statusbarIds));
    assert.equal(snapshot.motion, false);
    assert.equal(Reflect.get(snapshot, 'style'), 'pipes');
    assert.equal(Reflect.get(snapshot, 'colorScheme'), 'theme');
    await prefs.save(snapshot.modules, {style: 'starship', colorScheme: 'dracula'});
    await prefs.saveMotion(true);
    await prefs.save(snapshot.modules);
    const restored = new StatusbarPreferences(path); await restored.load();
    assert.deepEqual(restored.getSnapshot().modules, snapshot.modules);
    assert.equal(restored.getSnapshot().style, 'starship');
    assert.equal(restored.getSnapshot().colorScheme, 'dracula');
    assert.equal(restored.getSnapshot().motion, true);
  } finally {await rm(home, {recursive: true, force: true});}
});

test('Pipes returns the complete colored plan including subdued separators and a USED context gauge', () => {
  const parts = statusbarParts(status, 240);
  assert.equal(parts.map(part => part.text).join(''), statusbarText(status, 240));
  assert.ok(parts.some(part => part.text === ' | '));
  assert.ok(parts.every(part => part.color));
  assert.match(statusbarText(status, 240), /[\uE000-\uF8FF\u{F0000}-\u{FFFFD}]/u);
  assert.match(statusbarText(status, 240), /[■□]+.*20% USED/);
});

test('selection follows display cells without splitting CJK, emoji, combining marks or Powerline caps', () => {
  const text = '  中👩‍💻e\u0301\ue0b0  Z';
  assert.equal(extractStatusBarSlice(text, 2, 4), '中');
  assert.equal(extractStatusBarSlice(text, 4, 6), '👩‍💻');
  assert.equal(extractStatusBarSlice(text, 6, 7), 'e\u0301');
  assert.equal(extractStatusBarSlice(text, 7, 8), '\ue0b0');
  assert.equal(extractStatusBarSlice(text, 8, 2), '中👩‍💻e\u0301\ue0b0');
  assert.equal(extractStatusBarSlice(text, 3, 4), '');
  assert.equal(extractStatusBarSlice(text, 10, 11), 'Z');
});

test('appearance and reordered modules publish together only after persistence, independently of motion', async () => {
  const home = await mkdtemp(join(tmpdir(), 'logox-test-'));
  try {
    const path = join(home, 'statusbar.json'), prefs = new StatusbarPreferences(path);
    const before = prefs.getSnapshot(), observed: ReturnType<typeof prefs.getSnapshot>[] = [];
    const unsubscribe = prefs.subscribe(() => observed.push(prefs.getSnapshot()));
    const modules = [{id: 'project', enabled: true}, {id: 'model', enabled: false}];
    const saving = prefs.save(modules, {style: 'starship', colorScheme: 'gruvbox'});
    assert.strictEqual(prefs.getSnapshot(), before);
    await saving;
    assert.equal(observed.length, 1);
    assert.equal(observed[0]?.style, 'starship');
    assert.equal(observed[0]?.colorScheme, 'gruvbox');
    assert.deepEqual(observed[0]?.modules.slice(0, 2), modules);
    const layout = prefs.getSnapshot().modules;
    await Promise.all([prefs.saveMotion(false), prefs.save(layout, {style: 'pipes', colorScheme: 'dracula'}), prefs.saveMotion(true)]);
    await prefs.save(layout, prefs.getSnapshot());
    unsubscribe();
    const restored = new StatusbarPreferences(path); await restored.load();
    assert.deepEqual(restored.getSnapshot().modules, layout);
    assert.equal(restored.getSnapshot().style, 'pipes');
    assert.equal(restored.getSnapshot().colorScheme, 'dracula');
    assert.equal(restored.getSnapshot().motion, true);
    const saved = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(saved.version, 2);
    assert.equal(saved.style, 'pipes');
    assert.equal(saved.colorScheme, 'dracula');
  } finally {await rm(home, {recursive: true, force: true});}
});

test('failed writes never publish appearance or layout, and the save queue recovers', async () => {
  const home = await mkdtemp(join(tmpdir(), 'logox-test-'));
  try {
    const path = join(home, 'statusbar.json');
    await mkdir(path);
    const prefs = new StatusbarPreferences(path), before = prefs.getSnapshot();
    let notifications = 0; prefs.subscribe(() => notifications++);
    await assert.rejects(prefs.save([{id: 'cost', enabled: true}], {style: 'starship', colorScheme: 'dracula'}), /statusbar preferences/);
    assert.strictEqual(prefs.getSnapshot(), before);
    assert.equal(notifications, 0);
    await rm(path, {recursive: true});
    await prefs.saveMotion(false);
    const restored = new StatusbarPreferences(path); await restored.load();
    assert.equal(restored.getSnapshot().motion, false);
    assert.equal(restored.getSnapshot().style, 'pipes');
    assert.equal(restored.getSnapshot().colorScheme, 'theme');
    assert.deepEqual(restored.getSnapshot().modules, before.modules);
  } finally {await rm(home, {recursive: true, force: true});}
});

test('duplicate and unknown IDs reject without changing the last usable selection', async () => {
  const home = await mkdtemp(join(tmpdir(), 'logox-test-'));
  try {
    const prefs = new StatusbarPreferences(join(home, 'statusbar.json')), before = prefs.getSnapshot();
    await assert.rejects(prefs.save([{id: 'role', enabled: true}, {id: 'role', enabled: false}]));
    await assert.rejects(prefs.save([{id: 'native', enabled: true}]));
    assert.strictEqual(prefs.getSnapshot(), before);
    assert.ok(Object.values(statusbarLabels).every(label => /^[A-Za-z ]+$/.test(label)));
  } finally {await rm(home, {recursive: true, force: true});}
});

test('untrusted status values cannot inject ANSI, terminal controls or hidden directional text', () => {
  const dirty = '\u001b[31mVisible\u001b[0m\u001b]0;owned\u0007\r\n\t\u0000\u009b\u200e\u202e';
  const hostile: StageStatus = {ownerId: dirty, name: dirty, state: dirty, effort: dirty, permission: dirty,
    model: {provider: dirty, model: dirty}, session: dirty, project: dirty, cost: 1, costCurrency: dirty};
  const modules = statusbarIds.map(id => ({id, enabled: true}));
  for (const style of ['pipes', 'starship'] as const) {
    const text = statusbarText(hostile, 1000, modules, {style});
    assert.match(text, /Visible/);
    assert.doesNotMatch(text, /[\p{Cc}\u200e\u202e]/u);
    assert.doesNotMatch(text, /owned|\[31m/);
  }
});

test('every tiny width fits complete modules, Nerd icons and complete Starship framing', () => {
  const wide: StageStatus = {...status, name: '舞台👩‍💻', model: {provider: 'very-long-provider', model: 'extremely-long-model-name'}, session: '会话'};
  const modules = statusbarIds.map(id => ({id, enabled: true}));
  for (const style of ['pipes', 'starship'] as const) {
    for (let width = 0; width <= 160; width++) {
      const parts = statusbarParts(wide, width, modules, {style}), text = parts.map(part => part.text).join('');
      assert.ok(stringWidth(text) <= width, `${style}: ${width}: ${text}`);
      assert.equal(text, statusbarText(wide, width, modules, {style}));
      if (!text) continue;
      assert.match(text, /[\uE000-\uF8FF\u{F0000}-\u{FFFFD}]/u);
      if (style === 'starship') {
        assert.equal(parts[0]?.text, '\ue0b6');
        assert.equal(parts.at(-1)?.text, '\ue0b4');
        assert.ok(parts.some(part => part.backgroundColor));
        for (const part of parts.filter(part => part.text === '\ue0b0')) {
          assert.ok(part.color); assert.ok(part.backgroundColor);
        }
      } else {assert.ok(!text.endsWith(' | '));}
    }
  }
  assert.deepEqual(statusbarParts(wide, Number.NaN), []);
  assert.deepEqual(statusbarParts(wide, -1), []);
});

test('model compact variants retain meaningful model information instead of disappearing at narrow widths', () => {
  const model: StageStatus = {...status, model: {provider: 'anthropic', model: 'claude-opus-very-long-model'}};
  const modules = [{id: 'model', enabled: true}] as const;
  const compact = statusbarText(model, 22, modules);
  assert.ok(stringWidth(compact) <= 22);
  assert.match(compact, /claude/);
  assert.match(compact, /…/);
  assert.match(statusbarText(model, 80, modules), /anthropic\/claude-opus-very-long-model/);
});

test('live themes recolor segments while decorative palettes preserve role and permission semantics', () => {
  const original = {...palette};
  try {
    applyTheme({accent: '#123456', muted: '#234567', question: '#345678', permissionDefault: '#456789', permissionAuto: '#56789a', permissionCreative: '#6789ab'});
    const modules = [{id: 'role', enabled: true}, {id: 'model', enabled: true}, {id: 'permission', enabled: true}] as const;
    const pipes = statusbarParts(status, 240, modules);
    assert.equal(pipes[0]?.color, '#123456');
    assert.equal(pipes[1]?.color, '#234567');
    assert.equal(pipes[2]?.color, '#345678');
    for (const colorScheme of ['theme', 'gruvbox', 'dracula'] as const) {
      for (const permission of ['default', 'auto', 'creative'] as const) {
        const appearance: StatusbarAppearance = {style: 'pipes', colorScheme};
        const parts = statusbarParts({...status, permission}, 240, modules, appearance);
        assert.equal(parts[0]?.color, palette.accent);
        const expected = {default: '#456789', auto: '#56789a', creative: '#6789ab'}[permission];
        assert.equal(parts.at(-1)?.color, expected);
        const blocks = statusbarParts({...status, permission}, 240, modules, {...appearance, style: 'starship'});
        assert.equal(blocks[0]?.color, palette.accent);
        assert.ok(blocks.some(part => part.text.includes('Permission') && part.backgroundColor === expected));
      }
    }
    assert.equal(statusbarParts(status, 80, [{id: 'model', enabled: true}], {colorScheme: 'gruvbox'})[0]?.color, '#D3869B');
    assert.equal(statusbarParts(status, 80, [{id: 'model', enabled: true}], {colorScheme: 'dracula'})[0]?.color, '#BD93F9');
    applyTheme({question: '#abcdef'});
    assert.equal(statusbarParts(status, 80, [{id: 'model', enabled: true}])[0]?.color, '#abcdef');
  } finally {applyTheme(original);}
});

test('valid Actor identity overrides decorative schemes but malformed colors never reach Ink', () => {
  for (const style of ['pipes', 'starship'] as const) {
    for (const colorScheme of ['theme', 'gruvbox', 'dracula'] as const) {
      const parts = statusbarParts({...status, color: '#123abc'}, 80, [{id: 'role', enabled: true}], {style, colorScheme});
      assert.equal(parts[0]?.color, '#123abc');
      if (style === 'starship') assert.ok(parts.some(part => part.backgroundColor === '#123abc'));
      const invalid = statusbarParts({...status, color: '\u001b[31mred'}, 80, [{id: 'role', enabled: true}], {style, colorScheme});
      assert.equal(invalid[0]?.color, palette.accent);
    }
  }
  assert.match(statusbarText({...status, effort: '不支持'}, 80, [{id: 'effort', enabled: true}]), /Thinking unsupported/);
});

test('context never loses its usage gauge or USED label when compacted', () => {
  for (let width = 0; width < 60; width++) {
    const text = statusbarText(status, width, [{id: 'context', enabled: true}]);
    if (text) {assert.match(text, /[■□]/); assert.match(text, /20% USED/);}
  }
});

test('all ten IDs retain order and enabled state in either appearance', () => {
  const modules = [{id: 'project', enabled: true}, {id: 'cost', enabled: false}, {id: 'session', enabled: true}, {id: 'role', enabled: true}] as const;
  const full: StageStatus = {...status, project: '/work/Logox', session: 'unique-session', cost: 99};
  for (const style of ['pipes', 'starship'] as const) {
    const text = statusbarText(full, 240, modules, {style});
    assert.ok(text.indexOf('/work/Logox') < text.indexOf('unique-session'));
    assert.ok(text.indexOf('unique-session') < text.indexOf('Logox', text.indexOf('unique-session')));
    assert.doesNotMatch(text, /Cost/);
    assert.deepEqual(statusbarParts(full, 240, [], {style}), []);
  }
});
