import test from 'node:test';
import assert from 'node:assert/strict';
import {createCommandTabsFor, type ApplicationCommandContext} from '../src/application-commands.js';

function mockContext(): ApplicationCommandContext {
  return {
    session: 'session-1',
    pageOwner: 'logox',
    currentTheme: 'Logox Dark',
    currentCursor: 'Block █',
    motion: true,
    permissions: {
      mode: 'default',
      description: 'Standard approval',
      color: '#5282b5',
      lines: ['Permission details line'],
      readonly_concurrency: 4,
      approvalTokens: 0,
    },
    statusbarModules: [
      {id: 'model', enabled: true},
      {id: 'context', enabled: true},
    ],
    statusLines: ['Status line 1'],
    usageLines: ['Usage line 1'],
    providersLines: ['Provider line 1'],
    actorsLines: ['Actor line 1'],
    commandsLines: ['Command line 1'],
  };
}

test('createCommandTabsFor returns dedicated single tab for /config with theme, cursor, and motion', () => {
  const result = createCommandTabsFor('/config', mockContext())!;
  assert.equal(result.title, 'Settings');
  assert.equal(result.tabs.length, 1);
  assert.equal(result.tabs[0]!.id, 'config');
  const toggles = result.tabs[0]!.toggles!;
  assert.equal(toggles.length, 3);
  assert.equal(toggles[0]!.id, 'theme');
  assert.equal(toggles[0]!.value, 'Logox Dark');
  assert.ok(toggles[0]!.options?.includes('Claude Warm'));
  assert.equal(toggles[1]!.id, 'cursor');
  assert.equal(toggles[1]!.value, 'Block █');
  assert.ok(toggles[1]!.options?.includes('Underline _'));
  assert.equal(toggles[2]!.id, 'motion');
  assert.equal(toggles[2]!.enabled, true);
});

test('createCommandTabsFor returns dedicated single tab for /permissions', () => {
  const result = createCommandTabsFor('/permissions', mockContext())!;
  assert.equal(result.title, 'Permissions');
  assert.equal(result.tabs.length, 1);
  assert.equal(result.tabs[0]!.id, 'permissions');
});

test('createCommandTabsFor returns dedicated single tab for /statusbar', () => {
  const result = createCommandTabsFor('/statusbar', mockContext())!;
  assert.equal(result.title, 'Statusbar Modules');
  assert.equal(result.tabs.length, 1);
  assert.equal(result.tabs[0]!.id, 'statusbar');
  assert.equal(result.tabs[0]!.toggles?.length, 2);
});

test('createCommandTabsFor returns status and usage tabs for /status and /usage', () => {
  const statusResult = createCommandTabsFor('/status', mockContext())!;
  assert.equal(statusResult.title, 'Status & Usage');
  assert.equal(statusResult.tabs.length, 2);
  assert.equal(statusResult.initialTab, 'status');

  const usageResult = createCommandTabsFor('/usage', mockContext())!;
  assert.equal(usageResult.initialTab, 'usage');
});
