import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {act} from 'react';
import {useStdout, useWindowSize} from 'ink';
import stringWidth from 'string-width';
import {TerminalScreen} from './terminal-screen.js';
import {renderTerminal as render} from '../src/tui/terminal/terminal.js';
import {CommandResultPanel} from '../src/tui/panels/command-result.js';
import {osc52Clipboard} from '../src/tui/terminal/clipboard.js';
import {App} from '../src/tui/app.js';
import {CommandSurfaces} from '../src/commands/surfaces.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {palette} from '../src/tui/appearance/theme.js';

Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
class Input extends PassThrough {
  isTTY = true; setRawMode(): this {return this;} ref(): this {return this;} unref(): this {return this;}
}
async function press(input: Input, instance: ReturnType<typeof render>, value: string): Promise<void> {
  await act(async () => {input.write(value); await delay(value === '\x1b' ? 40 : 10);});
  await instance.waitUntilRenderFlush();
}
const options = (input: Input, output: TerminalScreen) => ({stdin: input, stdout: output, stderr: output,
  interactive: true, alternateScreen: true, patchConsole: false, exitOnCtrlC: false, maxFps: 100});
const screen = (output: TerminalScreen) => output.lines.join('\n');

test('result panel wraps graphemes, scrolls with keys/wheel, copies original text only on Ctrl+C and fits tiny screens', async () => {
  const input = new Input(), output = new TerminalScreen(); output.columns = 32; output.rows = 10;
  const text = '汉🙂e\u0301'.repeat(12) + '\n' + Array.from({length: 80}, (_, index) => 'result row ' + index).join('\n') + '\n\t原始全文';
  const copies: string[] = []; let closes = 0;
  function View() {
    const {columns, rows} = useWindowSize(), {stdout} = useStdout();
    return <CommandResultPanel title="Query result" text={text} width={columns - 1} height={rows}
      onClose={() => {closes++;}} onCopy={value => {copies.push(value); stdout.write(osc52Clipboard(value));}}/>;
  }
  let instance!: ReturnType<typeof render>;
  await act(async () => {instance = render(<View/>, options(input, output));});
  const key = async (value: string) => press(input, instance, value);
  try {
    await instance.waitUntilRenderFlush();
    assert.equal(output.lines[2], '  ' + '汉🙂e\u0301'.repeat(5) + '汉', 'Display-cell wrapping never splits a combining grapheme or emoji');
    assert.match(screen(output), /Ctrl\+C Copy all/);
    assert.doesNotMatch(output.text, /\x1b\]52;/, 'Rendering and navigation never touch the clipboard');
    await key('\x1b[B'); assert.doesNotMatch(output.lines[2]!, new RegExp('^  ' + '汉🙂e\u0301'.repeat(5)));
    await key('\x1b[A'); assert.equal(output.lines[2], '  ' + '汉🙂e\u0301'.repeat(5) + '汉');
    await key('\x1b[6~'); assert.match(output.lines[2]!, /result row 3/);
    await key('\x1b[5~'); assert.equal(output.lines[2], '  ' + '汉🙂e\u0301'.repeat(5) + '汉');
    await key('\x1b[<65;8;4M'); assert.match(output.lines[2]!, /result row 0/);
    await key('\x1b[<64;8;4M'); assert.equal(output.lines[2], '  ' + '汉🙂e\u0301'.repeat(5) + '汉');
    await key('\x1b[4~'); assert.match(screen(output), /result row 79/); assert.match(screen(output), /原始全文/);
    await key('\x1b[1~'); assert.equal(output.lines[2], '  ' + '汉🙂e\u0301'.repeat(5) + '汉');
    await key('\x1b[99;5:3u'); await key('\x1b[27;1:3u');
    assert.deepEqual(copies, []); assert.equal(closes, 0, 'Enhanced-key releases are ignored');
    await key('\x03'); assert.deepEqual(copies, [text]);
    assert.ok(output.text.includes(osc52Clipboard(text))); assert.match(screen(output), /Copied result/);
    assert.equal(closes, 0);
    for (const rows of [6, 4, 3, 2, 1]) {
      await act(async () => output.resize(32, rows)); await instance.waitUntilRenderFlush();
      assert.equal(output.lines.length, rows);
      assert.ok(output.lines.every(line => stringWidth(line) <= 31), 'No row escapes the available width');
      assert.ok(output.cursorPosition.y < rows, 'Cursor remains within the short screen');
      assert.match(screen(output), /Ctrl\+C|Copied result/);
    }
    await key('\x1b'); assert.equal(closes, 1);
  } finally {
    await act(async () => instance.unmount()); await instance.waitUntilExit(); input.destroy(); output.destroy();
  }
});

test('App result owns copy/back, restores draft/history/focus, and preserves global Ctrl+D exit', async () => {
  const input = new Input(), output = new TerminalScreen(), store = new RuntimeStore();
  const surfaces = new CommandSurfaces(() => {}), submissions: string[] = [], cancels: string[] = [];
  let closes = 0, signalInterrupt: (() => void) | undefined;
  for (let index = 0; index < 45; index++) store.message('s', 'logox', 'assistant', 'history row ' + index);
  const ticket = store.interactions.open({kind: 'permission', sessionId: 's', ownerId: 'techne', activityId: 'a',
    title: 'Write file', tool: 'Write', arguments: {}, reason: 'Approval needed'});
  let instance!: ReturnType<typeof render>;
  await act(async () => {instance = render(<App stage store={store} surfaces={surfaces} sessionId="s"
    registerInterrupt={handler => {signalInterrupt = handler; return () => {signalInterrupt = undefined;};}}
    onSubmit={async text => {submissions.push(text);}} onCancel={id => {cancels.push(id);}} onClose={async () => {closes++;}}/>, options(input, output));});
  const key = async (value: string) => press(input, instance, value);
  try {
    await key('keep this chat draft'); await key('\x1b[5~');
    const before = screen(output).match(/history row \d+/g); assert.ok(before?.length);
    await key('\t');
    const approvalComposer = output.lines.find(line => line.startsWith('许可：'));
    assert.ok(approvalComposer, 'The approval owns the composer before opening a result');
    const focusedBefore = screen(output).match(/history row \d+/g);
    const result = Array.from({length: 100}, (_, index) => 'query-only row ' + index).join('\n');
    await act(async () => surfaces.openResult('Long query', result)); await instance.waitUntilRenderFlush();
    assert.match(screen(output), /Long query/); assert.match(screen(output), /query-only row 0/);
    assert.doesNotMatch(screen(output), /history row|keep this chat draft/, 'Canvas is hidden behind the full-screen result');
    await key('\x03'); await key('\x03');
    assert.ok(surfaces.getSnapshot()?.kind === 'result'); assert.equal(closes, 0); assert.deepEqual(cancels, []);
    assert.match(screen(output), /Copied result/); assert.ok(output.text.includes(osc52Clipboard(result)));
    await act(async () => signalInterrupt?.()); assert.equal(closes, 0, 'Registered process interrupt cannot arm exit inside a result');
    await key('\x1b[4~'); assert.match(screen(output), /query-only row 99/);
    await key('\x1b'); assert.equal(surfaces.getSnapshot(), null);
    assert.deepEqual(screen(output).match(/history row \d+/g), focusedBefore, 'Esc restores the original viewport');
    assert.ok(output.lines.includes(approvalComposer), 'Esc retains the original approval focus rather than stealing focus for the chat draft');
    assert.equal(store.interactions.list()[0]!.status, 'pending');
    assert.doesNotMatch(screen(output), /Copied result/, 'Copy feedback belongs only to the closed result footer');
    await key('\t'); assert.match(screen(output), /keep this chat draft/, 'Returning to input reveals the unchanged original chat draft');
    assert.deepEqual(submissions, [], 'Reading, copying and closing a result never submit the draft');
    await key('\t'); await key('\r'); assert.equal((await ticket.result).status, 'answered', 'The pending approval retains single-input ownership');
    await key('\r'); assert.deepEqual(submissions, ['keep this chat draft']);
    assert.equal(store.getSnapshot().messages.some(message => message.text.includes('query-only')), false, 'Result text never enters the chat');
    await act(async () => {
      store.activities.create({sessionId: 's', activityId: 'live-at-exit', ownerId: 'logox', kind: 'director',
        title: 'Live task at global exit', status: 'running', stage: '', detail: ''});
      surfaces.openResult('Exit from result', result);
    });
    await instance.waitUntilRenderFlush(); assert.match(screen(output), /Exit from result/);
    await key('\x1b[100;5:3u'); assert.equal(closes, 0, 'Ctrl+D release alone never exits');
    await key('\x04'); await instance.waitUntilExit();
    assert.equal(closes, 1, 'Ctrl+D keeps the global close action available inside a result');
    assert.deepEqual(cancels, [], 'Global exit is not routed through task cancellation');
  } finally {
    await act(async () => {surfaces.close(); store.interactions.close(); instance.unmount();});
    await instance.waitUntilExit(); input.destroy(); output.destroy();
  }
});

test('scoped background results never steal another Actor or session input, canvas, paste or Ctrl+C', async () => {
  const input = new Input(), output = new TerminalScreen(), store = new RuntimeStore();
  const origin = {sessionId: 's', ownerId: 'logox'};
  const surfaces = new CommandSurfaces(() => {}, () => origin);
  const actors = ['logox', 'alpha'].map(id => ({id, symbol: '◇', name: id, title: id, color: palette.accent}));
  for (let index = 0; index < 45; index++) store.message('s', 'alpha', 'assistant', 'Actor history ' + index);
  store.message('other', 'logox', 'assistant', 'Other session conversation');
  let closes = 0;
  const cancels: string[] = [];
  const view = (sessionId = 's') => <App stage sessionId={sessionId} store={store} surfaces={surfaces} getActors={() => actors}
    onSubmit={async () => {}} onCancel={id => {cancels.push(id);}} onClose={async () => {closes++;}}/>;
  let instance!: ReturnType<typeof render>;
  await act(async () => {instance = render(view(), options(input, output));});
  const key = async (value: string) => press(input, instance, value);
  const copyCount = () => [...output.text.matchAll(/\x1b\]52;/g)].length;
  try {
    await key('Director draft'); await key('\x07'); // Switch before an older Director query completes.
    await key('Actor draft');
    await act(async () => {surfaces.openResult('Director-only query', 'Private result body');});
    await instance.waitUntilRenderFlush();
    assert.equal(surfaces.getSnapshot()?.ownerId, 'logox', 'The command captures its original owner, not the newly active Actor');
    assert.match(screen(output), /Actor draft/); assert.match(screen(output), /Actor history/);
    assert.doesNotMatch(screen(output), /Director-only query|Private result body/);
    const before = screen(output).match(/Actor history \d+/g); assert.ok(before?.length);
    await key('\x1b[5~');
    assert.notDeepEqual(screen(output).match(/Actor history \d+/g), before, 'A background result does not intercept timeline scrolling');
    const beforeWheel = screen(output).match(/Actor history \d+/g);
    await key('\x1b[<64;8;4M');
    assert.notDeepEqual(screen(output).match(/Actor history \d+/g), beforeWheel, 'A background result does not intercept the timeline mouse wheel');
    await key(' + typed'); await key('\x1b[200~ + pasted\x1b[201~');
    assert.match(screen(output), /Actor draft \+ typed \+ pasted/, 'Both ordinary keys and bracketed paste reach the active Actor composer');
    await key('\x03');
    assert.equal(copyCount(), 0, 'Ctrl+C in another window never copies a hidden result');
    assert.doesNotMatch(screen(output), /Copied result/); assert.equal(closes, 0); assert.deepEqual(cancels, []);
    assert.ok(surfaces.getSnapshot()?.kind === 'result', 'Unrelated input leaves the original read-only result available');
    await key('!'); await key('\x1b'); // Return to the result owner without submitting the Actor draft.
    assert.match(screen(output), /Director-only query/); assert.match(screen(output), /Private result body/);
    await key('\x03'); assert.equal(copyCount(), 1); assert.ok(output.text.includes(osc52Clipboard('Private result body')));
    await act(async () => instance.rerender(view('other'))); await instance.waitUntilRenderFlush();
    assert.match(screen(output), /Other session conversation/);
    assert.doesNotMatch(screen(output), /Director-only query|Private result body/);
    await key('\x03'); assert.equal(copyCount(), 1, 'Matching owner alone is insufficient when the session differs'); assert.equal(closes, 0);
    await act(async () => instance.rerender(view())); await instance.waitUntilRenderFlush();
    assert.match(screen(output), /Director-only query/, 'Returning to the original session and owner reveals the retained result');
    await key('\x1b'); assert.equal(surfaces.getSnapshot(), null); assert.match(screen(output), /Director draft/);
    await key('\x07'); assert.match(screen(output), /Actor draft \+ typed \+ pasted!/);
    assert.deepEqual(cancels, []); assert.equal(closes, 0);
  } finally {
    await act(async () => {surfaces.close(); store.interactions.close(); instance.unmount();});
    await instance.waitUntilExit(); input.destroy(); output.destroy();
  }
});
