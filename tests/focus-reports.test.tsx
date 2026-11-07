import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {act} from 'react';
import {setTimeout as delay} from 'node:timers/promises';
import {renderTerminal as render} from '../src/tui/terminal/terminal.js';
import {TerminalScreen} from './terminal-screen.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {App} from '../src/tui/app.js';
import {FocusReportFilter, setTerminalFocus, terminalFocus} from '../src/tui/terminal/focus.js';

Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});

class TerminalInput extends PassThrough {
  isTTY = true;
  isRaw = false;
  setRawMode(value: boolean): this {this.isRaw = value; return this;}
  ref(): this {return this;}
  unref(): this {return this;}
}

async function session(run: (h: {write(text: string): Promise<void>; writeParts(...parts: string[]): Promise<void>; input: TerminalInput; output: TerminalScreen; submissions: string[]; reads: boolean[]; closed(): boolean}) => Promise<void>): Promise<void> {
  const input = new TerminalInput();
  const reads: Array<boolean> = [];
  const underlying = input.read.bind(input);
  input.read = ((size?: number) => {const chunk = underlying(size); reads.push(chunk !== null); return chunk;}) as typeof input.read;
  const output = new TerminalScreen(), store = new RuntimeStore(), submissions: string[] = [];
  let closed = false;
  let instance!: ReturnType<typeof render>;
  await act(async () => {
    instance = render(<App store={store} sessionId="s" onSubmit={async text => {submissions.push(text);}} onCancel={() => {}}
      onClose={async () => {closed = true;}}/>, {stdout: output, stdin: input, stderr: output, interactive: true, alternateScreen: true,
      patchConsole: false, exitOnCtrlC: false, maxFps: 100});
  });
  const writeParts = async (...parts: string[]) => {
    // Parts arrive as separate chunks a few milliseconds apart, inside Ink's pending-escape window.
    await act(async () => {for (const part of parts) {input.write(part); await delay(4);} await delay(30);});
    await act(async () => {await instance.waitUntilRenderFlush();});
  };
  const write = async (text: string) => {
    await act(async () => {input.write(text); await delay(30);});
    await act(async () => {await instance.waitUntilRenderFlush();});
  };
  setTerminalFocus(undefined);
  try {
    await run({write, writeParts, input, output, submissions, reads, closed: () => closed});
  } finally {
    await act(async () => {instance.unmount(); await delay(10);});
    setTerminalFocus(undefined);
  }
}

test('focus out/in reports keep the app alive, update focus state and never reach the input', {timeout: 8000}, async () => {
  await session(async h => {
    assert.ok(h.output.text.includes('\x1b[?1004h'), 'focus reporting enabled');
    await h.write('\x1b[O');
    assert.equal(terminalFocus(), false);
    assert.equal(h.input.isRaw, true, 'raw mode still on after focus out');
    assert.equal(h.reads.at(-1), false, 'a focus-only chunk is followed by the stream own end-of-buffer read');
    assert.equal(h.closed(), false);
    await h.write('\x1b[I');
    assert.equal(terminalFocus(), true);
    await h.write('ab');
    await h.write('\x1b[Oc\x1b[Id');
    await h.write('\r');
    assert.deepEqual(h.submissions, ['abcd'], 'keys typed around focus reports arrive intact');
    assert.equal(h.input.isRaw, true);
  });
});

test('focus reports split across chunks are tracked and never become Escape or text', {timeout: 8000}, async () => {
  await session(async h => {
    await h.write('x');
    await h.writeParts('', '[O');
    assert.equal(terminalFocus(), false);
    await h.writeParts('[', 'I');
    assert.equal(terminalFocus(), true);
    await h.write('y');
    await h.write('\r');
    assert.deepEqual(h.submissions, ['xy']);
    assert.equal(h.closed(), false);
  });
});

test('focus reports mixed with mouse reports leave both paths working', {timeout: 8000}, async () => {
  await session(async h => {
    await h.write('[<35;10;5M[O[<35;11;5M[<64;10;5M');
    assert.equal(terminalFocus(), false);
    await h.writeParts('[<35;12;5M[<', '35;13;5M[I');
    assert.equal(terminalFocus(), true);
    await h.write('z');
    await h.write('\r');
    assert.deepEqual(h.submissions, ['z']);
    assert.equal(h.input.isRaw, true);
    assert.equal(h.closed(), false);
  });
});

test('FocusReportFilter strips whole reports and tracks ones split across chunks', () => {
  const filter = new FocusReportFilter();
  setTerminalFocus(undefined);
  assert.equal(filter.push('\x1b[O'), '');
  assert.equal(terminalFocus(), false);
  assert.equal(filter.push('a\x1b[Ib'), 'ab');
  assert.equal(terminalFocus(), true);
  assert.equal(filter.push('\x1b'), '\x1b');
  assert.equal(filter.push('[O'), '[O', 'halves stay for Ink to re-join');
  assert.equal(terminalFocus(), false);
  assert.equal(filter.push('\x1b['), '\x1b[');
  assert.equal(filter.push('I'), 'I');
  assert.equal(terminalFocus(), true);
  assert.equal(filter.push('\x1b[A'), '\x1b[A', 'other CSI keys are untouched');
  setTerminalFocus(undefined);
});
