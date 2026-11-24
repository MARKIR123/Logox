import test from 'node:test';
import assert from 'node:assert/strict';
import stringWidth from 'string-width';
import type {TeamEvent} from '../src/runtime/team-events.js';
import {palette} from '../src/tui/appearance/theme.js';
import {CONTENT_X} from '../src/tui/panels/sidebar-frame.js';
import {buildTeamLayout, effectiveScroll, emptyTeamView, paintTeam, positionOf, selectedId, stepTeamKey, stepTeamMouse, teamGeometry, teamLabeler, teamStats, teamWidth,
  type TeamEffect, type TeamLayout, type TeamPointer, type TeamStep, type TeamView} from '../src/tui/panels/team-sidebar.js';

const SYMBOLS: Record<string, string> = {logox: '◈', kalon: '✧', techne: '⊞', aletheia: '◎'};
const label = teamLabeler(id => ({symbol: SYMBOLS[id] ?? '◇', name: id}));
const T0 = new Date(2026, 10, 20, 8, 21, 0).getTime();
const hhmm = (at: number) => new Date(at).toTimeString().slice(0, 5);
const base = (n: number): Pick<TeamEvent, 'id' | 'at' | 'ref'> => ({id: 'e' + n, at: T0 + n * 180_000, ref: 'r' + n});
/** The approved design's session: a dispatch, a peer message, a worker dispatch and result, a wait, a report and the person's own words. */
const STREAM: readonly TeamEvent[] = [
  {...base(0), from: 'logox', to: ['kalon', 'techne'], kind: 'assign', text: '绘制海岸鹈鹕骑车 SVG ／ 构建单文件骑行动画'},
  {...base(1), from: 'techne', to: ['kalon'], kind: 'message', text: '接口改名为 buildStreetProps()，你那边的调用需要同步更新，否则预览会报错并且无法继续'},
  {...base(2), from: 'kalon', to: [], kind: 'workers', text: '3 workers', items: [{title: '搜索参考图', fork: false}, {title: '提取色板', fork: false}, {title: '构图草稿', fork: true}]},
  {...base(3), from: 'automa', to: ['kalon'], kind: 'result', status: 'done', dispatcher: 'kalon', worker: 'T1', text: '找到 4 处可参考的海岸骑行插画，并整理了色板'},
  {...base(4), from: 'aletheia', to: ['techne'], kind: 'waiting', text: 'waiting on techne'},
  {...base(5), from: 'techne', to: ['logox'], kind: 'report', status: 'done', text: '已实现 buildStreetProps()，导出 group / update，并通过了本地预览'},
  {...base(6), from: 'user', to: ['kalon'], kind: 'user', text: '鹈鹕的嘴再大一点'},
];
const many = (count: number): TeamEvent[] => Array.from({length: count}, (_, n) => ({...base(n), from: n % 2 ? 'kalon' : 'techne', to: [n % 2 ? 'techne' : 'kalon'], kind: 'message' as const, text: 'message number ' + n}));
const layoutAt = (panel: number, events: readonly TeamEvent[] = STREAM, filter?: string) => buildTeamLayout(events, {width: teamWidth(panel), filter, label});
const plain = (lines: ReturnType<typeof paintTeam>) => lines.map(line => line.map(segment => segment.text).join(''));
const paint = (layout: TeamLayout, panel: number, height = 20, view: TeamView = emptyTeamView, extra: Partial<Parameters<typeof paintTeam>[0]> = {}) =>
  paintTeam({layout, view, width: panel, height, focused: false, ownerColor: id => '#' + (id.charCodeAt(0) % 10).toString().repeat(6), label, ...extra});
const column = (text: string, needle: string) => {const at = text.indexOf(needle); assert.ok(at >= 0, needle + ' is in ' + text); return stringWidth(text.slice(0, at));};

test('a post is two rows: the sender, the recipients and the kind or status, the time right-aligned, then one faint body line; a wait is one row', () => {
  const lines = plain(paint(layoutAt(56), 56, 24));
  const header = lines.indexOf(lines.find(line => line.includes('◈ logox → @kalon @techne · assign'))!);
  assert.ok(header > 0);
  assert.match(lines[header]!, new RegExp('^│  ◈ logox → @kalon @techne · assign +' + hhmm(STREAM[0]!.at) + ' *$'.replace('$', '$')));
  assert.match(lines[header + 1]!, /^│    绘制海岸鹈鹕骑车 SVG ／ 构建单文件骑行动画 *$/);
  assert.match(lines[header + 2]!, /^│  ⊞ techne → @kalon +\d\d:\d\d *$/);
  assert.match(lines[header + 3]!, /^│    接口改名为 buildStreetProps\(\)，/);
  assert.match(lines[header + 4]!, /^│  ✧ kalon ⇢ 3 workers +\d\d:\d\d *$/);
  assert.match(lines[header + 5]!, /^│    ◦ 搜索参考图   ◦ 提取色板   ⑂ 构图草稿 *$/, 'a worker is ◦, a fork ⑂');
  assert.match(lines[header + 6]!, /^│  ◦ worker → @kalon · done +\d\d:\d\d *$/);
  assert.match(lines[header + 8]!, /^│  ◎ aletheia ┄ waiting on techne +\d\d:\d\d *$/);
  assert.match(lines[header + 9]!, /^│  ⊞ techne → @logox · done +\d\d:\d\d *$/, 'the next post follows at once: a wait has no body row');
  assert.match(lines.find(line => line.includes('you →'))!, /^│  ✓ you → @kalon +\d\d:\d\d *$/);
});

test('every line is exactly the panel width and the time sits flush right, at 36, 56 and 80 columns', () => {
  for (const panel of [36, 56, 80]) {
    const layout = layoutAt(panel);
    const lines = plain(paint(layout, panel, 24));
    assert.equal(lines.length, 24);
    assert.ok(lines.every(line => stringWidth(line) === panel), `all lines are ${panel} cells wide`);
    const times = lines.filter(line => /\d\d:\d\d *$/.test(line));
    assert.equal(times.length, STREAM.length);
    // The time ends at the content edge, one margin cell before the panel edge.
    assert.ok(times.every(line => stringWidth(line.trimEnd()) === CONTENT_X + teamWidth(panel)), `${panel}: right-aligned`);
    assert.ok(times.every(line => line.trimEnd().slice(-5) !== undefined && /\d\d:\d\d$/.test(line.trimEnd())));
  }
});

test('long text is clipped with … at every width, wide characters are never split, and narrow headers drop recipients before the sender', () => {
  for (const panel of [36, 56, 80]) {
    const lines = plain(paint(layoutAt(panel), panel, 24));
    const body = lines.find(line => line.includes('接口改名为'))!;
    assert.ok(body.trimEnd().endsWith('…') && stringWidth(body) === panel, `${panel}: the body is clipped to the width with …`);
    assert.ok(!body.includes('\uFFFD'));
  }
  const narrow = plain(paint(layoutAt(36), 36, 24));
  assert.ok(narrow.some(line => /^│  ◈ logox → @kalon \+1 +\d\d:\d\d/.test(line) || /^│  ◈ logox → @kalon @techne +\d\d:\d\d/.test(line)), narrow.join('\n'));
  assert.ok(narrow.every(line => !/@kalon @techne · assign/.test(line)), 'the word goes before a recipient is lost');
  const tiny = plain(paint(layoutAt(36, [{...STREAM[0]!, text: 'x', to: ['kalon', 'techne', 'aletheia', 'logox', 'user']}]), 36, 12));
  assert.ok(tiny.every(line => stringWidth(line) === 36));
  assert.match(tiny[2]!, /^│  ◈ logox → /);
});

test('no sidebar cell carries a background, and the panel is drawn with palette colours only', () => {
  const layout = layoutAt(56);
  const views: TeamView[] = [emptyTeamView, {...emptyTeamView, live: false, selected: 'e2', hovered: 'e4', hoveredName: 'e2\0techne', picker: 1, hoveredControl: 'filter'}];
  for (const view of views) {
    for (const line of paint(layout, 56, 24, view, {focused: true})) for (const segment of line) assert.equal(segment.bg, undefined, JSON.stringify(segment));
  }
});

test('selection draws the accent marker and a bold header; hover and a hovered name are recoloured at paint time, the layout is untouched', () => {
  const layout = layoutAt(56);
  const colorOf = (lines: ReturnType<typeof paintTeam>, text: string) => lines.flat().find(segment => segment.text.includes(text));
  const live = paint(layout, 56, 24);
  assert.equal(colorOf(live, '✓')?.color, palette.accent, 'the newest post is selected while live: its marker is accent');
  const chosen = paint(layout, 56, 24, {...emptyTeamView, live: false, selected: 'e1'});
  assert.equal(colorOf(chosen, '⊞')?.color, palette.accent);
  assert.equal(colorOf(chosen, '✓')?.color !== palette.accent, true);
  assert.equal(chosen.flat().find(segment => segment.text === 'techne')?.bold, true);
  assert.equal(live.flat().find(segment => segment.text === 'techne')?.bold ?? false, false, 'an unselected header is not bold');
  const hovered = paint(layout, 56, 24, {...emptyTeamView, hovered: 'e0', hoveredName: 'e0\0kalon'});
  assert.equal(hovered.flat().find(segment => segment.text.includes('@kalon'))?.underline, true);
  assert.equal(layoutAt(56).rows.length, layout.rows.length);
});

test('the header is the act header; the footer reads ◀ ▶ selected / total · elapsed and the member filter', () => {
  const layout = layoutAt(56);
  const geometry = teamGeometry(20);
  const first = plain(paint(layout, 56, 20));
  assert.match(first[0]!, /^│ ‹ Act 1 of 1 · 绘制海岸鹈鹕骑车 SVG +─+ 0\/0 ›\s*$/, 'one act (the dispatch opened it), titled by its first assignment; the bar is empty with no task graph');
  assert.match(first[1]!, /^│ ─+ *$/);
  assert.match(first.at(-1)!, /^│ ◀ ▶ {3}7 \/ 7 · \+18m +all members ▾ *$/);
  assert.match(first.at(-2)!, /^│ ─+ *$/);
  const step = stepTeamKey(layout, emptyTeamView, geometry, {up: true});
  const middle = plain(paint(layout, 56, 20, step.view));
  assert.match(middle.at(-1)!, /^│ ◀ ▶ {3}6 \/ 7 · \+15m +all members ▾ *$/);
  // The first event is the zero of the elapsed time.
  const top = plain(paint(layout, 56, 20, stepTeamKey(layout, emptyTeamView, geometry, {home: true}).view));
  assert.match(top.at(-1)!, /1 \/ 7 · \+0s/);
});

test('arrows, page keys, Home and End move the selection and the view follows; End returns to Live; Esc, t and f are effects or the picker', () => {
  const layout = buildTeamLayout(many(30), {width: teamWidth(56), label});
  const geometry = teamGeometry(14);
  let view = emptyTeamView;
  assert.deepEqual([view.live, positionOf(layout, view), effectiveScroll(layout, view, geometry)], [true, 30, layout.rows.length - geometry.body]);
  const key = (next: Parameters<typeof stepTeamKey>[3]) => {const step = stepTeamKey(layout, view, geometry, next); view = step.view; return step;};
  key({up: true});
  assert.deepEqual([view.live, positionOf(layout, view), view.selected], [false, 29, 'e28']);
  key({pageUp: true});
  assert.equal(positionOf(layout, view), 29 - Math.floor(geometry.body / 2));
  key({home: true});
  assert.deepEqual([positionOf(layout, view), effectiveScroll(layout, view, geometry)], [1, 0]);
  key({up: true});
  assert.equal(positionOf(layout, view), 1, 'clamped at the first post');
  for (let i = 0; i < 12; i++) key({down: true});
  const scroll = effectiveScroll(layout, view, geometry), box = layout.boxes[positionOf(layout, view) - 1]!;
  assert.ok(box.y0 >= scroll && box.y1 < scroll + geometry.body, 'the selected post is always in view');
  key({pageDown: true});
  key({end: true});
  assert.deepEqual([view.live, positionOf(layout, view)], [true, 30]);
  assert.deepEqual(key({escape: true}).effects, [{kind: 'blur'}]);
  assert.deepEqual(key({programme: true}).effects, [{kind: 'programme'}]);
  assert.deepEqual(key({enter: true}).effects, [{kind: 'open', id: 'e29'}]);
  assert.equal(stepTeamKey(layout, view, geometry, {}).consumed, false, 'a typing key is not taken');
  // The member picker: f opens it on the current filter, arrows move, Enter chooses, Esc closes.
  key({filter: true});
  assert.equal(view.picker, 0);
  key({down: true}); key({down: true});
  assert.equal(view.picker, 2);
  assert.equal(key({escape: true}).effects.length, 0);
  assert.equal(view.picker, undefined);
  key({filter: true}); key({down: true}); key({enter: true});
  assert.deepEqual([view.filter, view.picker], [layout.members[0], undefined]);
});

test('click selects, a second click within 350 ms opens the post, the wheel steps through posts, and every move leaves Live', () => {
  const layout = layoutAt(56), geometry = teamGeometry(24), now = 1_000_000;
  const at = (box: number) => ({x: CONTENT_X + 12, y: geometry.header + layout.boxes[box]!.y1});
  const mouse = (view: TeamView, pointer: Partial<TeamPointer> & {x: number; y: number}, time = now): TeamStep =>
    stepTeamMouse(layout, view, geometry, {action: 'press', ...pointer}, time, 56, label);
  const first = mouse(emptyTeamView, at(1));
  assert.deepEqual([first.view.live, first.view.selected, first.effects], [false, 'e1', [{kind: 'focus'}]]);
  const second = mouse(first.view, at(1), now + 200);
  assert.deepEqual(second.effects, [{kind: 'focus'}, {kind: 'open', id: 'e1'}]);
  assert.equal(second.view.lastClick, undefined, 'a double click is spent');
  const slow = mouse(first.view, at(1), now + 900);
  assert.deepEqual(slow.effects, [{kind: 'focus'}], 'a slow second click only selects');
  const other = mouse(first.view, at(2), now + 100);
  assert.deepEqual(other.effects, [{kind: 'focus'}], 'another post is a first click');
  const down = mouse(emptyTeamView, {x: 10, y: 8, action: 'wheel_up'});
  assert.deepEqual([down.view.live, down.view.selected], [false, 'e5']);
  const after = mouse(down.view, {x: 10, y: 8, action: 'wheel_down'});
  assert.deepEqual([after.view.live, positionOf(layout, after.view)], [false, 7], 'the wheel down at the end does not return to Live');
  assert.equal(mouse(emptyTeamView, {x: 10, y: 6, action: 'move'}).view.hovered, 'e2');
  assert.equal(mouse(emptyTeamView, {x: 10, y: geometry.header + layout.rows.length + 2, action: 'move'}).view.hovered, undefined);
});

test('◀ ▶ step the selection, Live returns to following, and the act header is a click target (no tabs: it has no Tasks view to switch to)', () => {
  const layout = layoutAt(56), geometry = teamGeometry(20);
  const footerY = geometry.height - 1;
  const painted = plain(paint(layout, 56, 20));
  const prev = column(painted.at(-1)!, '◀'), next = column(painted.at(-1)!, '▶');
  const press = (view: TeamView, x: number, y: number) => stepTeamMouse(layout, view, geometry, {x, y, action: 'press'}, 0, 56, label);
  let view = press(emptyTeamView, prev, footerY).view;
  assert.deepEqual([view.live, positionOf(layout, view)], [false, 6]);
  view = press(view, prev, footerY).view;
  assert.equal(positionOf(layout, view), 5);
  view = press(view, next, footerY).view;
  assert.equal(positionOf(layout, view), 6);
  const header = plain(paint(layout, 56, 20, view))[0]!;
  assert.match(header, /Act 1 of 1 · 绘制海岸鹈鹕骑车 SVG/);
  assert.doesNotMatch(header, /Tasks|Team|Live/, 'no tabs and no Live switch up here');
  const programme = press(view, column(header, 'Act 1'), 0);
  assert.deepEqual(programme.effects, [{kind: 'focus'}, {kind: 'programme'}], 'a click on the act title opens the Programme');
  assert.equal(press(view, stringWidth(header.slice(0, header.lastIndexOf('›'))), 0).view, view, 'one act only: the arrows have nowhere to go');
  const hover = stepTeamMouse(layout, view, geometry, {x: column(header, 'Act 1'), y: 0, action: 'move'}, 0, 56, label);
  assert.equal(hover.view.hoveredControl, 'act');
  // No acts at all (nobody dispatched anything): the header says so and still opens the Programme.
  const talk = buildTeamLayout(STREAM.filter(event => event.kind === 'user'), {width: teamWidth(56), label});
  const empty = plain(paint(talk, 56, 20))[0]!;
  assert.match(empty, /Team · no acts yet/);
  assert.deepEqual(stepTeamMouse(talk, emptyTeamView, geometry, {x: column(empty, 'Team'), y: 0, action: 'press'}, 0, 56, label).effects, [{kind: 'focus'}, {kind: 'programme'}]);
  // Live moved down beside the member filter once the stage is on (the stage controls carry the stepping).
  const staged = teamGeometry(30, {rows: 12, mode: 'strip'});
  const footer = plain(paint(layout, 56, 30, view, {stage: true})).at(-1)!;
  assert.match(footer, /^[│›] ○ Live +all members ▾ *$/);
  const live = stepTeamMouse(layout, view, staged, {x: column(footer, '○ Live') + 1, y: 29, action: 'press'}, 0, 56, label);
  assert.deepEqual([live.view.live, positionOf(layout, live.view)], [true, 7]);
});

test('a click on a name filters to that member (again clears it), and the footer opens a picker of members to choose from', () => {
  const layout = layoutAt(56), geometry = teamGeometry(24);
  const painted = plain(paint(layout, 56, 24));
  const row = painted.findIndex(line => line.includes('⊞ techne → @kalon'));
  const press = (view: TeamView, x: number, y: number) => stepTeamMouse(layout, view, geometry, {x, y, action: 'press'}, 0, 56, label);
  const named = press(emptyTeamView, column(painted[row]!, '@kalon') + 1, row);
  assert.equal(named.view.filter, 'kalon');
  assert.equal(named.view.live, true, 'a filter is not navigation');
  const filtered = buildTeamLayout(STREAM, {width: teamWidth(56), filter: 'kalon', label});
  assert.deepEqual(filtered.ids, ['e0', 'e1', 'e2', 'e3', 'e6'], 'posts involving kalon, workers dispatched by it included');
  const text = plain(paintTeam({layout: filtered, view: named.view, width: 56, height: 24, focused: false, ownerColor: () => '#fff', label}));
  assert.match(text.at(-1)!, /5 \/ 5 · \+\d+m +kalon ▾ *$/);
  assert.ok(text.every(line => !line.includes('aletheia')));
  const sender = press(emptyTeamView, column(painted[row]!, 'techne'), row);
  assert.equal(sender.view.filter, 'techne');
  assert.equal(stepTeamMouse(filtered, named.view, geometry, {x: column(text[row]!, 'kalon') + 1, y: row, action: 'press'}, 0, 56, label).view.filter === 'kalon', false, 'the same name clears the filter');
  // The picker.
  const footer = painted.at(-1)!;
  const open = press(emptyTeamView, column(footer, 'all members'), geometry.height - 1);
  assert.equal(open.view.picker, 0);
  const picked = plain(paint(layout, 56, 24, open.view));
  const members = picked.slice(-8);
  assert.ok(picked.some(line => /─ Members/.test(line)) && picked.some(line => line.includes('› ◇ All members ✓')), picked.join('\n'));
  assert.ok(['logox', 'kalon', 'techne', 'aletheia', 'you'].every(name => picked.some(line => line.includes(name))), members.join('\n'));
  const techneRow = picked.findIndex(line => line.includes('⊞ techne') && !line.includes('→'));
  const hover = stepTeamMouse(layout, open.view, geometry, {x: 8, y: techneRow, action: 'move'}, 0, 56, label);
  assert.equal(hover.view.picker, layout.members.indexOf('techne') + 1);
  const chosen = stepTeamMouse(layout, hover.view, geometry, {x: 8, y: techneRow, action: 'press'}, 0, 56, label);
  assert.deepEqual([chosen.view.filter, chosen.view.picker], ['techne', undefined]);
  const outside = stepTeamMouse(layout, open.view, geometry, {x: 8, y: geometry.header + 1, action: 'press'}, 0, 56, label);
  assert.deepEqual([outside.view.filter, outside.view.picker], [undefined, undefined], 'a click elsewhere closes the picker');
  const all = stepTeamMouse(layout, {...open.view, filter: 'techne'}, geometry, {x: 8, y: picked.findIndex(line => line.includes('All members')), action: 'press'}, 0, 56, label);
  assert.equal(all.view.filter, undefined);
});

test('the layout is rebuilt only when events, width or filter change; new posts keep Live at the tail', () => {
  const layout = layoutAt(56), geometry = teamGeometry(20);
  // The border and the header bar belong to the sidebar host (`tests/sidebar-tabs.test.tsx`): every border row of the page is plain.
  assert.ok(plain(paint(layout, 56, 20)).every(line => line.startsWith('│ ')), 'no collapse button on the border any more');
  const before = teamStats.builds;
  buildTeamLayout(STREAM, {width: teamWidth(56), label});
  assert.equal(teamStats.builds, before + 1);
  // A live view follows the tail as posts arrive; a view that left Live keeps its post.
  const grown = buildTeamLayout([...STREAM, {...base(7), from: 'kalon', to: ['logox'], kind: 'message', text: 'one more'}], {width: teamWidth(56), label});
  assert.equal(selectedId(grown, emptyTeamView), 'e7');
  assert.equal(effectiveScroll(grown, emptyTeamView, geometry), Math.max(0, grown.rows.length - geometry.body));
  const left: TeamView = {...emptyTeamView, live: false, selected: 'e3', scroll: 0};
  assert.equal(selectedId(grown, left), 'e3');
  assert.equal(selectedId(buildTeamLayout(STREAM, {width: teamWidth(56), filter: 'aletheia', label}), left), 'e4', 'a hidden selection reads as the newest visible post');
  const empty = plain(paint(buildTeamLayout([], {width: teamWidth(56), label}), 56, 12));
  assert.match(empty[2]!, /No team activity yet/);
  assert.match(empty.at(-1)!, /0 \/ 0/);
});
