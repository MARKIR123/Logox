import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {act} from 'react';
import {renderTerminal} from '../src/tui/terminal.js';
import {TerminalScreen} from './terminal-screen.js';
import {ToggleList} from '../src/tui/toggle-list.js';

Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});

test('ToggleList renders option value when present with high contrast', async () => {
  const output = new TerminalScreen();
  output.columns = 80; output.rows = 10;
  const input = new PassThrough();

  const items = [
    {id: 'theme', label: 'Theme preset', value: 'Logox Dark', options: ['Logox Dark', 'Claude Warm'], enabled: true},
    {id: 'motion', label: 'UI animations', enabled: false},
  ];

  let instance!: ReturnType<typeof renderTerminal>;
  await act(async () => {
    instance = renderTerminal(
      <ToggleList items={items as any} selected={0} start={0} count={2} width={60}/>,
      {stdout: output, stdin: input, stderr: output, patchConsole: false}
    );
  });

  const frame = output.lines.join('\n');
  assert.ok(frame.includes('❯ Theme preset: Logox Dark'), 'Focused option item renders pointer and value');
  assert.ok(frame.includes('[ ] UI animations'), 'Unfocused boolean item renders checkbox');

  await act(async () => { instance.unmount(); });
  await instance.waitUntilExit();
});
