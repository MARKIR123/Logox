import test from 'node:test';
import assert from 'node:assert/strict';
import chalk from 'chalk';
import {Text, renderToString} from 'ink';
import stringWidth from 'string-width';
import {CommandMenu} from '../src/tui/commands/command-menu.js';
import {PanelFrame as CommandPane} from '../src/tui/components/panel-frame.js';
import {Picker} from '../src/tui/panels/picker.js';
import {TabbedPage} from '../src/tui/panels/tabbed-page.js';
import {applyTheme, palette} from '../src/tui/appearance/theme.js';

// Inspect actual emitted foreground colors, not component props or stripped snapshots.
function styled(output: string): {text: string; colors: (string | undefined)[]} {
  let text = '', foreground: string | undefined;
  const colors: (string | undefined)[] = [];
  for (const token of output.matchAll(/\x1b\[([\d;]*)m|([^\x1b]+)/g)) {
    if (token[1] !== undefined) {
      const codes = token[1].split(';').map(Number);
      for (let at = 0; at < codes.length; at++) {
        if (codes[at] === 0 || codes[at] === 39) foreground = undefined;
        else if (codes[at] === 38 && codes[at + 1] === 2) {
          foreground = '#' + codes.slice(at + 2, at + 5).map(n => n.toString(16).padStart(2, '0')).join('');
          at += 4;
        }
      }
    } else {
      text += token[2];
      for (let at = 0; at < token[2]!.length; at++) colors.push(foreground);
    }
  }
  return {text, colors};
}
function assertColor(output: string, text: string, expected: string): void {
  const screen = styled(output), index = screen.text.indexOf(text);
  assert.ok(index >= 0, 'Missing text: ' + text + '\n' + screen.text);
  assert.ok(screen.colors.slice(index, index + text.length).every(color => color === expected.toLowerCase()), text + ' must use ' + expected);
}
function withTheme(run: () => void): void {
  const previousTheme = {...palette}, previousLevel = chalk.level;
  try {
    chalk.level = 3;
    applyTheme({accent: '#123abc', muted: '#889099'});
    run();
  } finally {applyTheme(previousTheme); chalk.level = previousLevel;}
}

test('slash suggestions have only a top rule; descriptions use gray or the system accent', () => withTheme(() => {
  const output = renderToString(<CommandMenu width={64} selected={0} items={[
    {label: '/model', description: 'Selected description', replacement: '/model', start: 0, end: 1, kind: 'command', execute: true},
    {label: '/status', description: 'Unselected description', replacement: '/status', start: 0, end: 1, kind: 'command', execute: true},
  ]}/>);
  const rows = styled(output).text.split('\n');
  assert.match(rows[0]!, /^─ Commands · 2 ─+$/);
  assert.equal(stringWidth(rows[0]!), 64);
  assert.equal(rows.length, 3);
  assert.ok(rows.every(row => stringWidth(row) <= 64));
  assert.doesNotMatch(styled(output).text, /[╭╮╰╯│]/);
  assert.ok(rows.at(-1)!.includes('/status'), 'Last suggestion is not followed by a bottom border');
  assertColor(output, '/model', palette.accent);
  assertColor(output, 'Selected description', palette.accent);
  assertColor(output, 'Unselected description', palette.muted);
}));

test('command panes use top and bottom rules without side borders or corners', () => withTheme(() => {
  for (const width of [8, 20, 48, 80]) {
    const output = renderToString(<CommandPane title="Settings" width={width} height={8} footer="Esc Back"><Text>Content</Text></CommandPane>, {columns: width});
    const rows = styled(output).text.split('\n');
    assert.equal(rows.length, 8);
    assert.match(rows[0]!, /^─+$/);
    assert.match(rows.at(-1)!, /^─+$/);
    assert.doesNotMatch(styled(output).text, /[╭╮╰╯│]/);
    assert.ok(rows.every(row => stringWidth(row) <= width));
  }
}));

test('picker selection ignores per-item actor colors and separates muted descriptions', () => withTheme(() => {
  const output = renderToString(<Picker title="Select Model for Techne" width={70} height={10} current="a" items={[
    {id: 'a', label: 'Selected model', description: 'Selected detail', color: '#ff00ff'},
    {id: 'b', label: 'Other model', description: 'Muted detail', color: '#00ff00'},
  ]} onSelect={() => {}} onCancel={() => {}}/>);
  assertColor(output, 'Selected model', palette.accent);
  assertColor(output, 'Selected detail', palette.accent);
  assertColor(output, 'Other model', palette.fg);
  assertColor(output, 'Muted detail', palette.muted);
  assert.ok(!output.includes('38;2;255;0;255') && !output.includes('38;2;0;255;0'));
  assert.ok(styled(output).text.includes('Esc Back'));
}));

test('model section rules match the configured outer accent for single and multiple providers', () => withTheme(() => {
  for (const accent of ['#123abc', '#91b2d3']) for (const grouped of [false, true]) {
    applyTheme({accent, line: '#252627'});
    const output = renderToString(<Picker title="Select Model for Logox" width={80} height={16} current="a" items={[
      {id: 'a', label: 'Selected model', group: 'alpha', effort: 'high', effortLevels: ['low', 'high']},
      {id: 'b', label: 'Other model', group: grouped ? 'beta' : 'alpha'},
    ]} onSelect={() => {}} onCancel={() => {}}/>);
    const screen = styled(output), rows = screen.text.split('\n');
    let offset = 0, ruleCount = 0;
    for (const row of rows) {
      if (/^─+$/.test(row.trim())) {
        ruleCount++;
        const start = offset + row.indexOf('─');
        assert.ok(screen.colors.slice(start, start + row.trim().length).every(color => color === accent),
          'Outer and internal section rules read the same live config token');
      }
      offset += row.length + 1;
    }
    assert.equal(ruleCount, 3, 'One outer rule and two internal section rules');
    const effort = rows.findIndex(row => row.includes('✦ Thinking:'));
    const shortcuts = rows.findIndex(row => row.includes('↑↓ Select'));
    assert.equal(rows[effort - 1]?.trim(), '');
    assert.match(rows[shortcuts - 1]!.trim(), /^─+$/);
  }
}));

test('single-provider model lists without thinking tiers retain the header and footer boundaries', () => withTheme(() => {
  const output = renderToString(<Picker title="Select Model for Logox" width={60} height={12} current="a" items={[
    {id: 'a', label: 'Selected model', group: 'alpha'},
  ]} onSelect={() => {}} onCancel={() => {}}/>);
  const rows = styled(output).text.split('\n');
  assert.equal(rows.filter(row => /^─+$/.test(row.trim())).length, 3);
  assert.ok(rows.some(row => row.includes('Selected model')));
}));

test('page tabs and headings use the system theme rather than a tab owner color', () => withTheme(() => {
  const output = renderToString(<TabbedPage title="Status" width={70} height={12} initialTab="one" tabs={[
    {id: 'one', title: 'First tab', color: '#ff00ff', lines: ['System heading', 'Details']},
    {id: 'two', title: 'Second tab', color: '#00ff00', lines: []},
  ]} onClose={() => {}}/>);
  assertColor(output, 'First tab', palette.accent);
  assertColor(output, 'Second tab', palette.muted);
  assertColor(output, 'System heading', palette.accent);
}));

test('short pickers prioritize selectable options over decorative chrome', () => withTheme(() => {
  for (const grouped of [false, true]) {
    for (const height of [5, 6, 7, 8, 9, 10]) {
      const output = renderToString(<Picker title="Models" width={40} height={height} current="a" items={[
        {id: 'a', label: 'Visible model', ...(grouped ? {group: 'alpha'} : {})},
        {id: 'b', label: 'Other model', ...(grouped ? {group: 'beta'} : {})},
      ]} onSelect={() => {}} onCancel={() => {}}/>);
      const screen = styled(output).text;
      assert.ok(screen.includes('Visible model'), `Option hidden at height ${height}, grouped=${grouped}:\n${screen}`);
      assert.equal(screen.split('\n').length, height);
      assert.match(screen.split('\n')[0]!, /^─+$/);
      assert.doesNotMatch(screen, /[╭╮╰╯│]/);
      assert.doesNotMatch(screen.split('\n').at(-1)!, /^─+$/, 'Docked pickers have no bottom rule');
    }
  }
}));

test('long CJK and emoji suggestion labels do not break the narrow-screen boundary', () => withTheme(() => {
  for (const width of [8, 20, 32]) {
    const output = renderToString(<CommandMenu width={width} selected={0} items={[
      {label: '/非常长的命令🙂很长很长', description: 'Long description', replacement: '', start: 0, end: 1, kind: 'command', execute: false},
    ]}/>, {columns: width});
    const rows = styled(output).text.split('\n');
    assert.equal(rows.length, 2);
    assert.ok(rows.every(row => stringWidth(row) <= width));
    assert.match(rows[0]!, /^─(?: Commands · 1 )?─+$/);
    assert.doesNotMatch(styled(output).text, /[╭╮╰╯│]/);
  }
}));
