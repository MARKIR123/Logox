import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {act} from 'react';
import {renderTerminal} from '../src/tui/terminal.js';
import {TerminalScreen} from './terminal-screen.js';
import {TabbedPage} from '../src/tui/tabbed-page.js';

Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});

class TerminalInput extends PassThrough {
  isTTY = true; setRawMode(): this {return this;} ref(): this {return this;} unref(): this {return this;}
}

test('TabbedPage omits top tab bar row when only 1 tab is present', async () => {
  const output = new TerminalScreen();
  output.columns = 60; output.rows = 15;
  const input = new TerminalInput();
  const stderr = new PassThrough();

  const tabs = [{id: 'config', title: 'Settings', lines: ['Line 1', 'Line 2']}];
  let instance!: ReturnType<typeof renderTerminal>;

  await act(async () => {
    instance = renderTerminal(
      <TabbedPage title="Settings" tabs={tabs} initialTab="config" width={60} height={15} onClose={() => {}}/>,
      {stdout: output, stdin: input, stderr, interactive: true, alternateScreen: true, patchConsole: false, exitOnCtrlC: false}
    );
  });
  await act(async () => { await instance.waitUntilRenderFlush(); });

  const frame = output.lines.join('\n');
  assert.equal(frame.includes('1/1'), false, 'Must not render 1/1 tab counter');
  assert.ok(frame.includes('Line 1'), 'Renders content directly');

  await act(async () => { instance.unmount(); });
  await instance.waitUntilExit();
});

test('TabbedPage cycles multi-option toggle item on Space', async () => {
  const output = new TerminalScreen();
  output.columns = 60; output.rows = 15;
  const input = new TerminalInput();
  const stderr = new PassThrough();

  const toggles = [
    {id: 'theme', label: 'Theme preset', value: 'Logox Dark', options: ['Logox Dark', 'Claude Warm', 'Nord Polar'], enabled: true},
  ];
  const tabs = [{id: 'config', title: 'Settings', lines: [], toggles}];
  let savedItems: any[] | undefined;
  let instance!: ReturnType<typeof renderTerminal>;

  await act(async () => {
    instance = renderTerminal(
      <TabbedPage title="Settings" tabs={tabs} initialTab="config" width={60} height={15}
        onSave={(_tabId, items) => { savedItems = items as any; }} onClose={() => {}}/>,
      {stdout: output, stdin: input, stderr, interactive: true, alternateScreen: true, patchConsole: false, exitOnCtrlC: false}
    );
  });
  await act(async () => { await instance.waitUntilRenderFlush(); });

  assert.ok(output.lines.join('\n').includes('Logox Dark'));

  // Press Space to cycle option to Claude Warm
  await act(async () => { input.write(' '); });
  await act(async () => { await instance.waitUntilRenderFlush(); });
  assert.ok(output.lines.join('\n').includes('Claude Warm'));

  // Press Return to save
  await act(async () => { input.write('\r'); });
  await act(async () => { await instance.waitUntilRenderFlush(); });
  assert.equal(savedItems?.[0]?.value, 'Claude Warm');

  await act(async () => { instance.unmount(); });
  await instance.waitUntilExit();
});
