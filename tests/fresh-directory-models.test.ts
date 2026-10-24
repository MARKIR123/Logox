import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createApplication} from '../src/application.js';
import {loadConfig} from '../src/config/config.js';

const bindings = {techne: {provider: 'openai', model: 'dedicated-builder'}, aletheia: {provider: 'antigravity', model: 'dedicated-scout'}, kalon: {provider: 'antigravity', model: 'dedicated-designer'}};

test('fresh projects without a main model can open all tabs and retain user actor bindings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-fresh-models-')), home = join(root, 'home');
  try {
    await mkdir(join(home, '.logox'), {recursive: true});
    const path = join(home, '.logox', 'actor-models.json');
    await writeFile(path, JSON.stringify(bindings));
    const before = await readFile(path, 'utf8');
    for (const name of ['first-project', 'new-project']) {
      const cwd = join(root, name); await mkdir(cwd);
      const config = await loadConfig(cwd, {}, {}, home, cwd);
      assert.equal(config.provider.model, '');
      const app = await createApplication({cwd, config, env: {}, sessionId: 's', authPath: join(home, 'fixture-auth.json'), resourceOptions: {home, boundary: cwd},
        provider: {async respond() {throw new Error('Opening tabs must not call a model');}}});
      try {
        for (const command of ['/ensemble', '/status', '/providers', '/config', '/usage', '/permissions', '/commands']) {
          await app.submit(command);
          const page = app.surfaces.getSnapshot(); assert.ok(page?.kind === 'page', command);
          app.surfaces.cancel();
        }
        await app.submit('/ensemble');
        const ensemblePage = app.surfaces.getSnapshot(); assert.ok(ensemblePage?.kind === 'page');
        assert.ok(ensemblePage.tabs.find(tab => tab.id === 'actors')?.lines.join('\n').includes('dedicated-builder'));
        app.surfaces.cancel();
        for (const [id, selected] of Object.entries(bindings)) assert.deepEqual(app.actors.find(id)?.defaultModel, selected);
      } finally {await app.close();}
    }
    assert.equal(await readFile(path, 'utf8'), before);
  } finally {await rm(root, {recursive: true, force: true});}
});

test('new project config reads canonical global preferences before legacy fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-global-selection-')), home = join(root, 'home'), cwd = join(root, 'new-project');
  try {
    await mkdir(join(home, '.logox'), {recursive: true}); await mkdir(join(home, '.logox-ts')); await mkdir(cwd);
    await writeFile(join(home, '.logox', 'model-preferences.json'), JSON.stringify({version: 1, provider: 'openai', model: 'main-model', effort: 'auto'}));
    await writeFile(join(home, '.logox-ts', 'model-preferences.json'), JSON.stringify({version: 1, provider: 'antigravity', model: 'old-model', effort: 'auto'}));
    assert.equal((await loadConfig(cwd, {}, {}, home, cwd)).provider.model, 'main-model');
    await mkdir(join(cwd, '.logox', 'state'), {recursive: true});
    await writeFile(join(cwd, '.logox', 'state', 'model-preferences.json'), JSON.stringify({version: 1, provider: 'openai', model: 'project-model', effort: 'auto'}));
    assert.equal((await loadConfig(cwd, {}, {}, home, cwd)).provider.model, 'project-model');
    await rm(join(cwd, '.logox', 'state', 'model-preferences.json'));
    await rm(join(home, '.logox', 'model-preferences.json'));
    assert.equal((await loadConfig(cwd, {}, {}, home, cwd)).provider.model, 'old-model');
  } finally {await rm(root, {recursive: true, force: true});}
});

test('model selection writes the injected home, never the process real-home fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-home-isolation-')), home = join(root, 'injected-home'), guard = join(root, 'process-home'), cwd = join(root, 'project');
  try {
    await mkdir(home); await mkdir(join(guard, '.logox'), {recursive: true}); await mkdir(cwd);
    const guardPath = join(guard, '.logox', 'model-preferences.json');
    const original = JSON.stringify({version: 1, provider: 'openai', model: 'must-not-change', effort: 'auto'});
    await writeFile(guardPath, original);
    const application = new URL('../src/application.js', import.meta.url).href;
    const configuration = new URL('../src/config/config.js', import.meta.url).href;
    const script = `import {createApplication} from ${JSON.stringify(application)};
import {loadConfig} from ${JSON.stringify(configuration)};
import {mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const cwd=${JSON.stringify(cwd)}, home=${JSON.stringify(home)};
const config=await loadConfig(cwd,{provider:{model:'initial',context_window:131072}},{},home,cwd);
const app=await createApplication({cwd,config,env:{},authPath:home+'/auth.json',resourceOptions:{home,boundary:cwd}});
try {await app.submit('/model selected-main');} finally {await app.close();}
await mkdir(cwd+'-new');
const reopened=await createApplication({cwd:cwd+'-new',env:{},authPath:home+'/auth.json',resourceOptions:{home,boundary:cwd+'-new'}});
try {await reopened.submit('/config'); const page=reopened.surfaces.getSnapshot(); assert.ok(page?.kind==='page'); assert.ok(page.tabs.find(tab=>tab.id==='config').lines.includes('Model: selected-main'));} finally {await reopened.close();}`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {cwd: root, env: {...process.env, USERPROFILE: guard, HOME: guard}, encoding: 'utf8', timeout: 15000});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(guardPath, 'utf8'), original, 'Process home must be untouched when an isolated home is supplied');
    const saved = JSON.parse(await readFile(join(home, '.logox', 'model-preferences.json'), 'utf8'));
    assert.equal(saved.model, 'selected-main');
  } finally {await rm(root, {recursive: true, force: true});}
});
