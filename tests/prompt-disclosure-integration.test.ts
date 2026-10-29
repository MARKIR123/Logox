import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../src/application.js';
import {loadConfig} from '../src/config/config.js';
import {builtinActors} from '../src/actors/builtins.js';
import {buildStageRows} from '../src/tui/timeline/stage.js';
import {Resources} from '../src/resources/manager.js';
import {reloadResources} from '../src/resources/reload.js';
import type {Provider, ModelRequest, ToolDiscoveryProtocol} from '../src/runtime/messages.js';

const headings = ['# Persona', '# Execution Rules', '# Team Collaboration', '# Tools & Skills', '# Current Environment'];
const finish = (id: string) => ({id, name: '_FinishRound', arguments: JSON.stringify({title: 'Verified fixture', verification: null, carry_forward: []})});

for (const protocol of ['anthropic', 'openai-responses', 'none'] as const satisfies readonly ToolDiscoveryProtocol[]) {
  test('real application composes five owned topics for shipped and custom roles with ' + protocol, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'logox-prompt-acceptance-'));
    const seen: ModelRequest[] = [];
    const profile = join(cwd, '.logox', 'actors', 'custom-specialist');
    await mkdir(profile, {recursive: true});
    await writeFile(join(profile, 'config.yaml'), 'id: custom-specialist\nname: Specialist\ntitle: Specialist\ndescription: Custom specialist\ncolor: "#123456"\nsymbol: S\n');
    for (const [file, text] of [['persona.md', 'Custom identity.'], ['compression.md', 'Custom evidence focus.'], ['execution.md', 'Custom execution method.'], ['collaboration.md', 'Custom collaboration boundary.']]) await writeFile(join(profile, file!), text!);
    const provider: Provider = {capabilities: {toolDiscovery: protocol, runtimeInstructions: 'meta-user', caching: 'none'}, async respond(request) {
      seen.push(request);
      return {stop: 'tools', message: {role: 'assistant', text: 'Verified fixture response.', toolCalls: [finish('finish-' + seen.length)]}};
    }};
    const config = await loadConfig(cwd, {provider: {model: 'fixture', context_window: 131072}}, {}, cwd, cwd);
    const app = await createApplication({cwd, sessionId: 's', config, provider, env: {}, authPath: join(cwd, 'auth.json'), resourceOptions: {home: cwd, boundary: cwd}});
    try {
      for (const id of [...builtinActors.map(actor => actor.id), 'custom-specialist']) {
        const task = app.ensemble.dispatch(id, 'Explain the current task.', 'direct', {inputKind: 'human'});
        await task.done;
        assert.equal(app.store.activities.get('s', task.activityId)?.status, 'completed');
        const request = seen.at(-1)!;
        assert.deepEqual(request.system.match(/^# .+$/gm), headings);
        assert.equal(request.system.split('<number> | <title> | <status>[; <verification>] | <carry-forward> | <start>:<end>').length - 1, 1);
        assert.equal((request.system.match(/never delegate understanding/g) ?? []).length, 1, 'Shared delegation policy has one authoritative source');
        const role = builtinActors.find(actor => actor.id === id);
        for (const text of role ? [role.prompt, role.execution, role.collaboration, role.compression] : ['Custom identity.', 'Custom execution method.', 'Custom collaboration boundary.', 'Custom evidence focus.']) {
          if (text) assert.equal(request.system.split(text.trim()).length - 1, 1, id + ' owns each rule once');
        }
        const discovery = request.system.split('# Tools & Skills')[1]!.split('# Current Environment')[0]!;
        assert.ok(!discovery.includes('- Read:') && !request.system.includes('Available Tools'));
        assert.ok(!request.system.split('# Current Environment')[1]!.match(/Tools:|Skills:|Available/));
        assert.equal(request.toolDiscovery, protocol === 'none' ? undefined : protocol);
        assert.equal(new Set(request.tools.map(tool => tool.name)).size, request.tools.length);
        assert.ok(request.tools.some(tool => tool.name === '_FinishRound'));
        if (protocol === 'none') {
          assert.ok(request.tools.some(tool => tool.name === '_GitStatus'));
          assert.ok(!request.tools.some(tool => tool.name === 'LoadTools'));
          assert.ok(!discovery.includes('_GitStatus:'));
        } else {
          assert.match(discovery, /_GitStatus: .+/);
          assert.ok(!request.tools.some(tool => tool.name === '_GitStatus'));
          assert.ok(request.tools.some(tool => tool.name === 'LoadTools'));
        }
      }
      for (const role of builtinActors) {
        for (const name of ['persona.md', 'execution.md', 'collaboration.md']) {
          assert.equal(await readFile(new URL('../src/actors/profiles/' + role.id + '/' + name, import.meta.url), 'utf8'),
            await readFile(join(cwd, '.logox', 'actors', role.id, name), 'utf8'));
        }
      }
      assert.match(await readFile(new URL('../src/tools/AGENTS.md', import.meta.url), 'utf8'), /categories:/);
    } finally {await app.close(); await rm(cwd, {recursive: true, force: true});}
  });
}

test('resource reload invalidates worker-only skill changes without mixing guidelines into skill discovery', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-role-reload-'));
  try {
    const resources = new Resources(cwd, {home: cwd, boundary: cwd});
    await resources.reload();
    const directory = join(cwd, '.logox', 'skills', 'techne');
    await mkdir(directory, {recursive: true});
    await writeFile(join(directory, 'specific.md'), '---\nname: specific\ndescription: Worker-only method\n---\nPrivate instruction body.');
    const result = await reloadResources(resources, async () => {});
    assert.equal(result.prefixChanged, true, 'Worker-only changes also invalidate role request estimates');
    assert.match(resources.promptSections({actorId: 'techne'}).skills, /Worker-only method/);
    assert.doesNotMatch(result.text, /[一-鿿]/);
  } finally {await rm(cwd, {recursive: true, force: true});}
});

test('application-owned terminal visibility overrides do not leak into a second application', async () => {
  const root = await mkdtemp(join(tmpdir(), 'logox-visibility-acceptance-'));
  try {
    for (const [name, silent] of [['quiet', true], ['ordinary', false]] as const) {
      const cwd = join(root, name); await mkdir(join(cwd, '.logox'), {recursive: true});
      await writeFile(join(cwd, 'evidence.txt'), 'Visible evidence');
      if (silent) await writeFile(join(cwd, '.logox', 'tools.json'), JSON.stringify({Read: {terminalVisibility: 'silent'}}));
      let calls = 0;
      const provider: Provider = {async respond() {return ++calls === 1 ? {stop: 'tools', message: {role: 'assistant', text: '', toolCalls: [{id: 'read', name: 'Read', arguments: '{"file_path":"evidence.txt"}'}]}} :
        {stop: 'tools', message: {role: 'assistant', text: 'Read completed.', toolCalls: [finish('finish')]}};}};
      const config = await loadConfig(cwd, {provider: {model: 'fixture', context_window: 131072}}, {}, cwd, cwd);
      const options = {cwd, sessionId: 's', config, provider, env: {}, authPath: join(cwd, 'auth.json'), resourceOptions: {home: cwd, boundary: cwd}};
      let app = await createApplication(options);
      try {
        await app.ensemble.dispatch('logox', 'Read the evidence.', 'direct', {inputKind: 'human'}).done;
        for (let resume = 0; resume < 2; resume++) {
          const message = app.store.getSnapshot().messages.find(message => message.step?.call?.name === 'Read');
          assert.ok(message, 'The real executed result remains recorded');
          const rows = buildStageRows(app.store.getSnapshot(), 's', 'logox', 90, {}, null);
          assert.equal(rows.some(row => row.messageId === message.id), !silent);
          if (!resume) {await app.close(); app = await createApplication(options);}
        }
        assert.equal(calls, 2, 'Restart never executes the tool again');
      } finally {await app.close();}
    }
  } finally {await rm(root, {recursive: true, force: true});}
});

test('stored OAuth capabilities are resolved before the first production request without a remote probe', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-stored-discovery-'));
  const authPath = join(cwd, 'auth.json');
  await writeFile(authPath, JSON.stringify({openai: {type: 'oauth', access_token: 'oauth-fixture'}}));
  const bodies: Array<Record<string, any>> = [];
  const config = await loadConfig(cwd, {provider: {name: 'openai', model: 'gpt-5.4', context_window: 131072}}, {}, cwd, cwd);
  const app = await createApplication({cwd, sessionId: 's', config, env: {}, authPath, resourceOptions: {home: cwd, boundary: cwd}, fetcher: async (url, init) => {
    assert.ok(String(url).endsWith('/responses'), 'No capability probe or model catalog request');
    bodies.push(JSON.parse(String(init?.body)));
    return new Response('data: ' + JSON.stringify({type: 'response.output_text.delta', delta: 'Resolved without a probe.'}) + '\n\n' +
      'data: ' + JSON.stringify({type: 'response.output_item.done', output_index: 0, item: {type: 'function_call', call_id: 'finish', name: '_FinishRound', arguments: finish('unused').arguments}}) + '\n\n' +
      'data: ' + JSON.stringify({type: 'response.completed', response: {status: 'completed'}}) + '\n\n', {headers: {'content-type': 'text/event-stream'}});
  }});
  try {
    const task = app.ensemble.dispatch('logox', 'Explain normally.', 'direct', {inputKind: 'human'}); await task.done;
    assert.equal(app.store.activities.get('s', task.activityId)?.status, 'completed');
    assert.equal(bodies.length, 1);
    assert.ok(bodies[0]!.tools.some((tool: any) => tool.type === 'tool_search' && tool.execution === 'client'));
    assert.ok(!bodies[0]!.tools.some((tool: any) => tool.name === '_GitStatus'));
  } finally {await app.close(); await rm(cwd, {recursive: true, force: true});}
});
