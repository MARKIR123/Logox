import test from 'node:test';
import assert from 'node:assert/strict';
import {createBuilder, appendActorCard} from '../src/tui/scene.js';
import {decorateRow, stepIcon} from '../src/tui/row-presentation.js';

test('stepIcon uses natural frame pacing for breathing rhythm', () => {
  const custom8Frames = ['·', '○', '⊙', '⊚', '◉', '⊚', '⊙', '○'];
  // ≤ 8 frames: 200ms per frame
  assert.equal(stepIcon({state: 'running'} as any, 0, true, custom8Frames), '·');
  assert.equal(stepIcon({state: 'running'} as any, 199, true, custom8Frames), '·');
  assert.equal(stepIcon({state: 'running'} as any, 200, true, custom8Frames), '○');
  assert.equal(stepIcon({state: 'running'} as any, 400, true, custom8Frames), '⊙');
  assert.equal(stepIcon({state: 'running'} as any, 800, true, custom8Frames), '◉');
  assert.equal(stepIcon({state: 'running'} as any, 1600, true, custom8Frames), '·');

  // Motion false returns static bullet
  assert.equal(stepIcon({state: 'running'} as any, 400, false, custom8Frames), '·');
});

test('Actor card when active reuses thinking animation and breathing title wave', () => {
  const roles = {
    techne: {
      symbol: '⊞',
      name: 'Techne',
      title: '精工',
      color: '#e5b567',
      thinkingAnimation: ['▖', '▌', '▘', '▀', '▝', '▐', '▗', '▄'],
    },
  };

  // 1. Collapsed active card: outer icon spins through thinkingAnimation, title breathes
  const b1 = createBuilder(80, null, roles);
  appendActorCard(b1, {
    id: 'techne-task',
    owner: 'techne',
    roles,
    task: 'Refactor transport layer',
    status: '运行中',
    open: false,
    railColor: '#e5b567',
    active: true,
    renderBody: () => {},
  });

  const rowCollapsed = b1.rows.find(r => r.messageId === 'techne-task')!;
  const decEarly = decorateRow(rowCollapsed, 0, true);
  const decMid = decorateRow(rowCollapsed, 400, true);

  // Icon animates across paced frames
  const iconEarly = decEarly.segments?.find(s => s.selectionKey === 'techne-task:icon')?.text;
  const iconMid = decMid.segments?.find(s => s.selectionKey === 'techne-task:icon')?.text;
  assert.equal(iconEarly, '▖');
  assert.equal(iconMid, '▘');

  // Title shimmers with breathing luster
  const titleEarly = decEarly.segments?.filter(s => s.selectionKey === 'techne-task:title');
  const titleMid = decMid.segments?.filter(s => s.selectionKey === 'techne-task:title');
  assert.ok(titleEarly && titleEarly.length > 0);
  assert.notDeepEqual(titleEarly, titleMid, 'Title color breathes across animation frames');

  // 2. Inactive card (completed): restores static symbol and clean title
  const b2 = createBuilder(80, null, roles);
  appendActorCard(b2, {
    id: 'techne-task-done',
    owner: 'techne',
    roles,
    task: 'Refactor transport layer',
    status: '已完成',
    open: false,
    railColor: '#e5b567',
    active: false,
    renderBody: () => {},
  });
  const rowDone = b2.rows.find(r => r.messageId === 'techne-task-done')!;
  const decDone = decorateRow(rowDone, 400, true);
  const iconDone = decDone.segments?.find(s => s.selectionKey === 'techne-task-done:icon')?.text;
  assert.equal(iconDone, '⊞');
});
