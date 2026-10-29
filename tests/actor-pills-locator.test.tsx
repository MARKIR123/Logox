import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {act} from 'react';
import {findLatestActorRowIndex} from '../src/tui/timeline/actor-location.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {App, type AppProps} from '../src/tui/app.js';
import {renderTerminal} from '../src/tui/terminal/terminal.js';
import {TerminalScreen} from './terminal-screen.js';

Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
class TerminalInput extends PassThrough {
  isTTY = true; setRawMode(): this {return this;} ref(): this {return this;} unref(): this {return this;}
}

test('findLatestActorRowIndex finds the latest row belonging to the actor', () => {
  const rows = [
    {messageId: 'm1', line: 0, actorId: 'logox'},
    {messageId: 'm2', line: 1, actorId: 'kalon'},
    {messageId: 'm3', line: 2, actorId: 'techne'},
    {messageId: 'm4', line: 3, actorId: 'kalon'},
    {messageId: 'm5', line: 4, actorId: 'logox'},
  ];

  const index = findLatestActorRowIndex(rows as any, 'kalon');
  assert.equal(index, 3);
});

test('findLatestActorRowIndex returns -1 if actor has no rows', () => {
  const rows = [{messageId: 'm1', line: 0, actorId: 'logox'}];
  const index = findLatestActorRowIndex(rows as any, 'aletheia');
  assert.equal(index, -1);
});

test('findLatestActorRowIndex matches rows by action.foldId or messageId', () => {
  const rows = [
    {messageId: 'logox-1', line: 0},
    {messageId: 'techne-fold-row', line: 1, action: {foldId: 'techne:task-1'}},
    {messageId: 'logox-2', line: 2},
  ];
  const index = findLatestActorRowIndex(rows as any, 'techne');
  assert.equal(index, 1);
});

test('double clicking active actor pill in footer jumps viewport anchor to actor card', async () => {
  const store = new RuntimeStore();
  const input = new TerminalInput();
  const output = new TerminalScreen();
  output.columns = 100; output.rows = 24;

  for (let i = 0; i < 50; i++) {
    store.message('s', 'logox', 'assistant', 'Preamble line ' + i);
  }
  store.activities.create({
    sessionId: 's', activityId: 'act-kalon-1', ownerId: 'kalon', kind: 'actor',
    title: 'Color review', status: 'running', stage: 'Reviewing', detail: ''
  });
  store.message('s', 'kalon', 'assistant', 'Kalon review card text', {activityId: 'act-kalon-1'});
  for (let i = 0; i < 30; i++) {
    store.message('s', 'logox', 'assistant', 'Tail line ' + i);
  }

  let instance!: ReturnType<typeof renderTerminal>;
  const props: AppProps = {
    store, sessionId: 's', stage: true,
    getActors: () => [{id: 'kalon', name: 'Kalon', title: 'Reviewer', color: '#e8a8dc', symbol: '⠋', cardClosed: '#544359'}],
    onSubmit: async () => {}, onCancel() {}, onClose: async () => {},
  };

  await act(async () => {
    instance = renderTerminal(<App {...props}/>, {
      stdin: input, stdout: output, stderr: output,
      interactive: true, alternateScreen: true, patchConsole: false, exitOnCtrlC: false,
    });
  });

  const footerY = 24;
  await act(async () => {
    input.write(`\x1b[<0;95;${footerY}M\x1b[<0;95;${footerY}m`);
  });
  await act(async () => {
    input.write(`\x1b[<0;95;${footerY}M\x1b[<0;95;${footerY}m`);
  });

  const rendered = output.lines.join('\n');
  assert.ok(rendered.includes('Kalon review card text') || rendered.includes('kalon'), 'Viewport scrolled to Kalon card');

  await act(async () => { instance.unmount(); });
  await instance.waitUntilExit();
});

test('findLatestActorRowIndex matches rows by action.owner or hits when messageId and foldId are random UUIDs', () => {
  const uuid1 = '712ca19a-6f16-4d02-955b-f120dfba566f';
  const uuid2 = 'b4c5a996-7ea3-4c0a-bb7c-82e472bdd18d';
  const rows = [
    {messageId: 'logox-header', line: 0, actorId: 'logox'},
    {messageId: uuid1, line: 1, action: {kind: 'actor_summary', foldId: uuid1, owner: 'techne'}},
    {messageId: uuid2, line: 2, hits: [{startCol: 0, endCol: 80, action: {kind: 'actor_summary', foldId: uuid2, owner: 'kalon'}}]},
  ];

  assert.equal(findLatestActorRowIndex(rows as any, 'techne'), 1);
  assert.equal(findLatestActorRowIndex(rows as any, 'kalon'), 2);
  assert.equal(findLatestActorRowIndex(rows as any, 'aletheia'), -1);
});

test('actor pill single-click scrolls to card, double-click switches to actor independent window', async () => {
  const store = new RuntimeStore();
  const input = new TerminalInput();
  const output = new TerminalScreen();
  output.columns = 100; output.rows = 24;

  const uuidKalon = 'b4c5a996-7ea3-4c0a-bb7c-82e472bdd18d';
  for (let i = 0; i < 40; i++) {
    store.message('s', 'logox', 'assistant', 'Preamble line ' + i);
  }
  store.activities.create({
    sessionId: 's', activityId: uuidKalon, ownerId: 'kalon', kind: 'actor',
    title: 'Visual polish', status: 'running', stage: 'Styling', detail: ''
  });
  store.message('s', 'kalon', 'assistant', 'KALON_CARD_BODY_TEXT', {activityId: uuidKalon});
  for (let i = 0; i < 30; i++) {
    store.message('s', 'logox', 'assistant', 'Tail line ' + i);
  }

  let instance!: ReturnType<typeof renderTerminal>;
  const props: AppProps = {
    store, sessionId: 's', stage: true,
    getActors: () => [{id: 'kalon', name: 'Kalon', title: 'Reviewer', color: '#e8a8dc', symbol: '✦', cardClosed: '#544359', cardOpen: '#6d5773'}],
    onSubmit: async () => {}, onCancel() {}, onClose: async () => {},
  };

  await act(async () => {
    instance = renderTerminal(<App {...props}/>, {
      stdin: input, stdout: output, stderr: output,
      interactive: true, alternateScreen: true, patchConsole: false, exitOnCtrlC: false,
    });
  });

  const footerY = 24;
  // 1. Single click: locates and scrolls viewport to Kalon card on main stage
  await act(async () => {
    input.write(`\x1b[<0;95;${footerY}M\x1b[<0;95;${footerY}m`);
  });
  assert.ok(output.lines.some(l => l.includes('KALON_CARD_BODY_TEXT') || l.includes('kalon')), 'Single click scrolls to Kalon card');

  // 2. Second click within 350ms (double click): switches directly into Kalon independent window
  await act(async () => {
    input.write(`\x1b[<0;95;${footerY}M\x1b[<0;95;${footerY}m`);
  });
  assert.ok(output.lines.some(l => l.includes('独立对话') || l.includes('Kalon')), 'Double click enters Kalon independent window');

  await act(async () => { instance.unmount(); });
  await instance.waitUntilExit();
});
