import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {act} from 'react';
import {render, renderToString} from 'ink';
import chalk from 'chalk';
import stringWidth from 'string-width';
import {setTimeout as delay} from 'node:timers/promises';
import {TerminalScreen} from './terminal-screen.js';
import {CommandSuggestions, suggestionWindow} from '../src/tui/commands/command-suggestions.js';
import {splitQueryMatch} from '../src/tui/commands/query-match.js';
import {PreviewFrame, SlashPreview, previewCommands} from '../src/tui/previews/slash-preview.js';
import {applyTheme, palette} from '../src/tui/appearance/theme.js';
import {palette as legacyPalette} from '../src/config/theme-palette.js';
import {App} from '../src/tui/app.js';
import {RuntimeStore} from '../src/runtime/store.js';
const plain = (text: string) => text.replace(/\x1b\[[\d;]*m/g, '');

function colorOf(output: string, needle: string): string | undefined {
  let color: string | undefined, text = '';
  const colors: (string | undefined)[] = [];
  for (const token of output.matchAll(/\x1b\[([\d;]*)m|([^\x1b]+)/g)) {
    if (token[1] !== undefined) {
      const codes = token[1].split(';').map(Number);
      for (let i = 0; i < codes.length; i++) {
        if (codes[i] === 0 || codes[i] === 39) color = undefined;
        if (codes[i] === 38 && codes[i + 1] === 2) {color = '#' + codes.slice(i + 2, i + 5).map(n => n.toString(16).padStart(2, '0')).join(''); i += 4;}
      }
    } else {text += token[2]; for (let i = 0; i < token[2]!.length; i++) colors.push(color);}
  }
  const at = text.indexOf(needle); assert.ok(at >= 0, 'Missing text: ' + needle);
  return colors[at];
}

test('TUI theme facade shares the configuration palette, not an Actor-owned copy', () => {
  assert.equal(legacyPalette, palette);
});

test('command query matching preserves full, space-token and path-segment prefixes', () => {
  assert.deepEqual(splitQueryMatch('/model', 'mo'), {before: '/', match: 'mo', after: 'del'});
  assert.deepEqual(splitQueryMatch('model deepseek-v4', 'deep'), {before: 'model ', match: 'deep', after: 'seek-v4'});
  assert.deepEqual(splitQueryMatch('src/Render.tsx', 're'), {before: 'src/', match: 'Re', after: 'nder.tsx'});
  assert.equal(splitQueryMatch('model', ''), null);
  assert.equal(splitQueryMatch('model', 'other'), null);
});

test('centered command list shows five rows, absolute selection and hidden counts', () => {
  assert.deepEqual(suggestionWindow(8, 4), {start: 2, count: 5, selected: 4});
  const text = plain(renderToString(<CommandSuggestions commands={previewCommands} selectedIndex={4} columns={80}/>));
  assert.match(text, /^─ Commands · 8 ─+/);
  assert.match(text, /❯ \/status/);
  assert.match(text, /↑2 · ↓1/);
  assert.doesNotMatch(text, /\/login|\/help|[╭╮╰╯│]/);
  assert.equal(text.split('\n').length, 7);
  assert.equal(renderToString(<CommandSuggestions commands={[]} selectedIndex={0} columns={80}/>), '');
});

test('candidate descriptions and focus use system theme, and matching survives clipped names', () => {
  const previous = {...palette}, level = chalk.level;
  try {
    chalk.level = 3; applyTheme({accent: '#123abc', muted: '#889099', fg: '#edf0f3'});
    const output = renderToString(<CommandSuggestions columns={80} selectedIndex={0} commands={previewCommands}/>);
    assert.equal(colorOf(output, '/login'), palette.accent);
    assert.equal(colorOf(output, 'Add or edit providers'), palette.accent);
    assert.equal(colorOf(output, 'Select a model'), palette.muted);
    const clipped = renderToString(<CommandSuggestions columns={40} selectedIndex={0} query="/model deepseek-v4" commands={[
      {name: '/other', description: 'Selected'}, {name: '/model deepseek-v4-flash', description: 'Unselected'},
    ]}/>);
    assert.equal(colorOf(clipped, 'deepse'), palette.fg);
  } finally {applyTheme(previous); chalk.level = level;}
});

test('popup rule follows the composer line color without changing title or selection colors', () => {
  const previous = {...palette}, level = chalk.level;
  try {
    chalk.level = 3;
    for (const line of ['#556677', '#8899aa']) {
      applyTheme({line, accent: '#123abc', muted: '#909090'});
      const output = renderToString(<CommandSuggestions columns={80} selectedIndex={0} commands={[
        {name: '/model', description: 'Selected description'}, {name: '/help', description: 'Muted description'},
      ]}/>);
      assert.equal(colorOf(output, '─'), palette.line, 'Leading rule uses the composer token');
      assert.equal(colorOf(output, '──────'), palette.line, 'Trailing rule uses the same token');
      assert.equal(colorOf(output, 'Commands'), palette.accent, 'Title stays highlighted');
      assert.equal(colorOf(output, '/model'), palette.accent);
      assert.equal(colorOf(output, 'Selected description'), palette.accent);
      assert.equal(colorOf(output, 'Muted description'), palette.muted);
      const narrow = renderToString(<CommandSuggestions columns={8} selectedIndex={0} commands={previewCommands}/>);
      assert.equal(colorOf(narrow, '────────'), palette.line, 'Title-less narrow rule also matches the composer');
    }
  } finally {applyTheme(previous); chalk.level = level;}
});

test('candidate menu clips CJK, emoji and long tags without side or bottom borders', () => {
  for (const width of [8, 20, 32, 80]) {
    const text = plain(renderToString(<CommandSuggestions columns={width} selectedIndex={0} commands={[
      {name: '/很长🙂的候选命令', tag: 'an excessively long argument hint', description: 'A description that must not wrap'},
    ]}/>, {columns: width}));
    assert.equal(text.split('\n').length, 2);
    assert.ok(text.split('\n').every(row => stringWidth(row) <= width));
    assert.doesNotMatch(text, /[╭╮╰╯│]/);
  }
});

test('standalone preview keeps composer visible on five-row and short terminals', () => {
  for (const height of [5, 6, 8, 12, 24]) {
    const text = plain(renderToString(<PreviewFrame width={40} height={height} selected={0} query="/"/>, {columns: 40}));
    assert.equal(text.split('\n').length, height);
    assert.ok(text.split('\n').some(row => row.trim() === '/'));
    assert.match(text, /❯ \/login/);
    assert.doesNotMatch(text, /[╭╮╰╯│]/);
  }
});

class TerminalInput extends PassThrough {
  isTTY = true; setRawMode(): this {return this;} ref(): this {return this;} unref(): this {return this;}
}
test('slash menu keeps system colors when switching between differently colored Actor windows', async () => {
  Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
  const previous = {...palette}, level = chalk.level;
  const input = new TerminalInput(), output = new TerminalScreen(), store = new RuntimeStore();
  let instance: ReturnType<typeof render> | undefined;
  try {
    chalk.level = 3;
    applyTheme({accent: '#123abc', muted: '#889099'});
    await act(async () => {instance = render(<App stage sessionId="system-menu" store={store} getActors={() => [
      {id: 'logox', name: 'Logox', title: 'Director', symbol: 'L', color: '#ff00ff'},
      {id: 'techne', name: 'Techne', title: 'Builder', symbol: 'T', color: '#00ff00'},
    ]} onSubmit={async () => {}} onCancel={() => {}} onClose={async () => {}}/>,
    {stdin: input, stdout: output, stderr: output, interactive: true, alternateScreen: true, patchConsole: false, exitOnCtrlC: false});});
    const press = async (value: string) => {
      await act(async () => {input.write(value); await delay(10);});
      await instance!.waitUntilRenderFlush();
    };
    output.text = '';
    await press('/mo');
    assert.equal(colorOf(output.text, '/model'), palette.accent, 'Director window uses the system accent');
    await press('\x07'); // Ctrl+G changes the Actor window, not the system theme.
    output.text = '';
    await press('/mo');
    assert.equal(colorOf(output.text, '/model'), palette.accent, 'Builder window uses exactly the same accent');
    assert.ok(output.lines.some(row => row.includes('❯ /model')));
    assert.equal(palette.accent, '#123abc');
  } finally {
    if (instance) {await act(async () => {instance!.unmount();}); await instance.waitUntilExit();}
    input.destroy(); output.destroy(); store.interactions.close();
    applyTheme(previous); chalk.level = level;
  }
});

test('standalone preview supports arrows, click, wheel, confirmation, escape and draft recovery', async () => {
  Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
  const input = new TerminalInput(), output = new TerminalScreen();
  let instance!: ReturnType<typeof render>;
  await act(async () => {instance = render(<SlashPreview/>, {stdin: input, stdout: output, stderr: output, interactive: true,
    alternateScreen: true, patchConsole: false, exitOnCtrlC: false});});
  const press = async (value: string) => {
    await act(async () => {input.write(value); await delay(value === '\x1b' ? 40 : 10);});
    await instance.waitUntilRenderFlush();
  };
  const screen = () => output.lines.join('\n');
  try {
    await instance.waitUntilRenderFlush();
    await press('\x1b[B'); assert.match(screen(), /❯ \/model/);
    const top = output.lines.findIndex(row => row.startsWith('─ Commands'));
    await press(`\x1b[<0;8;${top + 2}M`);
    assert.match(screen(), /❯ \/login/, 'First body row uses absolute mouse coordinates');
    await press(`\x1b[<65;8;${top + 2}M`);
    assert.match(screen(), /❯ \/model/, 'Wheel steps focus');
    await press('\r'); assert.match(screen(), /Preview only: \/model/);
    await press('\t'); assert.ok(output.lines.some(row => row === '/model'));
    await press('\x1b'); assert.doesNotMatch(screen(), /─ Commands/);
    assert.ok(output.lines.some(row => row === '/model'), 'Closing retains the draft');
    await act(async () => {output.resize(40, 5);}); await instance.waitUntilRenderFlush();
    await press('\x7f'); assert.match(screen(), /❯ \/model/);
  } finally {
    await act(async () => {instance.unmount();}); await instance.waitUntilExit(); input.destroy(); output.destroy();
  }
});
