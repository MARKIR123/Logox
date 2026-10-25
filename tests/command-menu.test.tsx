import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToString} from 'ink';
import {CommandMenu} from '../src/tui/command-menu.js';
import type {CommandSuggestion} from '../src/tui/completion.js';

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
});
