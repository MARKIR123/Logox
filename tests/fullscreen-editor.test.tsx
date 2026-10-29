import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {act, useState} from 'react';
import {useCursor, useWindowSize} from 'ink';
import stringWidth from 'string-width';
import {FullscreenEditor, fullscreenEditorLayout} from '../src/tui/input/fullscreen-editor.js';
import type {Draft} from '../src/tui/input/editor.js';
import {renderTerminal} from '../src/tui/terminal/terminal.js';
import {TerminalScreen} from './terminal-screen.js';

Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});

class FakeInput extends PassThrough {
  isTTY = true;
  setRawMode(): this {return this;}
  ref(): this {return this;}
  unref(): this {return this;}
}

// The owner holds the only draft. Assertions observe this public controlled value,
// terminal cells, or callback receipts, never React nodes or component state.
async function editorFixture(initial: Draft = {text: '', cursor: 0}, columns = 60, rows = 12) {
  const input = new FakeInput(), output = new TerminalScreen();
  output.columns = columns; output.rows = rows;
  let draft = initial, collapsed = 0, steered = 0, interrupted = 0, closed = 0;
  const submitted: Draft[] = [], copied: string[] = [];
  function Owner() {
    const [value, setValue] = useState(initial);
    const [scrollOffset, setScrollOffset] = useState<number | null>(null);
    const size = useWindowSize();
    const {setCursorPosition} = useCursor();
    return <FullscreenEditor draft={value} width={size.columns - 1} height={size.rows} onCursor={setCursorPosition}
      scrollOffset={scrollOffset} onScroll={setScrollOffset}
      onEdit={update => setValue(current => {draft = update(current); return draft;})}
      onCollapse={() => {collapsed++;}} onSubmit={() => {submitted.push(draft);}}
      onSteer={() => {steered++;}} onCopy={text => {copied.push(text);}}
      onInterrupt={() => {interrupted++;}} onClose={() => {closed++;}}/>;
  }
  let instance!: ReturnType<typeof renderTerminal>;
  await act(async () => {
    instance = renderTerminal(<Owner/>, {stdin: input, stdout: output, stderr: output,
      interactive: true, alternateScreen: true, patchConsole: false, exitOnCtrlC: false, maxFps: 100});
  });
  const flush = () => act(async () => {await instance.waitUntilRenderFlush();});
  await flush();
  const key = async (text: string) => {
    await act(async () => {
      input.write(text);
      // A real standalone Esc remains pending briefly to disambiguate Alt sequences.
      if (text === '\x1b') await delay(40);
    });
    await flush();
  };
  return {
    input, output, key, submitted, copied,
    get draft() {return draft;}, get collapsed() {return collapsed;}, get steered() {return steered;},
    get interrupted() {return interrupted;}, get closed() {return closed;},
    text: () => output.lines.join('\n'),
    async mouse(button: number, x: number, y: number, release = false) {
      await key(`\x1b[<${button};${x + 1};${y + 1}${release ? 'm' : 'M'}`);
    },
    async resize(width: number, height: number) {await act(async () => {output.resize(width, height);}); await flush();},
    async close() {
      try {await act(async () => {instance.unmount();}); await instance.waitUntilExit();}
      finally {input.destroy(); output.destroy();}
    },
  };
}

test('fullscreen Enter, Shift+Enter and Ctrl+J insert newlines; Ctrl+Enter submits only the press', {timeout: 10000}, async () => {
  const f = await editorFixture();
  try {
    await f.key('one'); await f.key('\r');
    await f.key('two'); await f.key('\x1b[13;2u');
    await f.key('three'); await f.key('\x0a'); await f.key('four');
    assert.deepEqual(f.draft, {text: 'one\ntwo\nthree\nfour', cursor: 18});
    assert.equal(f.submitted.length, 0);
    await f.key('\x1b[13;5:1u'); await f.key('\x1b[13;5:3u');
    assert.deepEqual(f.submitted, [{text: 'one\ntwo\nthree\nfour', cursor: 18}]);
    assert.equal(f.draft.text, 'one\ntwo\nthree\nfour', 'The editor leaves clearing to its owner');
  } finally {await f.close();}
});

test('large multiline paste preserves Unicode graphemes and original newlines across soft wrapping', {timeout: 10000}, async () => {
  const f = await editorFixture({text: 'AB', cursor: 1}, 24, 8);
  const lines = Array.from({length: 100}, (_, index) => `row ${index}: 中文🙂👩‍💻 e\u0301 ${'long '.repeat(5)}`);
  const original = lines.join('\r\n'), normalized = lines.join('\n');
  try {
    await f.key('\x1b[200~' + original.slice(0, 300));
    await f.key(original.slice(300) + '\x1b[201~');
    assert.equal(f.draft.text, 'A' + normalized + 'B');
    assert.equal(f.submitted.length, 0);
    await f.key('!');
    assert.equal(f.draft.text, 'A' + normalized + '!B', 'Typing stays at the pasted grapheme boundary');
    await f.key('\x1b[13;5u');
    assert.equal(f.submitted.length, 1);
    assert.equal(f.submitted[0]!.text, 'A' + normalized + '!B', 'Display soft wraps never enter the submitted source');
    assert.match(f.text(), /row 99/);
  } finally {await f.close();}
});

test('arrows, Home/End, word wiping and typing replacement edit the controlled draft', {timeout: 10000}, async () => {
  const f = await editorFixture({text: 'alpha beta\nsecond line\nlast', cursor: 0});
  try {
    await f.key('\x1b[F');
    assert.equal(f.draft.cursor, 10);
    await f.key('\x1b[B'); await f.key('\x1b[H'); await f.key('>');
    assert.equal(f.draft.text, 'alpha beta\n>second line\nlast');
    await f.key('\x1b[F'); await f.key('\x17');
    assert.equal(f.draft.text, 'alpha beta\n>second \nlast');
    await f.key('\x1b[A'); await f.key('\x1b[H');
    await f.key('\x1b[1;2C'); await f.key('\x1b[1;2C');
    await f.key('\x03');
    assert.deepEqual(f.copied, ['al']);
    assert.equal(f.interrupted, 0, 'Ctrl+C with a selection copies instead of interrupting');
    await f.key('AL');
    assert.equal(f.draft.text, 'ALpha beta\n>second \nlast');
    await f.key('\x1b[1;5C'); await f.key('!');
    assert.equal(f.draft.text, 'ALpha !beta\n>second \nlast');
  } finally {await f.close();}
});

test('Esc clears a selection before collapsing, while select-all copy/cut respect grapheme boundaries', {timeout: 10000}, async () => {
  const f = await editorFixture({text: 'A🙂e\u0301Z', cursor: 4});
  try {
    await f.key('\x1b[1;2D'); await f.key('\x1b');
    assert.equal(f.collapsed, 0);
    assert.equal(f.draft.text, 'A🙂e\u0301Z');
    await f.key('!');
    assert.equal(f.draft.text, 'A🙂e\u0301!Z', 'The first Esc removes selection without deleting selected text');
    await f.key('\x01'); await f.key('\x03');
    assert.deepEqual(f.copied, ['A🙂e\u0301!Z']);
    await f.key('\x18');
    assert.equal(f.draft.text, '');
    assert.deepEqual(f.copied, ['A🙂e\u0301!Z', 'A🙂e\u0301!Z']);
    await f.key('\x1b');
    assert.equal(f.collapsed, 1);
    assert.equal(f.interrupted, 0);
  } finally {await f.close();}
});

test('mouse drag selects source text and Send/Collapse buttons act once without inserting input', {timeout: 10000}, async () => {
  const f = await editorFixture({text: 'hello world', cursor: 11});
  try {
    const g = fullscreenEditorLayout(f.output.columns - 1, f.output.rows);
    await f.mouse(0, g.padding, g.bodyY);
    await f.mouse(32, g.padding + 5, g.bodyY);
    await f.mouse(0, g.padding + 5, g.bodyY, true);
    await f.key('\x03');
    assert.deepEqual(f.copied, ['hello']);
    await f.mouse(0, g.sendX + 1, g.footerY);
    await f.mouse(0, g.sendX + 1, g.footerY, true);
    assert.equal(f.submitted.length, 1);
    assert.equal(f.submitted[0]!.text, 'hello world');
    await f.mouse(0, g.collapseX + 1, g.top);
    await f.mouse(0, g.collapseX + 1, g.top, true);
    assert.equal(f.collapsed, 1);
    assert.equal(f.draft.text, 'hello world');
  } finally {await f.close();}
});

test('wheel browsing leaves the cursor unchanged and the next edit restores cursor following', {timeout: 10000}, async () => {
  const text = Array.from({length: 25}, (_, index) => 'row' + String(index).padStart(2, '0')).join('\n');
  const f = await editorFixture({text, cursor: text.length}, 36, 10);
  try {
    assert.match(f.text(), /row24/);
    const before = f.draft;
    await f.mouse(64, 3, 3);
    assert.deepEqual(f.draft, before);
    assert.doesNotMatch(f.text(), /row24/, 'The viewport can browse away from the caret');
    await f.key('!');
    assert.equal(f.draft.text, text + '!');
    assert.match(f.text(), /row24!/);
    assert.ok(f.output.cursorPosition.x >= 0 && f.output.cursorPosition.x < f.output.columns);
    assert.ok(f.output.cursorPosition.y >= 0 && f.output.cursorPosition.y < f.output.rows);
  } finally {await f.close();}
});

test('resize down to a one-cell body keeps rendering and caret in bounds without mutating the draft', {timeout: 10000}, async () => {
  const initial = {text: 'wide 中文🙂 e\u0301\nlast', cursor: 4};
  const f = await editorFixture(initial);
  try {
    for (const [columns, rows] of [[19, 6], [8, 4], [3, 2], [2, 1], [60, 12]]) {
      await f.resize(columns!, rows!);
      assert.deepEqual(f.draft, initial);
      assert.equal(f.output.lines.length, rows);
      assert.ok(f.output.lines.every(line => stringWidth(line) <= columns!));
      const cursor = f.output.cursorPosition;
      assert.ok(cursor.x >= 0 && cursor.x < columns!, `Caret x ${cursor.x} must fit ${columns} columns`);
      assert.ok(cursor.y >= 0 && cursor.y < rows!, `Caret y ${cursor.y} must fit ${rows} rows`);
    }
    await f.key('!');
    assert.equal(f.draft.text, 'wide! 中文🙂 e\u0301\nlast');
  } finally {await f.close();}
});

test('fullscreen Ctrl+T, Ctrl+D and unselected Ctrl+C retain their distinct public intents', {timeout: 10000}, async () => {
  const f = await editorFixture({text: 'steer this task', cursor: 15});
  try {
    await f.key('\x14'); await f.key('\x04'); await f.key('\x03');
    assert.equal(f.steered, 1); assert.equal(f.closed, 1); assert.equal(f.interrupted, 1);
    assert.equal(f.submitted.length, 0);
    assert.equal(f.draft.text, 'steer this task');
  } finally {await f.close();}
});
