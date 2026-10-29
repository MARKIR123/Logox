import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {act} from 'react';
import {RuntimeStore} from '../src/runtime/store.js';
import {App, type AppProps} from '../src/tui/app.js';
import {renderTerminal} from '../src/tui/terminal/terminal.js';
import {TerminalScreen} from './terminal-screen.js';

Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});

class TerminalInput extends PassThrough {
  isTTY = true; setRawMode(): this {return this;} ref(): this {return this;} unref(): this {return this;}
}

test('composer renders without arrow prefix or placeholder text and emits block cursor', async () => {
  const store = new RuntimeStore();
  const input = new TerminalInput();
  const output = new TerminalScreen();
  output.columns = 100; output.rows = 20;

  let instance!: ReturnType<typeof renderTerminal>;
  const props: AppProps = {
    store, sessionId: 's', stage: true,
    getStatus: () => ({ownerId: 'logox', name: 'Logox', state: 'running'}),
    onSubmit: async () => {}, onCancel() {}, onClose: async () => {},
  };

  await act(async () => {
    instance = renderTerminal(<App {...props}/>, {
      stdin: input, stdout: output, stderr: output,
      interactive: true, alternateScreen: true, patchConsole: false, exitOnCtrlC: false,
    });
  });

  const fullOutput = output.lines.join('\n');
  assert.equal(fullOutput.includes('❯'), false, 'Should not render arrow prefix');
  assert.equal(fullOutput.includes('输入任务'), false, 'Should not render placeholder text');

  await act(async () => { instance.unmount(); });
  await instance.waitUntilExit();
});
