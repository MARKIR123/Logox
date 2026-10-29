import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../src/application.js';
import {loadConfig} from '../src/config/config.js';

test('slash commands can be viewed, opened, and executed while tasks are actively running', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-busy-slash-'));
  const config = await loadConfig(cwd, {
    provider: {name: 'alpha', model: 'session-model'},
    providers: {
      alpha: {base_url: 'http://127.0.0.1:7777/v1'},
      beta: {base_url: 'http://127.0.0.1:8888/v1'},
    },
  }, {}, cwd, cwd);

  let finishTask!: () => void;
  const app = await createApplication({
    cwd,
    resourceOptions: {home: cwd, boundary: cwd},
    config,
    env: {},
    authPath: join(cwd, 'auth.json'),
    fetcher: async url => {
      if (String(url).endsWith('/models')) return Response.json({data: [{id: 'session-model'}, {id: 'fast-model'}]});
      throw new Error('Unexpected fixture network request');
    },
    provider: {
      respond: async () => {
        await new Promise<void>(resolve => {finishTask = resolve;});
        return {
          message: {role: 'assistant', text: 'Task completed.'},
          stop: 'complete',
        };
      },
    },
  });

  try {
    // Start an asynchronous running task so ensemble.isBusy() becomes true
    const taskPromise = app.submit('start long task');
    // Busy includes admitted queue work; a resident Director need not enter the provider immediately.
    await taskPromise;
    // Ensure task has begun and is busy
    assert.ok(app.ensemble.isBusy(), 'Ensemble should be busy running the task');

    // 1. /status should open while busy
    await app.submit('/status');
    let surface = app.surfaces.getSnapshot();
    assert.equal(surface?.kind, 'page');
    assert.equal(surface.title, 'Status & Usage');

    // 2. /help should open without needing to manually close previous surface first
    await app.submit('/help');
    surface = app.surfaces.getSnapshot();
    assert.equal(surface?.kind, 'result');
    assert.equal(surface.title, 'Help & Commands');

    // 3. Both editable settings and read-only config should open while busy
    await app.submit('/settings');
    surface = app.surfaces.getSnapshot();
    assert.equal(surface?.kind, 'page');
    assert.equal(surface.title, 'Settings');
    assert.equal(surface.initialTab, 'settings');
    await app.submit('/config');
    surface = app.surfaces.getSnapshot();
    assert.equal(surface?.kind, 'page');
    assert.equal(surface.title, 'Effective Configuration');
    assert.equal(surface.tabs.length, 1);
    assert.equal(surface.tabs[0]!.toggles, undefined);

    // 4. /providers should open while busy (previously blocked by requireIdle)
    await app.submit('/providers');
    surface = app.surfaces.getSnapshot();
    assert.equal(surface?.kind, 'page');
    assert.equal(surface.title, 'Providers');

    // 5. /permissions should open and mode can be toggled while busy
    await app.submit('/permissions');
    surface = app.surfaces.getSnapshot();
    assert.equal(surface?.kind, 'page');
    assert.equal(surface.title, 'Permissions');
    await app.submit('/permissions mode auto');
    assert.equal(app.permissions.mode, 'auto');

    // 6. /model automa should open picker while busy
    await app.submit('/model automa');
    let picker = app.surfaces.getSnapshot();
    assert.equal(picker?.kind, 'picker');
    assert.equal(picker.title, 'Select Model for Automa');

    // 7. /model automa <model> should configure automa model directly while busy
    await app.submit('/model automa beta/fast-model');
    assert.deepEqual(app.tools.modelStorage.get('automa'), {provider: 'beta', model: 'fast-model'});

    // 8. /model should open session model picker while busy
    await app.submit('/model');
    picker = app.surfaces.getSnapshot();
    assert.equal(picker?.kind, 'picker');
    assert.equal(picker.title, 'Select Model for Logox');
    app.surfaces.cancel();

    // 9. /skills should work while busy
    await app.submit('/skills');
    assert.equal(app.surfaces.getSnapshot()?.kind, 'result');
    app.surfaces.cancel();

    // Finally complete the task
    finishTask?.();
    await taskPromise.catch(() => {});

    // 10. Verify that none of the system notices, slash command panels, or errors entered model context journal
    const entries = await app.journal.load(app.sessionId, 'logox');
    assert.ok(!entries.some(e => (e as any).role === 'system'), 'Model journal must never contain system role messages');
    assert.ok(!entries.some(e => e.text.includes('Permission mode switched to')), 'System notice must not leak to model context');
    assert.ok(!entries.some(e => e.text.includes('Automa model set to')), 'Model setting notices must not leak to model context');
    assert.ok(!entries.some(e => e.text.includes('Help & Commands')), 'Slash command UI text must not leak to model context');
    assert.ok(!entries.some(e => e.text.includes('Tasks are running')), 'Error flashes must not leak to model context');
  } finally {
    await app.close();
    await rm(cwd, {recursive: true, force: true});
  }
});
