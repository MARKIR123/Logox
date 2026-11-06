import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {structuredPatch} from 'diff';
import {RuntimeStore} from '../src/runtime/store.js';
import {Steps} from '../src/runtime/steps.js';
import {buildStageRows, stageFoldOpen} from '../src/tui/timeline/stage.js';
import {expandedTint, mixHex, TINT_STEPS} from '../src/tui/appearance/colors.js';
import {diffIsCompact, diffLines} from '../src/tui/timeline/tool-code.js';
import {EMBLEM_ETYMOLOGY, EMBLEM_TAGLINE, TAGLINES, splashLines, taglineFor} from '../src/tui/appearance/emblem.js';
import {palette} from '../src/tui/appearance/theme.js';
import {applyUiSettings, defaultUiSettings, uiSettings, uiSettingsRevision} from '../src/config/ui-settings.js';
import {themeRevision} from '../src/config/theme-palette.js';
import {NOTIFY_AFTER_MS, RoundNotifier, notificationSequence} from '../src/tui/terminal/notify.js';
import {consumeFocusReports, setTerminalFocus, terminalFocus} from '../src/tui/terminal/focus.js';
import {footerHints} from '../src/tui/status/notification-line.js';
import {commandCatalog} from '../src/commands.js';
import {shortcutGroups, shortcutRows} from '../src/commands/shortcuts.js';
import {modelLine, modelsRows} from '../src/commands/models-page.js';
import {loadConfig} from '../src/config/config.js';

afterEach(() => {applyUiSettings(defaultUiSettings); setTerminalFocus(undefined);});

function thinkingRound(lines = 8) {
  const store = new RuntimeStore();
  store.activities.create({sessionId: 's', activityId: 'main', ownerId: 'logox', kind: 'director', title: 'Main', status: 'running', stage: 'x', detail: ''});
  store.message('s', 'user', 'user', 'Think it over.', {activityId: 'main', inputKind: 'human'});
  const steps = new Steps(store, {sessionId: 's', activityId: 'main', ownerId: 'logox'});
  const think = steps.thinking();
  store.appendMessage(think, Array.from({length: lines}, (_, index) => 'thought line ' + index).join('\n'));
  steps.finish(think, 'completed');
  store.message('s', 'logox', 'assistant', 'Here is the answer.', {activityId: 'main'});
  return {store, think};
}
const timelineText = (store: RuntimeStore, folds: Record<string, boolean> = {}) =>
  buildStageRows(store.getSnapshot(), 's', 'logox', 100, folds, null).map(row => row.text).join('\n');

test('Thinking display: folded keeps one row, preview shows three lines behind an expander, full shows the thought', () => {
  const {store, think} = thinkingRound();
  const snapshot = store.getSnapshot();
  assert.equal(uiSettings().thinkingDisplay, 'folded');
  assert.equal(stageFoldOpen(snapshot, think, {}), false);
  assert.match(timelineText(store), /▸ Thought for/); assert.doesNotMatch(timelineText(store), /thought line 0/);

  applyUiSettings({thinkingDisplay: 'preview'});
  assert.equal(stageFoldOpen(store.getSnapshot(), think, {}), true, 'preview opens finished thinking by default');
  const preview = timelineText(store);
  assert.match(preview, /▾ Thought for/); assert.match(preview, /thought line 0/); assert.match(preview, /thought line 2/);
  assert.doesNotMatch(preview, /thought line 3/, 'only three rows of the thought show');
  assert.match(preview, /… 5 more lines/, 'the standard expander hides the rest');
  assert.match(timelineText(store, {[think + '-more']: true}), /thought line 7/, 'the expander still opens everything');

  applyUiSettings({thinkingDisplay: 'full'});
  const full = timelineText(store);
  assert.match(full, /thought line 0/); assert.match(full, /thought line 7/); assert.doesNotMatch(full, /more lines/);

  assert.equal(stageFoldOpen(store.getSnapshot(), think, {[think]: false}), false, 'a click on the card still folds it');
  assert.doesNotMatch(timelineText(store, {[think]: false}), /thought line 0/);
  applyUiSettings({thinkingDisplay: 'folded'});
  assert.equal(stageFoldOpen(store.getSnapshot(), think, {[think]: true}), true, 'and unfolds it in folded mode');
});

test('a running thought stays folded whatever Thinking display says', () => {
  const store = new RuntimeStore();
  store.activities.create({sessionId: 's', activityId: 'main', ownerId: 'logox', kind: 'director', title: 'Main', status: 'running', stage: 'x', detail: ''});
  store.message('s', 'user', 'user', 'Go.', {activityId: 'main', inputKind: 'human'});
  const steps = new Steps(store, {sessionId: 's', activityId: 'main', ownerId: 'logox'});
  const think = steps.thinking(); store.appendMessage(think, 'still thinking about it');
  applyUiSettings({thinkingDisplay: 'full'});
  assert.doesNotMatch(timelineText(store), /still thinking about it/);
});

test('changing a presentation setting invalidates cached layouts through the theme revision', () => {
  const before = themeRevision(), version = uiSettingsRevision();
  applyUiSettings({toolTint: 'none'});
  assert.equal(themeRevision(), before + 1); assert.equal(uiSettingsRevision(), version + 1);
  applyUiSettings({toolTint: 'none'});
  assert.equal(themeRevision(), before + 1, 'an unchanged value does not churn caches');
});

test('Tool card tint scales every expanded-card step: none, subtle half, standard stock', () => {
  const owner = '#e0a060';
  for (const depth of [1, 2, 3]) {
    const step = TINT_STEPS[depth - 1]!;
    applyUiSettings({toolTint: 'standard'}); assert.equal(expandedTint(owner, depth), mixHex(owner, palette.bg, step));
    applyUiSettings({toolTint: 'subtle'}); assert.equal(expandedTint(owner, depth), mixHex(owner, palette.bg, step * 0.5));
    applyUiSettings({toolTint: 'none'}); assert.equal(expandedTint(owner, depth), mixHex(owner, palette.bg, 0));
  }
  applyUiSettings({toolTint: 'none'});
  assert.equal(expandedTint(owner), palette.bg.toLowerCase(), 'none leaves the surface colour');
  applyUiSettings({toolTint: 'subtle'});
  assert.notEqual(expandedTint(owner), palette.bg.toLowerCase());
});

test('Diff layout: unified keeps line numbers, compact drops the gutter, auto decides by card width', () => {
  const hunks = structuredPatch('a.ts', 'a.ts', 'one\ntwo\nthree\n', 'one\n2\nthree\n', '', '', {context: 1}).hunks;
  const first = (width?: number) => diffLines(hunks, 0, width).lines.map(line => (line.segments ?? []).map(segment => segment.text).join(''));
  assert.equal(diffIsCompact(60), true, 'auto at 60 columns is already compact'); assert.equal(diffIsCompact(80), false);
  applyUiSettings({diffLayout: 'unified'});
  assert.match(first(40)[1]!, /^ {2}2 − two/, 'unified: numbered even when narrow');
  applyUiSettings({diffLayout: 'compact'});
  assert.deepEqual(first(200), ['  one', '− two', '+ 2', '  three'], 'compact: signs and text only, even when wide');
  applyUiSettings({diffLayout: 'auto'});
  assert.equal(diffIsCompact(50), true); assert.equal(diffIsCompact(100), false); assert.equal(diffIsCompact(undefined), false);
  assert.deepEqual(first(50), ['  one', '− two', '+ 2', '  three']);
  assert.match(first(100)[1]!, /^ {2}2 − two/);
});

const colors = {blue: '#7da1de', bone: '#e8e4da', title: '#7da1de', muted: '#8d95a6'};
const text = (line: readonly {text: string}[]) => line.map(segment => segment.text).join('');
const info = ['anthropic/claude-opus-5-5 · Type /help for assistance'];

test('Emblem size: small never draws the 52-pixel master, large prefers it, auto picks what fits', () => {
  const auto = splashLines({width: 140, height: 40, colors, info})!, small = splashLines({width: 140, height: 40, colors, info, emblem: 'small'})!;
  assert.ok(auto.length >= 30, 'auto takes the master where it fits'); assert.equal(small.length, 17, 'small keeps the flat 26-pixel emblem');
  const narrow = splashLines({width: 100, height: 40, colors, info})!;
  assert.ok(narrow.length < 20, 'at 100 columns auto falls back to the small layouts');
  const large = splashLines({width: 100, height: 40, colors, info, emblem: 'large'})!;
  assert.ok(large.length >= 30 && large.every(line => text(line).length <= 100), 'large puts the master beside plain words when the wordmark does not fit');
  assert.equal(splashLines({width: 100, height: 20, colors, info, emblem: 'large'})!.length < 20, true, 'large falls back when the height cannot hold it');
});

test('Tagline: fixed is the stock line, rotate takes one line per calendar day from a static English list', () => {
  assert.equal(taglineFor('fixed', new Date(2026, 5, 1)), EMBLEM_TAGLINE);
  assert.ok(TAGLINES.includes(EMBLEM_TAGLINE) && TAGLINES.includes(EMBLEM_ETYMOLOGY) && TAGLINES.length >= 4);
  assert.ok(TAGLINES.every(line => /^[\x20-\x7e·λόγος,]+$/u.test(line) || line === EMBLEM_ETYMOLOGY), 'English text only (plus the etymology line)');
  const days = Array.from({length: TAGLINES.length}, (_, index) => taglineFor('rotate', new Date(2026, 5, 1 + index)));
  assert.deepEqual([...days].sort(), [...TAGLINES].sort(), 'every line comes up within one cycle');
  assert.equal(taglineFor('rotate', new Date(2026, 5, 1, 1)), taglineFor('rotate', new Date(2026, 5, 1, 23)), 'one line per calendar day');
  assert.notEqual(taglineFor('rotate', new Date(2026, 5, 1)), taglineFor('rotate', new Date(2026, 5, 2)));
  const shown = splashLines({width: 100, height: 40, colors, info, tagline: 'Small steps, verified'})!.map(text).join('\n');
  assert.match(shown, /Small steps, verified/); assert.match(shown, /λόγος · reason, word, account/); assert.doesNotMatch(shown, /A terminal coding ensemble/);
  const swapped = splashLines({width: 100, height: 40, colors, info, tagline: EMBLEM_ETYMOLOGY})!.map(text).join('\n');
  assert.equal(swapped.split(EMBLEM_ETYMOLOGY).length, 2, 'the etymology line is not printed twice');
  assert.match(swapped, /A terminal coding ensemble/);
});

function snapshotWith(status: 'running' | 'completed' | 'waiting_input') {
  const store = new RuntimeStore();
  store.activities.create({sessionId: 's', activityId: 'main', ownerId: 'logox', kind: 'director', title: 'Main', status, stage: 'x', detail: ''});
  return {store, finish: () => store.activities.update('s', 'main', {status: 'completed'})};
}
function notifier(mode: 'off' | 'unfocused' | 'always', focused: boolean | undefined, clock: {now: number}, env: NodeJS.ProcessEnv = {}) {
  const written: string[] = [];
  return {written, notifier: new RoundNotifier({sessionId: 's', mode: () => mode, focused: () => focused, write: data => {written.push(data);}, now: () => clock.now, env})};
}

test('Notify when done: one bell after work over 30 seconds, by mode and focus', () => {
  const run = (mode: 'off' | 'unfocused' | 'always', focused: boolean | undefined, seconds: number, env: NodeJS.ProcessEnv = {}) => {
    const clock = {now: 1_000}, {store, finish} = snapshotWith('running'), {written, notifier: watcher} = notifier(mode, focused, clock, env);
    assert.equal(watcher.observe(store.getSnapshot()), false, 'nothing is said while work runs');
    clock.now += seconds * 1000; finish();
    watcher.observe(store.getSnapshot());
    assert.equal(watcher.observe(store.getSnapshot()), false, 'and nothing twice');
    return written;
  };
  assert.deepEqual(run('always', true, 31), ['\x07'], 'always rings even when focused');
  assert.deepEqual(run('unfocused', false, 31), ['\x07']);
  assert.deepEqual(run('unfocused', undefined, 31), ['\x07'], 'without focus reporting the terminal counts as unfocused');
  assert.deepEqual(run('unfocused', true, 90), [], 'a focused terminal needs no bell');
  assert.deepEqual(run('off', false, 90), []);
  assert.deepEqual(run('always', false, 29), [], 'short rounds stay quiet');
  assert.equal(NOTIFY_AFTER_MS, 30_000);
  assert.match(run('always', false, 31, {TERM_PROGRAM: 'iTerm.app'})[0]!, /^\x1b\]9;Logox: round finished after 31s\x07$/, 'OSC 9 where the terminal supports it');
  assert.equal(notificationSequence('x\ny', {TERM_PROGRAM: 'WezTerm'}), '\x1b]9;x y\x07', 'control characters never reach the sequence');
});

test('Notify when done ignores other sessions and counts waiting work as still busy', () => {
  const clock = {now: 0}, {store} = snapshotWith('running'), {written, notifier: watcher} = notifier('always', false, clock);
  store.activities.create({sessionId: 'other', activityId: 'x', ownerId: 'logox', kind: 'director', title: 'Other', status: 'running', stage: 'x', detail: ''});
  watcher.observe(store.getSnapshot()); clock.now = 40_000;
  store.activities.update('s', 'main', {status: 'waiting_input'});
  watcher.observe(store.getSnapshot()); assert.deepEqual(written, [], 'waiting for the user is not the end of the round');
  store.activities.update('s', 'main', {status: 'running'}); store.activities.update('s', 'main', {status: 'completed'});
  watcher.observe(store.getSnapshot()); assert.equal(written.length, 1, 'the other session does not keep this one busy');
});

test('focus reports are consumed from the input and update the focus state', () => {
  assert.equal(terminalFocus(), undefined);
  assert.equal(consumeFocusReports('a\x1b[Ib'), 'ab'); assert.equal(terminalFocus(), true);
  assert.equal(consumeFocusReports('\x1b[O'), ''); assert.equal(terminalFocus(), false);
  assert.equal(consumeFocusReports('plain'), 'plain'); assert.equal(terminalFocus(), false);
});

test('Enter key newline changes the composer hint', () => {
  const hint = (newlineEnter: boolean, width = 100) => footerHints({own: false, queued: 0, menu: false, closing: false, width, newlineEnter});
  assert.match(hint(false), /^Enter send/); assert.match(hint(true), /^Enter newline · Ctrl\+S send/); assert.equal(hint(true, 30), 'Ctrl+S send');
});

test('the shortcut and model pages are read-only data: grouped keys, per-provider models with price source', async () => {
  const titles = shortcutGroups.map(group => group.title);
  assert.deepEqual(titles, ['Composer', 'Running work', 'Questions and approvals', 'Pages and pickers', 'Application', 'Mouse']);
  const rows = shortcutRows();
  assert.ok(rows.some(row => row.kind === 'heading' && row.text === 'Composer')); assert.ok(rows.some(row => row.kind === 'field' && row.label === 'Ctrl+T'));
  assert.ok(rows.some(row => row.kind === 'text' && /rebinding/.test(row.text)), 'rebinding is noted as future work');
  const config = await loadConfig(process.cwd(), {permissions: {mode: 'default'}, provider: {model: 'claude-opus-5-5'}}, {}, process.cwd(), process.cwd());
  const line = modelLine(config, {provider: 'anthropic', id: 'claude-opus-5-5'});
  assert.match(line, /window · .* max out · \$.* in \/ \$.* out per 1M · (exact|normalized|alias|inferred)/, line);
  assert.match(modelLine(config, {provider: 'nowhere', id: 'made-up-model', window: 32000}), /32k window · \? max out · no price · unknown/);
  const page = modelsRows(config, ['anthropic', 'empty'], [{provider: 'anthropic', id: 'claude-opus-5-5'}]);
  assert.ok(page.some(row => row.kind === 'heading' && row.text === 'anthropic (1)')); assert.ok(page.some(row => row.kind === 'heading' && row.text === 'empty (0)'));
  assert.ok(page.some(row => row.kind === 'text' && /\[catalogs\.<provider>\]/.test(row.text)), 'the catalogs hint is there');
});

test('/settings is in the command catalog with the new description', () => {
  assert.match(commandCatalog.find(command => command.name === 'settings')!.description, /Appearance.*shortcuts/);
});
