import test from 'node:test';
import assert from 'node:assert/strict';
import {act} from 'react';
import {render} from 'ink';
import {PassThrough} from 'node:stream';
import {App} from '../src/tui/app.js';
import {TerminalPlaneContext} from '../src/tui/terminal/terminal.js';
import {TerminalPlane, type PlaneFrame} from '../src/tui/terminal/terminal-plane.js';
import type {SceneRow} from '../src/tui/timeline/scene.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {builtinActors} from '../src/actors/builtins.js';
import {applyTheme, palette} from '../src/config/theme-palette.js';
import {TerminalScreen} from './terminal-screen.js';

Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
class Input extends PassThrough {
  isTTY = true;
  setRawMode(): this {return this;}
  ref(): this {return this;}
  unref(): this {return this;}
}
class CapturedPlane extends TerminalPlane {
  captured: PlaneFrame | undefined;
  constructor() {super(() => {});}
  override present(frame: PlaneFrame): void {this.captured = frame;}
  override get rows() {return this.captured?.rows ?? [];}
  override get time() {return 100;}
}

test('App rerender refreshes history colors with unchanged snapshot and stable actor definitions', async () => {
  const previous = {...palette}, input = new Input(), output = new TerminalScreen(), plane = new CapturedPlane();
  const store = new RuntimeStore();
  store.message('s', 'logox', 'assistant', 'Theme switch probe');
  const snapshot = store.getSnapshot();
  const props = {store, sessionId: 's', stage: true, getActors: () => builtinActors,
    onSubmit: async () => {}, onCancel: () => {}, onClose: async () => {}};
  const view = () => <TerminalPlaneContext.Provider value={plane}><App {...props}/></TerminalPlaneContext.Provider>;
  const color = () => {
    const row = plane.rows.find(row => row.text.includes('Theme switch probe')) as SceneRow | undefined;
    assert.ok(row, 'History frame contains the assistant body');
    return row.segments?.find(segment => segment.text.includes('Theme switch probe'))?.color;
  };
  let instance: ReturnType<typeof render> | undefined;
  try {
    applyTheme({fg: '#112233'});
    await act(async () => {instance = render(view(), {stdin: input, stdout: output, stderr: output,
      interactive: true, patchConsole: false, exitOnCtrlC: false, maxFps: 100});});
    await act(async () => {await instance!.waitUntilRenderFlush();});
    assert.equal(color(), '#112233');
    applyTheme({fg: '#445566'});
    await act(async () => {instance!.rerender(view());});
    await act(async () => {await instance!.waitUntilRenderFlush();});
    assert.equal(store.getSnapshot(), snapshot, 'No message or runtime change triggers this refresh');
    assert.equal(color(), '#445566');
  } finally {
    if (instance) {await act(async () => {instance!.unmount();}); await instance.waitUntilExit();}
    plane.dispose(); input.destroy(); output.destroy(); applyTheme(previous);
  }
});
