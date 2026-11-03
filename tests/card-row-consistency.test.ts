import test from 'node:test';
import assert from 'node:assert/strict';
import stringWidth from 'string-width';
import {RuntimeStore} from '../src/runtime/store.js';
import {Steps} from '../src/runtime/steps.js';
import {buildStageRows} from '../src/tui/timeline/stage.js';
import {hoveredCardAt, type SceneRow} from '../src/tui/timeline/scene.js';
import {rowSegments} from '../src/tui/timeline/row-presentation.js';
import {palette} from '../src/tui/appearance/theme.js';
import {cast} from '../src/actors/ensemble.js';

type Surface = 'kalon' | 'logox';
interface Case {name: string; build(ctx: {store: RuntimeStore; steps: Steps; advance(ms: number): void}): void; find(rows: readonly SceneRow[]): SceneRow | undefined; ids?: boolean}

function scene(surface: Surface, build: Case['build']) {
  const store = new RuntimeStore();
  let now = Date.now() - 20_000;
  const actor = surface === 'kalon';
  store.activities.create({sessionId: 's', activityId: 'a', ownerId: surface, kind: actor ? 'actor' : 'director', title: 'Pelican', taskTitle: 'Pelican animation', status: 'running', stage: 'x', detail: ''});
  store.message('s', actor ? 'kalon' : 'user', 'user', 'Check the pelican files.', {activityId: 'a', inputKind: actor ? 'director' : 'human'});
  const steps = new Steps(store, {sessionId: 's', activityId: 'a', ownerId: surface}, () => now);
  build({store, steps, advance: ms => {now += ms;}});
  return (hovered: string | null) => buildStageRows(store.getSnapshot(), 's', 'logox', 100, {a: true}, hovered);
}

const finishedTool = ({steps, advance}: Parameters<Case['build']>[0]) => {
  const id = steps.tool({id: 'read1', name: 'Read', arguments: JSON.stringify({file_path: 'G:/p/pelican.html'})});
  steps.start(id); advance(1300);
  steps.finish(id, 'completed', 'Read\n' + Array.from({length: 42}, (_, i) => 'line ' + i).join('\n'));
};

const cases: Case[] = [
  {name: 'single tool with status and size', build: finishedTool, find: rows => rows.find(r => /▮ Read/.test(r.displayText ?? r.text))},
  {name: 'finished thinking', build({store, steps, advance}) {
    const id = steps.thinking(); store.appendMessage(id, 'check first'); advance(2000); steps.finish(id, 'completed'); steps.endGroup('completed');
  }, find: rows => rows.find(r => /▸ Thought for/.test(r.displayText ?? r.text))},
  {name: 'collapsed tool group', build({steps, advance}) {
    for (const [name, args] of [['Grep', {pattern: 'pedal'}], ['Read', {file_path: 'G:/p/a.ts'}]] as const) {
      const id = steps.tool({id: name + advance.length, name, arguments: JSON.stringify(args)}); steps.start(id); advance(400); steps.finish(id, 'completed', name + '\nok');
    }
  }, find: rows => rows.find(r => /[▸▾] [A-Z][\w' -]* \d+ (?:pattern|file)/.test(r.displayText ?? r.text))},
  {name: 'SendMessage', build({steps, advance}) {
    const id = steps.tool({id: 'send1', name: 'SendMessage', arguments: JSON.stringify({to: 'techne', summary: 'Hand off', message: 'Palette is ready'})});
    steps.start(id); advance(500); steps.finish(id, 'completed', 'SendMessage\nQueued');
  }, find: rows => rows.find(r => /SendMessage to/.test(r.displayText ?? r.text))},
];
const actorOnly: Case[] = [
  {name: 'Task from', build() {}, find: rows => rows.find(r => /Task from/.test(r.displayText ?? r.text))},
  {name: 'Message from with summary', build({store}) {
    store.message('s', 'kalon', 'user', '[Message from techne · Shell ready]\nindex.html is on disk.', {activityId: 'a', source: 'techne', inputKind: 'collaboration'});
  }, find: rows => rows.find(r => /Message from/.test(r.displayText ?? r.text))},
];

interface Cell {readonly ch: string; readonly color: string | undefined; readonly sep: boolean; readonly key: string | undefined}
function cells(row: SceneRow): Cell[] {
  return (row.segments ?? []).flatMap(s => s.selectionKey?.startsWith('│') ? [] : [...s.text].map(ch => ({ch, color: s.color, sep: s.text === ' · ', key: s.selectionKey})));
}

for (const surface of ['kalon', 'logox'] as const) {
  for (const item of surface === 'kalon' ? [...cases, ...actorOnly] : cases) {
    test(`${item.name} inside ${surface === 'kalon' ? 'a Kalon actor card' : 'the Logox timeline'}: separators, hover region and highlight`, () => {
      const rows = scene(surface, item.build);
      const row = item.find(rows(null));
      assert.ok(row, 'row exists');
      const id = row.messageId;

      // (a) every separator segment is muted
      const separators = (row.segments ?? []).filter(s => s.text.trim() === '·');
      if (item.name !== 'finished thinking') assert.ok(separators.length > 0, 'row has a separator to check');
      for (const s of separators) assert.equal(s.color, palette.muted, 'separator is muted: ' + JSON.stringify(s.text));
      assert.ok(!(row.segments ?? []).some(s => s.text.includes(' · ') && s.text !== ' · '), 'no segment mixes a separator with other text');

      // (b) the hover region ends at the last non-blank cell, status included
      const end = row.gutterCols + stringWidth(row.text.trimEnd());
      assert.equal(row.hover?.foldId, id);
      assert.equal(row.hover?.endCol, end, 'hover reaches the last non-blank cell');
      assert.equal(hoveredCardAt(row, end - 1), id);
      assert.equal(hoveredCardAt(row, end), null, 'trailing blanks are outside');

      // (c) hovering recolors muted segments (not separators) with the surface owner's color
      const expected = surface === 'kalon' ? cast.kalon!.color : palette.accent;
      const hoveredRow = item.find(rows(id))!;
      const before = cells(row), after = cells(hoveredRow);
      assert.equal(after.length, before.length);
      let recolored = 0;
      before.forEach((cell, index) => {
        const now = after[index]!;
        if (!cell.ch.trim() && !cell.sep) return;
        if (cell.sep) return assert.equal(now.color, palette.muted, 'separators never recolor');
        if (cell.color === palette.muted && cell.ch.trim() && !cell.key?.endsWith(':icon')) {
          assert.equal(now.color, expected, `muted ${JSON.stringify(cell.ch)} (${cell.key}) takes the surface color`);
          recolored++;
        } else if (cell.color && cell.color !== expected) assert.equal(now.color, cell.color, `semantic color kept for ${cell.key}`);
      });
      assert.ok(recolored > 0, 'something recolors');
    });
  }
}

test('an actor card header highlights in the actor color on the Logox timeline, never Logox accent', () => {
  const rowsFor = scene('kalon', finishedTool);
  const logoxRows = (hovered: string | null) => rowsFor(hovered);
  const header = logoxRows(null).find(r => /✧ Kalon/.test(r.displayText ?? r.text))!;
  assert.ok(header, 'actor card header exists');
  assert.equal(header.hoverColor, cast.kalon!.color, 'header rows highlight in the actor color');
  assert.equal(header.railColor, palette.accent, 'the rail stays on the hosting surface');
  for (const hovered of [null, header.messageId]) {
    const row = logoxRows(hovered).find(r => /✧ Kalon/.test(r.displayText ?? r.text))!;
    for (const segment of rowSegments(row, true)) {
      if (!segment.text.trim()) continue;
      assert.notEqual(segment.color, palette.accent, `header segment ${JSON.stringify(segment.text)} must not take the Logox accent`);
    }
    const status = rowSegments(row, true).find(s => /▾|▸/.test(s.text))!;
    assert.equal(status.color, cast.kalon!.color, 'the status text and arrow take the actor color when the row highlights');
  }
});
