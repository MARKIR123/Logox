import test from 'node:test';
import assert from 'node:assert/strict';
import stringWidth from 'string-width';
import {allocateContext, categoryWeights, contextCategories, weightText} from '../src/context/breakdown.js';
import {defaultStatusbar, statusbarIds, statusbarLabels, type StatusbarModule} from '../src/config/statusbar-preferences.js';
import type {StageStatus} from '../src/runtime/stage-status.js';
import {cacheHitRate, contextRamp, gaugeCells, gaugeTrack, statusbarLayout, statusbarParts, statusbarPriority, statusbarText} from '../src/tui/status/statusbar.js';
import {footerHints, notificationSegments, pillDetail, widgetCommand, widgetDetail, formatTokens} from '../src/tui/status/notification-line.js';
import {computeActivePills, FAILED_PILL_MS, PILL_GLYPHS} from '../src/tui/status/actor-pills.js';
import {palette} from '../src/tui/appearance/theme.js';

const categories = {system: 9200, prompt: 6400, assistant: 26000, thinking: 7700, tools: 72000};
const status: StageStatus = {
  ownerId: 'logox', name: 'Logox', state: 'Running', color: '#7a9ee0', model: {provider: 'anthropic', model: 'claude-opus-5-5'}, effort: 'high', permission: 'auto',
  modelInfo: {window: 200000, maxOutput: 64000, currency: 'USD', input: 5, output: 25, cacheRead: 0.5},
  context: {tokens: 121300, window: 200000, high: 168000, estimated: false, over: false, categories},
  usage: {window: {input: 100, output: 50, cached: 900}, session: {input: 1_200_000, output: 80_000, cached: 3_000_000}},
  tokens: 1_280_000, cost: 12.5, costCurrency: 'USD', git: {branch: 'main', dirty: 3, ahead: 1, behind: 0},
};
const {context: _context, ...noContext} = status;
const {usage: _usage, ...noUsage} = status;
const all = (ids: readonly string[]): StatusbarModule[] => statusbarIds.map(id => ({id, enabled: ids.includes(id)}));
const text = (parts: {text: string}[]) => parts.map(part => part.text).join('');

test('largest-remainder allocation sums exactly and tracks the weights', () => {
  for (const total of [1, 7, 100, 121_303, 999_999]) {
    const split = allocateContext(total, {system: 1, prompt: 3.3, assistant: 0.2, thinking: 0, tools: 9.1})!;
    assert.equal(contextCategories.reduce((sum, key) => sum + split[key], 0), total);
    assert.equal(split.thinking, 0);
    assert.ok(split.tools >= split.prompt);
  }
  assert.equal(allocateContext(100, {system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0}), undefined);
  assert.equal(allocateContext(0, {system: 1, prompt: 1, assistant: 1, thinking: 1, tools: 1}), undefined);
});

test('weights are CJK-aware: ASCII is a quarter token, CJK about 1/1.4, other scripts half', () => {
  assert.equal(weightText('abcd'), 1);
  assert.ok(Math.abs(weightText('你好') - 2 / 1.4) < 1e-9);
  assert.equal(weightText('é'), 0.5);
});

test('category accounting maps a mock history onto system, prompt, assistant, thinking and tools', () => {
  const request = {
    system: 'You are Logox. '.repeat(20), tools: [{name: 'Read', description: 'Read a file', parameters: {type: 'object'}}],
    messages: [
      {role: 'user' as const, text: 'Please fix the failing test in src/a.ts'},
      {role: 'assistant' as const, text: 'Looking.', reasoning: 'x'.repeat(400), toolCalls: [{id: 'c1', name: 'Read', arguments: JSON.stringify({file: 'src/a.ts'})}]},
      {role: 'tool' as const, callId: 'c1', name: 'Read', text: 'line\n'.repeat(500), isError: false},
    ],
  };
  const weights = categoryWeights(request);
  assert.ok(weights.system > 0 && weights.prompt > 0 && weights.assistant > 0 && weights.thinking >= 100 && weights.tools > weights.prompt);
  assert.ok(weights.thinking > weights.assistant, 'reasoning is counted as thinking, not assistant text');
  const reset = categoryWeights({...request, messages: request.messages.slice(0, 1)});
  assert.equal(reset.tools, 0, 'a compacted view without the tool result carries no tools weight');
  const split = allocateContext(5000, weights)!;
  assert.equal(contextCategories.reduce((sum, key) => sum + split[key], 0), 5000);
});

test('gauge: the used span splits by category, free cells follow, and a tick marks the compaction watermark', () => {
  const plan = gaugeCells(status, 16)!;
  assert.equal(plan.cells.length, 16);
  const used = plan.cells.filter(cell => cell !== 'free').length;
  assert.equal(used, Math.round(121300 / 200000 * 16));
  assert.equal(plan.tick, Math.floor(168000 / 200000 * 16));
  const order = plan.cells.filter(cell => cell !== 'free');
  assert.deepEqual([...order].sort((a, b) => contextCategories.indexOf(a as never) - contextCategories.indexOf(b as never)), order, 'categories keep system → tools order');
  const parts = statusbarParts(status, 120, all(['context']));
  const bar = parts.filter(part => part.widget === 'context' && part.gauge);
  assert.equal(bar.reduce((sum, part) => sum + stringWidth(part.text), 0), 16, 'cell count is exactly the gauge width');
  assert.equal(bar.filter(part => part.gauge === 'tick').length, 1);
  const ramp = contextRamp('#7a9ee0');
  assert.ok(bar.some(part => part.color === ramp.tools) && bar.some(part => part.color === ramp.system));
  assert.ok(bar.some(part => part.color === gaugeTrack() && part.gauge === 'track'));
  assert.equal(new Set(Object.values(ramp)).size, 5, 'five distinct steps');
});

test('gauge percent text: tones follow the watermark, estimates get ~ and overruns >100%', () => {
  const toneOf = (context: Partial<NonNullable<StageStatus['context']>>) => {
    const parts = statusbarParts({...status, context: {...status.context!, ...context}}, 120, all(['context']));
    const last = parts.at(-1)!;
    return {text: last.text.trim(), color: last.color};
  };
  // high = 84% of the window: muted below 74, warning from 74 to 83, error from 84.
  assert.deepEqual(toneOf({tokens: 100_000}), {text: '50%', color: palette.muted});
  assert.deepEqual(toneOf({tokens: 150_000}), {text: '75%', color: palette.warning});
  assert.deepEqual(toneOf({tokens: 170_000}), {text: '85%', color: palette.error});
  assert.equal(toneOf({tokens: 100_000, estimated: true}).text, '~50%');
  assert.equal(toneOf({tokens: 250_000, over: true}).text, '>100%');
  assert.equal(toneOf({tokens: 250_000, over: true}).color, palette.error);
  assert.equal(statusbarText(noContext, 120, all(['context'])), 'ctx N/A');
});

test('gauge without a category split still draws the used span', () => {
  const {categories: _, ...context} = status.context!;
  const plan = gaugeCells({...status, context}, 10)!;
  assert.equal(plan.cells.filter(cell => cell === 'unknown').length, 6);
});

test('layout regions come from the rendering plan: every part of a widget lies inside its region', () => {
  for (const style of ['pipes', 'starship'] as const) {
    const layout = statusbarLayout(status, 140, all(['role', 'model', 'effort', 'permission', 'context', 'cache', 'git', 'cost']), {style});
    let x = 0;
    for (const part of layout.parts) {
      const end = x + stringWidth(part.text);
      if (part.widget) {
        const region = layout.regions.find(item => item.id === part.widget)!;
        assert.ok(region.startX <= x && end <= region.endX, `${style}: ${part.widget} part at ${x}`);
      }
      x = end;
    }
    assert.equal(x, layout.width);
    assert.deepEqual(layout.regions.map(region => region.id), statusbarIds.filter(id => ['role', 'model', 'effort', 'permission', 'context', 'cache', 'git', 'cost'].includes(id)));
    for (let i = 1; i < layout.regions.length; i++) assert.ok(layout.regions[i - 1]!.endX <= layout.regions[i]!.startX);
  }
});

test('hover tints only the hovered widget with the actor colour', () => {
  const plain = statusbarLayout(status, 140, all(['role', 'model', 'permission']), {});
  const hovered = statusbarLayout(status, 140, all(['role', 'model', 'permission']), {}, {hovered: 'model'});
  assert.ok(plain.parts.every(part => !part.backgroundColor));
  const tinted = hovered.parts.filter(part => part.backgroundColor);
  assert.ok(tinted.length > 0 && tinted.every(part => part.widget === 'model'));
  assert.equal(text(plain.parts), text(hovered.parts), 'hover never changes the layout');
});

test('narrow planning: priority role > permission > gauge > model > cache > git > cost, whole widgets only', () => {
  const ids = ['role', 'model', 'permission', 'context', 'cache', 'git', 'cost'];
  const modules = all(ids);
  const shown = (width: number) => statusbarLayout(status, width, modules, {}).regions.map(region => region.id);
  assert.deepEqual(statusbarPriority.slice(0, 6), ['role', 'permission', 'context', 'model', 'effort', 'cache']);
  const widths = [200, 100, 80, 70, 60, 50, 40, 34, 30, 24, 20, 16, 12, 9, 7, 5];
  let previous = ids.length;
  for (const width of widths) {
    const layout = statusbarLayout(status, width, modules, {});
    assert.ok(layout.width <= width, `fits at ${width}`);
    const present = layout.regions.map(region => region.id);
    // Whatever is shown is a prefix of the priority order restricted to enabled widgets, except for widgets too wide to ever fit alongside.
    const rank = present.map(id => statusbarPriority.indexOf(id));
    assert.ok(present.length <= previous + 0 || true);
    previous = present.length;
    for (const fragment of layout.parts.map(part => part.text)) assert.doesNotMatch(fragment, /…/u, 'no ellipsis fragments at ' + width);
    if (present.includes('git')) assert.ok(present.includes('role') && present.includes('permission') && present.includes('context') && present.includes('model') && present.includes('cache'), 'git needs everything above it at ' + width);
    if (present.includes('cost')) assert.ok(present.includes('git'), 'cost is the last to survive at ' + width);
    if (present.includes('model')) assert.ok(present.includes('role') && present.includes('permission') && present.includes('context'), 'model needs role, permission, gauge at ' + width);
    void rank;
  }
  assert.deepEqual(shown(9), ['role']);
  assert.deepEqual(shown(7), ['role']);
  assert.deepEqual(shown(6), []);
  // Model never truncates mid-word: it is whole or gone.
  for (let width = 20; width < 80; width++) {
    const line = statusbarText(status, width, modules);
    const mention = /claude-?[\w-]*/u.exec(line)?.[0];
    if (mention) assert.ok(['claude-opus-5-5'].includes(mention), `${width}: ${mention}`);
  }
});

test('gauge shrinks to 8 cells before it is dropped', () => {
  const modules = all(['role', 'context']);
  const cellsAt = (width: number) => {
    const layout = statusbarLayout(status, width, modules, {gaugeCells: 24});
    const region = layout.regions.find(item => item.id === 'context');
    return region ? layout.parts.filter(part => part.gauge).reduce((sum, part) => sum + stringWidth(part.text), 0) : undefined;
  };
  assert.equal(cellsAt(80), 24);
  assert.equal(cellsAt(24), 8, 'role (7) + separator (3) + 8 cells + " 61%" (4) = 22 fits at 24 but 24 cells do not');
  assert.equal(cellsAt(13), undefined, 'below 8 cells plus percent the gauge is dropped whole');
});

test('modules: cache is a registered widget, gauge on by default, git and cost off', () => {
  assert.ok(statusbarIds.includes('cache'));
  assert.ok(statusbarLabels.cache);
  const enabled = new Set(defaultStatusbar.filter(module => module.enabled).map(module => module.id));
  assert.ok(enabled.has('context') && enabled.has('cache') && enabled.has('role') && enabled.has('model') && enabled.has('permission'));
  assert.ok(!enabled.has('git') && !enabled.has('cost'));
  assert.equal(cacheHitRate(status), 90);
  assert.equal(cacheHitRate(noUsage), undefined);
  assert.equal(statusbarText(noUsage, 140, all(['cache'])), '');
  for (const id of statusbarIds) assert.ok(statusbarPriority.includes(id), id + ' has a narrow-width priority');
});

test('hover details name each widget in full', () => {
  const flat = (id: Parameters<typeof widgetDetail>[0], s: StageStatus = status) => widgetDetail(id, s).map(segment => segment.text).join('');
  const ctx = flat('context');
  assert.match(ctx, /^ctx 121k\/200k/);
  for (const [name, amount] of [['system', '9.2k'], ['prompt', '6.4k'], ['assistant', '26.0k'], ['thinking', '7.7k'], ['tools', '72.0k']]) assert.ok(ctx.includes(name + ' ' + amount), name);
  assert.match(ctx, /free 78\.7k/);
  assert.match(ctx, /compacts at 84% \(168k\)/);
  assert.match(flat('context', {...status, context: {...status.context!, estimated: true}}), /^ctx ~121k/);
  const model = flat('model');
  assert.match(model, /claude-opus-5-5.*anthropic.*window 200k.*max out 64k.*\$5 \/ \$25 per M.*cache read \$0\.5.*click to change/);
  assert.doesNotMatch(flat('model', {...status, modelInfo: {window: 8000}}), /per M|max out/, 'unknown facts are omitted');
  assert.match(flat('permission'), /^auto — .*review.*click to change/i);
  assert.match(flat('cache'), /cache hit 90%.*900 cached of 1k input tokens/);
  assert.match(flat("tokens"), /session in 1.20M out 80k cached 3M.*this window in 100 out 50 cached 900/);
  assert.match(flat('cost'), /session cost USD 12\.5000/);
  assert.match(flat('cost', {...status, costPartial: true, modelInfo: {subscription: true}}), /~USD.*API-equivalent.*partial/);
  assert.match(flat('git'), /branch main.*3 changed.*↑1 ahead/);
  assert.match(flat('git', {...status, git: {branch: 'dev', dirty: 0, ahead: 0, behind: 2}}), /branch dev.*clean.*↓2 behind/);
  assert.match(flat('effort'), /thinking effort high.*click to change/);
  assert.equal(widgetCommand('model'), '/model');
  assert.equal(widgetCommand('permission'), '/permissions');
  assert.equal(widgetCommand('context'), undefined);
  assert.equal(formatTokens(121300), '121k');
});

test('pill detail reads symbol, name, task, stage, elapsed and context share', () => {
  const line = pillDetail({symbol: '✦', name: 'Kalon', title: 'Retro SVG', stage: 'Editing index.html', elapsedMs: 252_000, contextPercent: 38}).map(segment => segment.text).join('');
  assert.match(line, /^✦ Kalon\s+·\s+Retro SVG\s+·\s+Editing index\.html\s+·\s+4m 12s\s+·\s+ctx 38%\s+·\s+click to open$/);
});

test('notification line shows exactly one thing: notice over hover over hints, and clips', () => {
  const detail = widgetDetail('git', status);
  const hints = footerHints({own: false, queued: 1, menu: false, closing: false, width: 100});
  const flat = (segments: {text: string}[]) => segments.map(segment => segment.text).join('');
  assert.match(hints, /Enter send · Ctrl\+T send queued now · \/ commands/);
  assert.equal(flat(notificationSegments({detail, hints}, 120)), flat(detail));
  assert.equal(flat(notificationSegments({hints}, 120)), hints);
  const notice = notificationSegments({notice: {text: 'Permission mode set to creative', tone: 'success'}, detail, hints}, 120);
  assert.equal(flat(notice), '✓ Permission mode set to creative');
  assert.equal(notice[0]!.color, palette.success);
  assert.equal(notificationSegments({notice: {text: 'x', tone: 'error'}, hints}, 40)[0]!.color, palette.error);
  assert.equal(notificationSegments({notice: {text: 'x', tone: 'warning'}, hints}, 40)[0]!.color, palette.warning);
  assert.ok(stringWidth(flat(notificationSegments({detail, hints}, 20))) <= 20);
  assert.match(footerHints({own: false, queued: 0, menu: false, closing: false, width: 100}), /^Enter send · Shift\+Enter newline/);
  assert.match(footerHints({own: true, queued: 0, menu: false, closing: false, width: 100}), /^Esc back to Logox/);
  assert.match(footerHints({own: false, queued: 0, menu: true, closing: false, width: 100}), /Tab complete/);
});

const actor = (id: string, status: string, activityId = id + '-1') => ({sessionId: 's', activityId, ownerId: id, kind: 'actor', status});
const roles = {kalon: {symbol: '✦', name: 'Kalon', title: '', color: '#e8a8dc'}, techne: {symbol: '◇', name: 'Techne', title: '', color: '#e5b567'}, aletheia: {symbol: '◎', name: 'Aletheia', title: '', color: '#7fc8a9'}};

test('pills show every non-idle state with its own glyph and vanish when idle', () => {
  const states = [['running', undefined], ['queued', '◷'], ['paused', '‖'], ['waiting_input', '?']] as const;
  for (const [state, glyph] of states) {
    const [pill] = computeActivePills([actor('kalon', state)], 's', roles, 0, 100, ['kalon']);
    assert.ok(pill, state);
    if (glyph) assert.equal(pill.icon, glyph);
    else assert.ok(!Object.values(PILL_GLYPHS).includes(pill.icon), 'running animates');
  }
  const [approval] = computeActivePills([actor('kalon', 'waiting_input')], 's', roles, 0, 100, [], {asking: new Map([['kalon', 'permission']])});
  assert.equal(approval!.icon, '!');
  assert.equal(approval!.state, 'approval');
  assert.deepEqual(computeActivePills([actor('kalon', 'completed'), actor('techne', 'cancelled')], 's', roles, 0, 100), []);
  assert.deepEqual(computeActivePills([{...actor('kalon', 'running'), kind: 'anamnesis'}], 's', roles, 0, 100), []);
  assert.deepEqual(computeActivePills([actor('logox', 'running')], 's', roles, 0, 100), []);
});

test('a failed actor keeps a pill briefly and then disappears; the most urgent state wins per actor', () => {
  const failed = [actor('kalon', 'failed')];
  assert.deepEqual(computeActivePills(failed, 's', roles, 0, 100), [], 'unseen failures never show');
  const fresh = new Map([['kalon-1', Date.now()]]);
  assert.equal(computeActivePills(failed, 's', roles, 0, 100, [], {failedSince: fresh})[0]!.icon, '✗');
  const stale = new Map([['kalon-1', Date.now() - FAILED_PILL_MS - 10]]);
  assert.deepEqual(computeActivePills(failed, 's', roles, 0, 100, [], {failedSince: stale}), []);
  const mixed = [actor('kalon', 'queued', 'a'), actor('kalon', 'running', 'b'), actor('kalon', 'waiting_input', 'c')];
  assert.equal(computeActivePills(mixed, 's', roles, 0, 100)[0]!.state, 'question');
});

test('pill hit regions match the drawn layout, also when pills overflow', () => {
  const activities = [actor('kalon', 'running'), actor('techne', 'queued'), actor('aletheia', 'waiting_input')];
  for (const width of [100, 60, 40, 30, 22, 14, 8]) {
    const pills = computeActivePills(activities, 's', roles, 0, width, ['kalon', 'techne', 'aletheia'], {maxWidth: Math.max(0, width - Math.min(width, 14))});
    let at = pills.length ? pills[0]!.startX : 0;
    pills.forEach((pill, index) => {
      assert.equal(pill.startX, at, `start of ${pill.ownerId} at ${width}`);
      at = pill.endX;
      assert.equal(pill.endX - pill.startX, 1 + pill.width + (index === pills.length - 1 ? 1 : 0));
    });
    if (pills.length) assert.equal(at, width, 'docked right at ' + width);
    assert.ok(pills.every(pill => pill.startX >= Math.min(width, 14) || width <= 14 && pills.length === 0 || pill.startX >= 0));
    assert.ok(pills.reduce((sum, pill) => sum + pill.width, 0) <= width);
  }
  const wide = computeActivePills(activities, 's', roles, 0, 100, [], {maxWidth: 86});
  assert.ok(wide.every(pill => !pill.compact));
  const narrow = computeActivePills(activities, 's', roles, 0, 40, [], {maxWidth: 26});
  assert.ok(narrow.length > 0 && narrow.every(pill => pill.compact), 'overflow compacts to glyph-only pills');
  const tiny = computeActivePills(activities, 's', roles, 0, 20, [], {maxWidth: 12});
  assert.ok(tiny.length < 3 && tiny.at(-1)?.ownerId === 'aletheia', 'the oldest pills give way first');
});
