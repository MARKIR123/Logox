import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import chalk from 'chalk';
import {RuntimeStore} from '../src/runtime/store.js';
import {App} from '../src/tui/app.js';
import {renderTerminal} from '../src/tui/terminal/terminal.js';
import {fadedColor} from '../src/tui/input/composer-fade.js';
import {mixHex} from '../src/tui/appearance/colors.js';
import {palette} from '../src/tui/appearance/theme.js';
import {TerminalScreen} from './terminal-screen.js';
import {waitFor} from './wait-for.js';

class Input extends PassThrough {isTTY = true; setRawMode(): this {return this;} ref(): this {return this;} unref(): this {return this;}}
const hex = (r: string, g: string, b: string) => '#' + [r, g, b].map(v => (+v).toString(16).padStart(2, '0')).join('');
const rule = mixHex(palette.accent, palette.bg, 0.45);
const ACTIVE = fadedColor(rule, 1), DIM = fadedColor(rule, 0);

function mount() {
  const store = new RuntimeStore();
  store.activities.create({sessionId: 's', activityId: 'main', ownerId: 'logox', kind: 'director', title: 'Main', status: 'completed', stage: 'x', detail: ''});
  store.message('s', 'user', 'user', 'Question', {activityId: 'main', inputKind: 'human'});
  store.message('s', 'logox', 'assistant', Array.from({length: 40}, (_, i) => 'reply line ' + (i + 1)).join('\n\n'), {activityId: 'main'});
  const previous = chalk.level; chalk.level = 3;
  const input = new Input(), output = new TerminalScreen();
  output.columns = 80; output.rows = 24;
  const instance = renderTerminal(<App stage sessionId="s" store={store} onSubmit={async () => {}} onCancel={() => {}} onClose={async () => {}}/>,
    {stdout: output, stdin: input, stderr: output, interactive: true, alternateScreen: true, incrementalRendering: true, patchConsole: false, exitOnCtrlC: false});
  const settle = async (ms = 400) => {await delay(ms); await instance.waitUntilRenderFlush();};
  const key = async (text: string) => {input.write(text); await settle();};
  const mouse = async (kind: number, x: number, y: number, release = false) => key(`\x1b[<${kind};${x + 1};${y + 1}${release ? 'm' : 'M'}`);
  const click = async (x: number, y: number) => {await mouse(0, x, y); await mouse(0, x, y, true);};
  /** The colour the composer rules were last painted with. */
  const ruleColour = () => {const all = [...output.text.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m─{10,}/g)]; const m = all.at(-1); return m ? hex(m[1]!, m[2]!, m[3]!) : undefined;};
  return {output, settle, key, click, ruleColour, async close() {chalk.level = previous; instance.unmount(); await instance.waitUntilExit(); input.destroy(); output.destroy();}};
}
const composerRow = (output: TerminalScreen) => output.lines.findLastIndex(line => /^❯/.test(line));

test('a timeline click blurs the composer, a click on it refocuses; typing refocuses and inserts; Ctrl+N blurs and Esc refocuses', async () => {
  const ui = mount();
  try {
    await ui.settle(600);
    assert.equal(ui.ruleColour(), ACTIVE, 'focused at start');
    const y = composerRow(ui.output); assert.ok(y > 0, 'composer row found');
    await ui.click(10, 3);
    await waitFor(async () => ui.ruleColour(), c => c === DIM, {timeoutMs: 3000, label: 'timeline click dims the composer'});
    await ui.click(10, y);
    await waitFor(async () => ui.ruleColour(), c => c === ACTIVE, {timeoutMs: 3000, label: 'composer click wakes it'});
    await ui.click(10, 3);
    await waitFor(async () => ui.ruleColour(), c => c === DIM, {timeoutMs: 3000, label: 'dim again'});
    await ui.key('h');
    await waitFor(async () => ui.ruleColour(), c => c === ACTIVE, {timeoutMs: 3000, label: 'typing wakes it'});
    assert.match(ui.output.lines[composerRow(ui.output)] ?? '', /^❯ h/, 'and the character was inserted');
    await ui.key('\x0e');
    await waitFor(async () => ui.ruleColour(), c => c === DIM, {timeoutMs: 3000, label: 'Ctrl+N dims it'});
    await ui.key('\x1b'); await delay(300);
    await waitFor(async () => ui.ruleColour(), c => c === ACTIVE, {timeoutMs: 3000, label: 'Esc wakes it'});
  } finally {await ui.close();}
});

test('while blurred, Enter on an empty composer still jumps to the latest output', async () => {
  const ui = mount();
  try {
    await ui.settle(600);
    await ui.key('\x1b[5~'); await ui.key('\x1b[5~');
    await waitFor(async () => ui.output.lines.join('\n'), text => /↓ Latest/.test(text), {timeoutMs: 5000, label: 'pill'});
    await ui.click(10, 3);
    await waitFor(async () => ui.ruleColour(), c => c === DIM, {timeoutMs: 3000, label: 'blurred'});
    await ui.key('\r');
    await waitFor(async () => ui.output.lines.join('\n'), text => !/↓ Latest/.test(text), {timeoutMs: 5000, label: 'jumped'});
    assert.equal(ui.ruleColour(), DIM, 'a jump alone does not refocus');
  } finally {await ui.close();}
});

test('Tab cycles composer, timeline and back; the timeline owns the arrows; Esc returns to the composer; typing wakes it', async () => {
  const ui = mount();
  try {
    await ui.settle(600);
    assert.equal(ui.ruleColour(), ACTIVE);
    await ui.key('\t');
    await waitFor(async () => ui.ruleColour(), c => c === DIM, {timeoutMs: 3000, label: 'Tab moves focus to the timeline'});
    for (let i = 0; i < 4; i++) await ui.key('\x1b[A');
    await waitFor(async () => ui.output.lines.join('\n'), text => /↓ Latest/.test(text), {timeoutMs: 5000, label: 'the arrow scrolls the timeline, not the composer'});
    assert.equal(ui.ruleColour(), DIM, 'scrolling keeps the timeline focused');
    await ui.key('\x1b');
    await waitFor(async () => ui.ruleColour(), c => c === ACTIVE, {timeoutMs: 3000, label: 'Esc returns to the composer'});
    await ui.key('\t'); await ui.key('\t');
    await waitFor(async () => ui.ruleColour(), c => c === ACTIVE, {timeoutMs: 3000, label: 'Tab twice comes back around'});
    await ui.key('\t');
    await waitFor(async () => ui.ruleColour(), c => c === DIM, {timeoutMs: 3000, label: 'timeline again'});
    await ui.key('x');
    await waitFor(async () => ui.ruleColour(), c => c === ACTIVE, {timeoutMs: 3000, label: 'typing wakes the composer'});
    assert.match(ui.output.lines[composerRow(ui.output)] ?? '', /^❯ x/);
  } finally {await ui.close();}
});
