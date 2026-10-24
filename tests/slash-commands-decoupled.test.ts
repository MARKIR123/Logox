import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCommandTabsFor, type ApplicationCommandContext} from '../src/application-commands.js';
import {createApplication} from '../src/application.js';
import {loadConfig} from '../src/config/config.js';

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

test('toggling permission mode updates dedicated single-tab surface without flashing monolithic tabs', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-perm-flash-'));
  const config = await loadConfig(cwd, {provider: {model: 'test', context_window: 8192}}, {}, cwd, cwd);
  const app = await createApplication({cwd, config, env: {}, sessionId: 'test', authPath: join(cwd, 'auth.json'), resourceOptions: {home: cwd, boundary: cwd}});
  try {
    await app.submit('/permissions');
    const page = app.surfaces.getSnapshot();
    assert.ok(page?.kind === 'page');
    assert.equal(page.tabs.length, 1);
    assert.equal(page.tabs[0]!.id, 'permissions');

    const updateCalls: number[] = [];
    app.surfaces.subscribe(() => {
      const current = app.surfaces.getSnapshot();
      if (current?.kind === 'page') {
        updateCalls.push(current.tabs.length);
      }
    });

    await app.surfaces.triggerTabAction(page.id, 'permissions', 'toggle_mode');

    // Every update to the page during toggle must preserve the single-tab (length 1), NEVER emitting 9 tabs
    assert.ok(updateCalls.length > 0);
    for (const count of updateCalls) {
      assert.equal(count, 1, 'Tabs count during permission update must strictly remain 1');
    }
  } finally {
    app.surfaces.cancel();
    await app.close();
    await rm(cwd, {recursive: true, force: true});
  }
});

