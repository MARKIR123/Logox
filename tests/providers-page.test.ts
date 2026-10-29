import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../src/application.js';
import {loadConfig} from '../src/config/config.js';
import type {Provider} from '../src/runtime/messages.js';

test('Application /providers tab opens Providers page with actions support', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-providers-tab-'));
  try {
    const config = await loadConfig(cwd, {provider: {name: 'openai', model: 'gpt-4o'}}, {}, cwd, cwd);
    const mockProvider: Provider = {
      async respond() {
        return {message: {role: 'assistant', text: 'LOGOX_PROVIDER_READY'}, stop: 'complete'};
      },
    };

    const app = await createApplication({
      cwd,
      config,
      provider: mockProvider,
      sessionId: 'test-providers-session',
      resourceOptions: {home: cwd, boundary: cwd},
    });

    try {
      // 1. Submit /providers opens the page on 'providers' tab
      await app.submit('/providers');
      const snapshot = app.surfaces.getSnapshot();
      assert.equal(snapshot?.kind, 'page');
      if (snapshot?.kind === 'page') {
        assert.equal(snapshot.initialTab, 'providers');
        const provTab = snapshot.tabs.find(t => t.id === 'providers');
        assert.ok(provTab, 'Providers tab should exist in tabs list');
        assert.ok(provTab.lines.some(l => l.includes('Provider:')), 'Should display provider details');
        assert.ok(provTab.lines.some(l => l.includes('Models')), 'Should display models section');
      }

      // 2. Trigger test action
      if (snapshot?.kind === 'page') {
        await app.surfaces.triggerTabAction(snapshot.id, 'providers', 'test');
        const updated = app.surfaces.getSnapshot();
        if (updated?.kind === 'page') {
          const updatedTab = updated.tabs.find(t => t.id === 'providers')!;
          assert.ok(updatedTab.lines.some(l => l.includes('Connected') || l.includes('Offline')), 'Status should reflect connection test');
        }
      }
    } finally {
      await app.close();
    }
  } finally {
    await rm(cwd, {recursive: true, force: true});
  }
});

test('/provider is removed, including parameter forms; /providers remains the management page', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-provider-status-'));
  try {
    const config = await loadConfig(cwd, {provider: {name: 'openai', model: 'gpt-4o'}}, {}, cwd, cwd);
    const mockProvider: Provider = {
      async respond() {
        return {message: {role: 'assistant', text: 'LOGOX_PROVIDER_READY'}, stop: 'complete'};
      },
    };
    const app = await createApplication({
      cwd,
      config,
      provider: mockProvider,
      sessionId: 'test-provider-status-session',
      authPath: join(cwd, 'auth.json'),
      resourceOptions: {home: cwd, boundary: cwd},
    });
    try {
      for (const command of ['/provider', '/provider deepseek', '/provider check', '/provider logout openai']) {
        await assert.rejects(app.submit(command), /Unknown command/);
        assert.equal(app.surfaces.getSnapshot(), null);
      }
      assert.equal(app.store.getSnapshot().activities.length, 0, 'Removed commands cannot invoke a model');
      await app.submit('/help');
      const help = app.surfaces.getSnapshot(); assert.ok(help?.kind === 'result');
      const lines = help.text;
      assert.doesNotMatch(lines, /\/provider(?=\s|$)/);
      assert.match(lines, /\/providers\b/);
      app.surfaces.cancel();
      await app.submit('/providers');
      const surface = app.surfaces.getSnapshot();
      assert.equal(surface?.kind, 'page');
      if (surface?.kind !== 'page') throw new Error('Providers page expected');
      assert.equal(surface.initialTab, 'providers');
    } finally {
      await app.close();
    }
  } finally {
    await rm(cwd, {recursive: true, force: true});
  }
});
