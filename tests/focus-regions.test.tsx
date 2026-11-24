import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {RuntimeStore} from '../src/runtime/store.js';
import {buildStageRows} from '../src/tui/timeline/stage.js';
import {focusRegion} from '../src/tui/input/focus-regions.js';
import {TerminalPlane} from '../src/tui/terminal/terminal-plane.js';
import {setTerminalFocus} from '../src/tui/terminal/focus.js';
import {FOCUSED_RAIL} from '../src/tui/timeline/row-presentation.js';
import {mixHex, quietRail} from '../src/tui/appearance/colors.js';
import {palette} from '../src/tui/appearance/theme.js';
import type {SceneRow} from '../src/tui/timeline/scene.js';

const base = {focus: 'input', timelineChosen: false, editingCustom: false, takeover: false} as const;

test('exactly one region is focused, a takeover surface focuses none and the previous region returns when it closes', () => {
  assert.equal(focusRegion(base), 'composer');
  assert.equal(focusRegion({...base, timelineChosen: true}), 'timeline');
  assert.equal(focusRegion({...base, focus: 'plan'}), 'sidebar');
  assert.equal(focusRegion({...base, focus: 'question'}), 'timeline', 'a prompt or stop control is a card of the timeline');
  assert.equal(focusRegion({...base, focus: 'stop'}), 'timeline');
  assert.equal(focusRegion({...base, focus: 'question', editingCustom: true}), 'composer', 'a custom answer is typed in the composer');
  for (const facts of [base, {...base, timelineChosen: true}, {...base, focus: 'plan'}] as const) {
    assert.equal(focusRegion({...facts, takeover: true}), null, 'nothing is focused under a page');
    assert.equal(focusRegion({...facts, takeover: false}), focusRegion(facts), 'the same region once it closes');
  }
});

function rows() {
  const store = new RuntimeStore();
  store.activities.create({sessionId: 's', activityId: 'main', ownerId: 'logox', kind: 'director', title: 'Main', status: 'completed', stage: 'x', detail: ''});
  store.message('s', 'user', 'user', 'Question', {activityId: 'main', inputKind: 'human'});
  store.message('s', 'logox', 'assistant', 'one\n\ntwo\n\nthree', {activityId: 'main'});
  return buildStageRows(store.getSnapshot(), 's', 'logox', 60, {}, null);
}
const hex = (r: string, g: string, b: string) => '#' + [r, g, b].map(v => (+v).toString(16).padStart(2, '0')).join('');
const railColours = (text: string) => [...text.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m│ /g)].map(m => hex(m[1]!, m[2]!, m[3]!));

function plane(motion = true) {
  const list = rows(), writes: string[] = [], p = new TerminalPlane(text => writes.push(text));
  p.afterInkWrite('\x1b[?1049h');
  const quietRows = list.filter(row => !row.railGlyph && row.gutterCols > 0) as SceneRow[], quiet = quietRows.at(-1)!;
  const frame = (focus: boolean) => ({rows: list, start: 0, width: 60, height: list.length, selection: null, motion, focus});
  const latest = () => railColours(writes.join('')).at(-1);
  return {p, writes, frame, latest, quiet: quietRail((quiet as SceneRow).railColor), lit: mixHex((quiet as SceneRow).railColor, palette.bg, FOCUSED_RAIL), allLit: new Set(quietRows.map(row => mixHex(row.railColor, palette.bg, FOCUSED_RAIL)))};
}

test('the timeline rails ease up to the speaker colour when the timeline is focused and back down, in several frames', async () => {
  const t = plane();
  try {
    t.p.present(t.frame(false)); t.p.flush();
    assert.equal(t.latest(), t.quiet, 'quiet rails at rest');
    t.writes.length = 0;
    t.p.present(t.frame(true));
    await delay(400);
    const up = [...new Set(railColours(t.writes.join('')))];
    assert.ok(up.length >= 3, 'intermediate frames, not a jump: ' + up.join(' '));
    assert.equal(up.at(-1), t.lit);
    t.writes.length = 0;
    t.p.present(t.frame(false));
    await delay(400);
    const down = [...new Set(railColours(t.writes.join('')))];
    assert.ok(down.length >= 3, 'fades back through frames');
    assert.equal(down.at(-1), t.quiet);
  } finally {t.p.dispose();}
});

test('without motion the rails change at once; the terminal losing focus dims the focused timeline and focus-in lights it again', async () => {
  const instant = plane(false);
  try {
    instant.p.present(instant.frame(false)); instant.p.flush(); instant.writes.length = 0;
    instant.p.present(instant.frame(true));
    const seen = [...new Set(railColours(instant.writes.join('')))];
    assert.ok(seen.length > 0 && seen.every(colour => instant.allLit.has(colour)), 'only the fully lit colours, no intermediate frame: ' + seen.join(' '));
  } finally {instant.p.dispose();}
  const t = plane();
  try {
    t.p.present(t.frame(true)); await delay(400);
    assert.equal(t.latest(), t.lit);
    t.writes.length = 0; setTerminalFocus(false); await delay(400);
    assert.equal(t.latest(), t.quiet, 'window focus-out dims the focused region');
    t.writes.length = 0; setTerminalFocus(true); await delay(400);
    assert.equal(t.latest(), t.lit, 'focus-in restores it');
  } finally {setTerminalFocus(undefined); t.p.dispose();}
});
