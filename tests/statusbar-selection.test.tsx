import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {act} from 'react';
import {extractStatusBarSlice} from '../src/tui/status/statusbar.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {App, type AppProps} from '../src/tui/app.js';
import {renderTerminal} from '../src/tui/terminal/terminal.js';
import {TerminalScreen} from './terminal-screen.js';

Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
class TerminalInput extends PassThrough {
  isTTY = true; setRawMode(): this {return this;} ref(): this {return this;} unref(): this {return this;}
}

test('extractStatusBarSlice extracts substring between start and end columns', () => {
  const text = 'Logox · claude-opus-5 · 1.2k tokens · master';
  const sliced = extractStatusBarSlice(text, 8, 21);
  assert.equal(sliced, 'claude-opus-5');
});

test('extractStatusBarSlice handles reverse drag (end < start)', () => {
  const text = 'Logox · claude-opus-5 · 1.2k tokens · master';
  const sliced = extractStatusBarSlice(text, 21, 8);
  assert.equal(sliced, 'claude-opus-5');
});

test('mouse dragging on status bar copies selected text via OSC 52', async () => {
  const store = new RuntimeStore();
  const input = new TerminalInput();
  const output = new TerminalScreen();
  output.columns = 100; output.rows = 24;

  let instance!: ReturnType<typeof renderTerminal>;
  const props: AppProps = {
    store, sessionId: 's', stage: true,
    getStatus: () => ({ownerId: 'logox', name: 'Logox', state: 'running', model: {provider: 'anthropic', model: 'claude-opus-5'}}),
    onSubmit: async () => {}, onCancel() {}, onClose: async () => {},
  };

  await act(async () => {
    instance = renderTerminal(<App {...props}/>, {
      stdin: input, stdout: output, stderr: output,
      interactive: true, alternateScreen: true, patchConsole: false, exitOnCtrlC: false,
    });
  });

  const footerY = 24; // 1-based row 24
  // Drag across statusbar text columns 1..25
  await act(async () => {
    input.write(`\x1b[<0;1;${footerY}M`); // press
  });
  await act(async () => {
    input.write(`\x1b[<32;20;${footerY}M`); // drag to col 20
  });
  await act(async () => {
    input.write(`\x1b[<0;20;${footerY}m`); // release
  });

  // Verify OSC 52 sequence was written to stdout
  assert.match(output.text, /\x1b\]52;c;/);

  await act(async () => { instance.unmount(); });
  await instance.waitUntilExit();
});
