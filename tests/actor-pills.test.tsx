import test from 'node:test';
import assert from 'node:assert/strict';
import {computeActivePills, type ActivePillItem} from '../src/tui/status/actor-pills.js';
import {mixHex} from '../src/tui/appearance/colors.js';
import {palette} from '../src/tui/appearance/theme.js';

test('computeActivePills maintains activation order docking newest on the right', () => {
  const roles = {
    kalon: {name: 'Kalon', color: '#e8a8dc', thinkingAnimation: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧']},
    techne: {name: 'Techne', color: '#e5b567', thinkingAnimation: ['▖', '▌', '▘', '▀', '▝', '▐', '▗', '▄']},
  };
  const activities = [
    {activityId: 'a1', ownerId: 'kalon', status: 'running', sessionId: 's'},
    {activityId: 'a2', ownerId: 'techne', status: 'running', sessionId: 's'},
  ];

  // Oldest first, newest last (docked on the right)
  const pills = computeActivePills(activities as any, 's', roles as any, 0, 100, ['kalon', 'techne']);
  assert.equal(pills.length, 2);
  assert.equal(pills[0]!.ownerId, 'kalon');
  assert.equal(pills[1]!.ownerId, 'techne');
  assert.equal(pills[0]!.icon, '⠋');
  assert.equal(pills[1]!.icon, '▖');
  // Right docked: techne's endX should equal containerWidth
  assert.equal(pills[1]!.endX, 100);
  assert.ok(pills[0]!.startX < pills[1]!.startX);
});

test('computeActivePills removes completed actors and shifts remaining right', () => {
  const roles = {
    kalon: {name: 'Kalon', color: '#e8a8dc'},
    techne: {name: 'Techne', color: '#e5b567'},
  };
  const activities = [
    {activityId: 'a1', ownerId: 'kalon', status: 'completed', sessionId: 's'},
    {activityId: 'a2', ownerId: 'techne', status: 'running', sessionId: 's'},
  ];
  const pills = computeActivePills(activities as any, 's', roles as any, 0, 100, ['kalon', 'techne']);
  assert.equal(pills.length, 1);
  assert.equal(pills[0]!.ownerId, 'techne');
  assert.equal(pills[0]!.endX, 100);
});

test('pill colours derive from the actor colour: ~26% tint behind a lightened copy', () => {
  const roles = {kalon: {name: 'Kalon', color: '#b3a0d4', cardClosed: '#123456'}};
  const [pill] = computeActivePills([{activityId: 'a1', ownerId: 'kalon', status: 'running', sessionId: 's'}] as any, 's', roles as any, 0, 100, ['kalon']);
  assert.equal(pill!.bg, mixHex('#b3a0d4', palette.bg, 0.26));
  assert.equal(pill!.fg, mixHex('#b3a0d4', palette.strong, 0.85));
});
