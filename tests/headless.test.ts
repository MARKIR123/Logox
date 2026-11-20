import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {access, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {basename, join} from 'node:path';
import {seedActorProfiles} from '../src/actors/profiles.js';
import {HEADLESS_ANSWER, HEADLESS_DENIAL, HEADLESS_HELP, HEADLESS_NO_MODEL, isHeadlessArgv, runHeadless, type HeadlessIo} from '../src/headless.js';
import {finalizingProvider} from './runtime-fixture.js';
import type {ModelRequest, ModelTurn, Provider} from '../src/runtime/messages.js';

const CONFIG = '[provider]\nmodel = "fixture"\ncontext_window = 131072\n\n[kernel]\nmax_retries = 0\n';
const reply = (text: string, usage?: ModelTurn['usage']): ModelTurn => ({stop: 'complete', message: {role: 'assistant', text}, ...(usage ? {usage} : {})});
const calls = (...items: {name: string; arguments: unknown}[]): ModelTurn => ({stop: 'tools',
  message: {role: 'assistant', text: '', toolCalls: items.map((item, index) => ({id: item.name.toLowerCase() + '-' + index, name: item.name, arguments: JSON.stringify(item.arguments)}))}});
const firstUser = (request: ModelRequest) => request.messages.find(message => message.role === 'user')?.text ?? '';
const answered = (request: ModelRequest) => request.messages.some(message => message.role === 'tool');

async function root(config = CONFIG) {
  const dir = await mkdtemp(join(tmpdir(), 'logox-test-headless-'));
  await mkdir(join(dir, '.logox'), {recursive: true});
  await writeFile(join(dir, '.logox', 'config.toml'), config);
  return dir;
}
function harness(dir: string, provider: Provider | undefined, extra: Partial<HeadlessIo> = {}) {
  const out: string[] = [], err: string[] = [], signals = new EventEmitter();
  const io = {cwd: dir, env: {}, stdout: (text: string) => out.push(text), stderr: (text: string) => err.push(text), signals: signals as unknown as HeadlessIo['signals'],
    ...(provider ? {provider: finalizingProvider(provider)} : {}), resourceOptions: {home: dir, boundary: dir}, authPath: join(dir, 'auth.json'), ...extra} as HeadlessIo;
  return {io, out, err, signals, stdout: () => out.join(''), stderr: () => err.join('')};
}
const exists = (path: string) => access(path).then(() => true, () => false);

test('text output is only the final reply of the Director; the session id goes to stderr', {timeout: 60000}, async () => {
  const dir = await root();
  try {
    const h = harness(dir, {respond: async () => reply('All done.')});
    assert.equal(await runHeadless(['-p', 'say hello'], h.io), 0);
    assert.equal(h.stdout(), 'All done.\n');
    assert.match(h.stderr(), /^Session [0-9a-f-]{36}\n/);
    assert.doesNotMatch(h.stdout(), /\x1b\[/, 'no terminal control sequences on stdout');
  } finally {await rm(dir, {recursive: true, force: true});}
});

test('json output carries status, final text, actor counts and usage, and the session id still goes to stderr', {timeout: 60000}, async () => {
  const dir = await root();
  try {
    const h = harness(dir, {respond: async () => reply('Hello there.', {input: 10, output: 5})});
    assert.equal(await runHeadless(['--print', 'greet', '--output', 'json'], h.io), 0);
    const report = JSON.parse(h.stdout());
    assert.equal(report.version, 1); assert.equal(report.status, 'completed'); assert.equal(report.final, 'Hello there.');
    assert.equal(h.stderr().trim().replace(/^Session /, ''), report.sessionId);
    assert.deepEqual(report.actors.logox.tasks, 1); assert.equal(report.actors.logox.toolCalls, 0);
    assert.deepEqual(report.automa, {jobs: 0, done: 0, blocked: 0, failed: 0});
    assert.deepEqual(report.delegations, [], 'nothing was delegated');
    assert.ok(report.durationMs >= 0); assert.deepEqual(report.errors, []); assert.deepEqual(report.changedFiles, []);
    assert.ok(report.usage.inputTokens >= 10 && report.usage.outputTokens >= 5, JSON.stringify(report.usage));
    assert.ok(report.usage.byActor.logox.inputTokens >= 10); assert.ok(report.usage.byCategory.task.outputTokens >= 5);
    for (const key of ['cacheReadTokens', 'cacheWriteTokens', 'costUsd']) assert.ok(key in report.usage, key);
  } finally {await rm(dir, {recursive: true, force: true});}
});

test('the CLI waits for a dispatched companion and an Automa job and reports both in json', {timeout: 90000}, async () => {
  const dir = await root('[provider]\nname = "alpha"\nmodel = "session-model"\n\n[providers.alpha]\nbase_url = "http://127.0.0.1:7777/v1"\n\n' +
    '[models."alpha/session-model"]\ncontext_window = 64000\n\n[models."alpha/my-worker"]\ncontext_window = 64000\n\n[kernel]\nmax_retries = 0\n');
  try {
    await writeFile(join(dir, 'notes.txt'), 'the answer is 42\n');
    let workerRequests = 0;
    const sse = (chunk: unknown) => 'data: ' + JSON.stringify(chunk) + '\n\n';
    const fetcher: typeof fetch = async () => {
      const first = workerRequests++ === 0;
      const delta = {tool_calls: [{index: 0, id: 'w' + workerRequests, type: 'function', function: first ? {name: 'Read', arguments: JSON.stringify({file_path: 'notes.txt'})}
        : {name: 'Finish', arguments: JSON.stringify({status: 'done', summary: 'the answer is 42', evidence: ['notes.txt:1']})}}]};
      return new Response(sse({choices: [{index: 0, delta, finish_reason: 'tool_calls'}]}) + sse({choices: [], usage: {prompt_tokens: 100, completion_tokens: 7}}) + 'data: [DONE]\n\n',
        {status: 200, headers: {'content-type': 'text/event-stream'}});
    };
    const provider: Provider = {async respond(request) {
      if (firstUser(request).includes('child work')) {await new Promise(resolve => setTimeout(resolve, 300)); return reply('child done');}
      const text = request.messages.map(message => message.text).join('\n');
      if (text.includes('child done')) return reply('Everything is finished.');
      if (answered(request)) return reply('Dispatched; waiting for the reports.');
      return calls({name: 'Actor', arguments: {tasks: [{ownerId: 'kalon', prompt: 'child work', title: 'Child'}]}},
        {name: 'Automa', arguments: {jobs: [{title: 'Find the answer', brief: 'Find the answer in notes.txt', scope: 'exact'}]}});
    }};
    const h = harness(dir, provider, {fetcher, env: {}});
    assert.equal(await runHeadless(['-p', 'go', '--output', 'json', '--model', 'session-model', '--provider', 'alpha', '--permission-mode', 'creative'], h.io), 0, h.stderr());
    const report = JSON.parse(h.stdout());
    assert.equal(report.status, 'completed', h.stdout());
    assert.equal(report.final, 'Everything is finished.');
    assert.equal(report.actors.kalon.tasks, 1);
    assert.ok(report.actors.logox.tasks >= 2, 'the Director ran again when the report arrived');
    assert.equal(report.automa.jobs, 1, JSON.stringify(report.automa));
    assert.equal(report.automa.done + report.automa.blocked + report.automa.failed, 1, 'the job had ended before the run did');
    // The delegation record of the run: the companion and the worker, each with how it ended.
    const child = report.delegations.find((item: {owner: string}) => item.owner === 'kalon');
    assert.deepEqual({kind: child.kind, title: child.title, status: child.status, stopReason: child.stopReason, blockedBy: child.blockedBy}, {kind: 'actor', title: 'Child', status: 'completed', stopReason: 'completed', blockedBy: []});
    assert.equal(typeof child.parentId, 'string'); assert.ok(child.durationMs >= 0); assert.ok(child.costUsd === null || typeof child.costUsd === 'number');
    assert.equal(child.result.summary.length > 0, true); assert.deepEqual(child.result.notVerified, []);
    const worker = report.delegations.find((item: {kind: string}) => item.kind === 'automa');
    assert.match(worker.id, /^[A-Z]\d+$/); assert.equal(worker.title, 'Find the answer'); assert.equal(worker.status, 'done'); assert.equal(worker.stopReason, 'completed');
    assert.equal(worker.route, 'read'); assert.equal(worker.parentId !== null, true); assert.equal(worker.result.summary, 'the answer is 42');
    assert.equal(report.delegations.length, 2);
  } finally {await rm(dir, {recursive: true, force: true});}
});

/** The model names the file relative to the project, as it normally does; the test dir has an 8.3 short name on Windows. */
const writer = (file: string) => {
  const requests: ModelRequest[] = [];
  const provider: Provider = {async respond(request) {
    requests.push(structuredClone(request));
    return answered(request) ? reply('Finished.') : calls({name: 'Write', arguments: {file_path: basename(file), content: 'hello\n'}});
  }};
  return {provider, requests};
};

test('a permission request that would ask is denied with the headless reason; --permission-mode auto lets it proceed and is not saved', {timeout: 90000}, async () => {
  const dir = await root();
  try {
    const file = join(dir, 'out.txt');
    const denied = writer(file), h = harness(dir, denied.provider);
    assert.equal(await runHeadless(['-p', 'write the file', '--permission-mode', 'default'], h.io), 0);
    assert.equal(await exists(file), false, 'a denied write did not happen');
    assert.ok(denied.requests.some(request => JSON.stringify(request.messages).includes(HEADLESS_DENIAL)), 'the model was told why');
    const allowed = writer(file), second = harness(dir, allowed.provider);
    assert.equal(await runHeadless(['-p', 'write the file', '--permission-mode', 'auto', '--output', 'json'], second.io), 0);
    assert.equal(await readFile(file, 'utf8'), 'hello\n');
    assert.deepEqual(JSON.parse(second.stdout()).changedFiles, ['out.txt']);
    assert.equal(await exists(join(dir, '.logox', 'permission-mode.json')), false, 'the mode of one run is never saved');
  } finally {await rm(dir, {recursive: true, force: true});}
});

test('AskUserQuestion is answered with the headless text and the run goes on', {timeout: 60000}, async () => {
  const dir = await root();
  try {
    const requests: ModelRequest[] = [];
    const question = {header: 'Choice', question: 'Which option?', options: [{label: 'A', description: 'first'}, {label: 'B', description: 'second'}]};
    const h = harness(dir, {async respond(request) {
      requests.push(structuredClone(request));
      return answered(request) ? reply('I assumed A.') : calls({name: 'AskUserQuestion', arguments: {questions: [question]}});
    }});
    assert.equal(await runHeadless(['-p', 'decide'], h.io), 0);
    assert.equal(h.stdout(), 'I assumed A.\n');
    assert.ok(requests.some(request => JSON.stringify(request.messages).includes(HEADLESS_ANSWER)));
  } finally {await rm(dir, {recursive: true, force: true});}
});

test('--timeout cancels the work, settles, reports status timeout and exits 2', {timeout: 60000}, async () => {
  const dir = await root();
  try {
    const h = harness(dir, {async respond(_request, _delta, signal) {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), {once: true}));
      signal.throwIfAborted();
      return reply('never');
    }});
    assert.equal(await runHeadless(['-p', 'take forever', '--timeout', '0.02', '--output', 'json'], h.io), 2);
    const report = JSON.parse(h.stdout());
    assert.equal(report.status, 'timeout');
    assert.ok(report.durationMs < 30000);
  } finally {await rm(dir, {recursive: true, force: true});}
});

test('SIGINT cancels, settles and exits 2 with status cancelled', {timeout: 60000}, async () => {
  const dir = await root();
  try {
    let started!: () => void; const running = new Promise<void>(resolve => {started = resolve;});
    const h = harness(dir, {async respond(_request, _delta, signal) {
      started();
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), {once: true}));
      signal.throwIfAborted();
      return reply('never');
    }});
    const done = runHeadless(['-p', 'take forever', '--output', 'json'], h.io);
    await running; h.signals.emit('SIGINT');
    assert.equal(await done, 2);
    assert.equal(JSON.parse(h.stdout()).status, 'cancelled');
  } finally {await rm(dir, {recursive: true, force: true});}
});

test('the task can come from stdin or from a file; --verbose writes progress to stderr only', {timeout: 60000}, async () => {
  const dir = await root();
  try {
    const seen: string[] = [];
    const provider: Provider = {async respond(request) {seen.push(firstUser(request)); return reply('Got it.');}};
    const piped = harness(dir, provider, {stdin: async () => 'task from stdin\n'});
    assert.equal(await runHeadless(['-p', '-', '--verbose'], piped.io), 0);
    assert.equal(piped.stdout(), 'Got it.\n');
    assert.match(piped.stderr(), /\[00:0\d\] Logox · .* · (queued|running|completed)/, piped.stderr());
    await writeFile(join(dir, 'task.md'), 'task from a file');
    const filed = harness(dir, provider);
    assert.equal(await runHeadless(['--task-file', join(dir, 'task.md')], filed.io), 0);
    assert.ok(seen.some(text => text.includes('task from stdin')) && seen.some(text => text.includes('task from a file')), JSON.stringify(seen));
  } finally {await rm(dir, {recursive: true, force: true});}
});

test('setup errors exit 3: no model, bad flags, unreadable task file, empty task', {timeout: 60000}, async () => {
  const dir = await root('');
  try {
    const noModel = harness(dir, undefined);
    assert.equal(await runHeadless(['-p', 'anything'], noModel.io), 3);
    assert.equal(noModel.stderr().trim(), HEADLESS_NO_MODEL); assert.equal(noModel.stdout(), '');
    const provider: Provider = {respond: async () => reply('x')};
    for (const argv of [['-p', 'x', '--output', 'xml'], ['-p', 'x', '--timeout', 'soon'], ['-p', 'x', '--permission-mode', 'wild'], ['-p', 'x', '--task-file', 'y'], ['-p', 'x', '--nope'],
      ['--task-file', join(dir, 'missing.md')], ['-p', '  ']]) {
      const h = harness(dir, provider);
      assert.equal(await runHeadless(argv, h.io), 3, argv.join(' '));
      assert.equal(h.stdout(), '');
    }
  } finally {await rm(dir, {recursive: true, force: true});}
});

test('argument detection and help text', () => {
  assert.equal(isHeadlessArgv(['-p', 'x']), true); assert.equal(isHeadlessArgv(['--print=x']), true); assert.equal(isHeadlessArgv(['--task-file', 'a']), true);
  assert.equal(isHeadlessArgv(['--resume']), false); assert.equal(isHeadlessArgv(['-p', 'x', '--help']), false);
  assert.match(HEADLESS_HELP, /--timeout <minutes>/);
});

test('node dist/src/cli.js -p runs end to end against a local OpenAI-compatible endpoint', {timeout: 90000}, async () => {
  const dir = await root();
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, {'content-type': 'text/event-stream'});
      response.end('data: ' + JSON.stringify({choices: [{index: 0, delta: {content: 'Smoke reply.'}, finish_reason: 'stop'}]}) + '\n\n' +
        'data: ' + JSON.stringify({choices: [], usage: {prompt_tokens: 12, completion_tokens: 3}}) + '\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await seedActorProfiles(dir);
    const port = (server.address() as {port: number}).port;
    await writeFile(join(dir, '.logox', 'config.toml'), `[provider]\nname = "local"\nmodel = "fixture"\ncontext_window = 131072\n\n[providers.local]\nbase_url = "http://127.0.0.1:${port}/v1"\n\n[kernel]\nmax_retries = 0\n`);
    const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
    const result = await new Promise<{code: number | null; out: string; err: string}>(resolve => {
      const child = spawn(process.execPath, [cli, '-p', 'say hi', '--output', 'json'], {cwd: dir, env: {...process.env, HOME: dir, USERPROFILE: dir}});
      let out = '', err = '';
      child.stdout.on('data', chunk => {out += chunk;}); child.stderr.on('data', chunk => {err += chunk;});
      child.on('close', code => resolve({code, out, err}));
    });
    assert.equal(result.code, 0, result.err + result.out);
    const report = JSON.parse(result.out);
    assert.equal(report.status, 'completed'); assert.equal(report.final, 'Smoke reply.');
  } finally {server.closeAllConnections(); server.close(); await rm(dir, {recursive: true, force: true});}
});
