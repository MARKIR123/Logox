import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToString} from 'ink';
import {CommandMenu, commandMenuLayout} from '../src/tui/commands/command-menu.js';
import type {CommandSuggestion} from '../src/tui/commands/completion.js';

test('CommandMenu renders argument suggestions with their titles/descriptions', () => {
  const items: CommandSuggestion[] = [
    {
      label: '@aletheia',
      description: 'Scout',
      replacement: '@aletheia ',
      start: 0,
      end: 2,
      kind: 'argument',
      execute: false,
    },
    {
      label: '@kalon',
      description: 'Polisher',
      replacement: '@kalon ',
      start: 0,
      end: 2,
      kind: 'argument',
      execute: false,
    },
  ];

  const output = renderToString(<CommandMenu items={items} selected={0} width={60} />);
  assert.ok(output.includes('@aletheia'), 'Should include @aletheia label');
  assert.ok(output.includes('Scout'), 'Should include Scout title');
  assert.ok(output.includes('@kalon'), 'Should include @kalon label');
  assert.ok(output.includes('Polisher'), 'Should include Polisher title');
  assert.ok(output.includes('❯'), 'Should have active pointer for selected item');
  assert.match(output, /Actors · 2/, 'Actor mentions use the same component with the correct title');
});

test('production menu layout budgets exactly the shared component rows', () => {
  for (let length = 0; length <= 12; length++) {
    for (let budget = 0; budget <= 10; budget++) {
      const layout = commandMenuLayout(length, budget);
      assert.ok(layout.height <= budget);
      if (layout.height === 0) continue;
      const items: CommandSuggestion[] = Array.from({length}, (_, i) => ({
        label: '/cmd' + i, description: 'Description ' + i, replacement: '/cmd' + i,
        start: 0, end: 1, kind: 'command', execute: true,
      }));
      const output = renderToString(<CommandMenu items={items} selected={length - 1} width={80} maxVisible={layout.count} showCounts={layout.showCounts}/>);
      assert.equal(output.split('\n').length, layout.height, `length=${length}, budget=${budget}`);
      assert.ok(output.includes('/cmd' + (length - 1)), 'Selected item stays inside the window');
    }
  }
});
