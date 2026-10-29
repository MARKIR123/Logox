import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {act} from 'react';
import {setTimeout as delay} from 'node:timers/promises';
import {renderTerminal as render} from '../src/tui/terminal/terminal.js';
import {TerminalScreen} from './terminal-screen.js';
import {App} from '../src/tui/app.js';
import {createApplication} from '../src/application.js';
import {loadConfig} from '../src/config/config.js';
Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
class Input extends PassThrough {isTTY = true; setRawMode(): this {return this;} ref(): this {return this;} unref(): this {return this;}}
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-local-login-'));
  const config = await loadConfig(cwd, {provider: {name: 'deepseek', model: 'fixture'}}, {}, cwd, cwd);
  const app = await createApplication({cwd, config, resourceOptions: {home: cwd, boundary: cwd}, env: {}, authPath: join(cwd, 'auth.json'),
    fetcher: async () => new Response(JSON.stringify({data: [{id: 'fixture-model'}]})),
    provider: {respond: async () => {throw new Error('No model call is allowed');}}});
  const input = new Input(), output = new TerminalScreen(); output.columns = 80; output.rows = 28;
  const submissions: string[] = []; let instance!: ReturnType<typeof render>;
  await act(async () => {
    instance = render(<App stage store={app.store} sessionId={app.sessionId} authentication={app.authentication}
      onSubmit={async text => {submissions.push(text);}} onCancel={app.cancel} onClose={app.close}/>,
      {stdin: input, stdout: output, stderr: output, interactive: true, alternateScreen: true, patchConsole: false, exitOnCtrlC: false, maxFps: 100});
  });
  const flush = async () => {await act(async () => {await instance.waitUntilRenderFlush();});};
  const key = async (...chunks: string[]) => {
    await act(async () => {for (const chunk of chunks) {input.write(chunk); await delay(0);} await delay(25);}); await flush();
  };
  let submitted: Promise<unknown> | undefined;
  return {app, input, output, submissions, key, screen: () => output.lines.join('\n'),
    begin: async () => {await act(async () => {submitted = app.submit('/login'); await delay(25);}); await flush();},
    finish: async () => {await act(async () => {await submitted;}); await flush();},
    close: async () => {await act(async () => {await app.close(); await submitted; instance.unmount();}); await instance.waitUntilExit(); input.destroy(); output.destroy(); await rm(cwd, {recursive: true, force: true});}, cwd};
}
test('real /login: every step owns input, optional key submits empty, batch navigation restores URL', {timeout: 15000}, async () => {
  const f = await fixture();
  try {
    await f.key('Keep chat draft'); await f.begin();
    assert.match(f.screen(), /Add a new provider/); assert.match(f.screen(), /Edit an existing provider/);
    await f.key('\r'); assert.match(f.screen(), /Built-in provider/); assert.match(f.screen(), /Account sign-in/);
    await f.key('\x1b[B'); await f.key('\r'); assert.match(f.screen(), /Enter a route name/);
    await f.key('local-', 'fixture', '\r'); assert.match(f.screen(), /Enter the API key/);
    assert.match(f.screen(), /Input:/); assert.doesNotMatch(f.screen(), /My view/);
    await f.key('\r'); assert.match(f.screen(), /base URL or port/); assert.match(f.screen(), /Question 1\/2/);
    await f.key('8045'); await f.key('\x1b[C'); assert.match(f.screen(), /Question 2\/2/);
    await f.key('\x1b[D'); assert.match(f.screen(), /8045/);
    await f.key('\r'); assert.match(f.screen(), /wire protocol/);
    await f.key('\x1b[B'); await f.key('\r'); assert.match(f.screen(), /Select the models/);
    await f.key(' '); await f.key('\r'); assert.match(f.screen(), /Write this provider configuration/);
    await f.key('\r');
    assert.equal(f.app.authentication.getSnapshot(), null);
    // Closing the final form resolves its answer before asynchronous persistence finishes.
    // Await the public command completion, not a fixed delay under parallel CPU/IO load.
    await f.finish();
    const records = JSON.parse(await readFile(join(f.cwd, '.logox', 'custom-providers.json'), 'utf8'));
    assert.equal(records['local-fixture'].api, 'responses');
    assert.deepEqual(records['local-fixture'].models, ['fixture-model']);
    await assert.rejects(readFile(join(f.cwd, 'auth.json'), 'utf8'), {code: 'ENOENT'});
    assert.equal(f.app.store.interactions.list().length, 0, 'Local login never uses model/tool interactions');
    assert.deepEqual(f.submissions, []);
    assert.match(f.screen(), /Keep chat draft/);
  } finally {await f.close();}
});
test('real /login: masked input stays out of snapshots and runtime, fold restores both drafts', {timeout: 15000}, async () => {
  const f = await fixture();
  try {
    await f.key('Chat draft'); await f.begin(); await f.key('\r'); await f.key('\x1b[B'); await f.key('\r');
    await f.key('secret-route', '\r'); await f.key('fixture-', 'secret');
    assert.ok(!f.output.text.includes('fixture-secret'));
    assert.ok(!JSON.stringify(f.app.authentication.getSnapshot()).includes('fixture-secret'));
    assert.ok(!JSON.stringify(f.app.store.getSnapshot()).includes('fixture-secret'));
    await f.key('\x0b'); assert.match(f.screen(), /Chat draft/);
    await f.key(' + kept'); await f.key('\x0b'); assert.match(f.screen(), /•/);
    await f.key('\r'); assert.match(f.screen(), /base URL or port/);
    await f.key('\x1b');
    assert.equal(f.app.authentication.getSnapshot(), null);
    assert.match(f.screen(), /Chat draft \+ kept/); assert.deepEqual(f.submissions, []);
    await assert.rejects(readFile(join(f.cwd, 'auth.json'), 'utf8'), {code: 'ENOENT'});
  } finally {await f.close();}
});
