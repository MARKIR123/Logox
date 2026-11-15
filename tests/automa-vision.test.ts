import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {automaSchema, normalizeAutomaInput, type AutomaProvider} from '../src/tools/orchestration/AutomaTool/AutomaTool.js';
import {AUTOMA_DESCRIPTION} from '../src/tools/orchestration/AutomaTool/prompt.js';
import type {AutomaProfile} from '../src/tools/orchestration/AutomaTool/preset.js';
import {PermissionEngine} from '../src/permissions/engine.js';
import {Tools, type AutomaEnvironment} from '../src/tools/index.js';
import type {ActorContext} from '../src/actors/ensemble.js';
import type {ModelMessage} from '../src/runtime/messages.js';
import {loadConfig} from '../src/config/config.js';
import {createTestApplication as createApplication} from './runtime-fixture.js';
import type {ModelRequest, ModelTurn, Provider} from '../src/runtime/messages.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const profile: AutomaProfile = {name: 'work crew', default_style: 'scout', styles: {scout: {}}};
const principal = (): ActorContext => ({sessionId: 's', activityId: 'act', ownerId: 'techne', history: [], signal: new AbortController().signal,
  report() {}, say() {}, async record() {}, async ask() {return {status: 'cancelled', reason: 'Unused'};}, async permission() {throw new Error('Unexpected approval');}});
const dispatch = (args: unknown) => ({id: 'dispatch', name: 'Automa', arguments: JSON.stringify(args)});

/** A worker that reads shot.png on its first turn, then reports; every request is kept. */
function reader(requests: {messages: readonly ModelMessage[]}[]): AutomaProvider {
  return {async respond(request) {
    requests.push({messages: [...request.messages]});
    return request.messages.some(message => message.role === 'tool')
      ? {message: {role: 'assistant', text: '', toolCalls: [{id: 'fin', name: 'Finish', arguments: JSON.stringify({status: 'done', summary: 'saw it', evidence: ['shot.png']})}]}, stop: 'tools', usage: {input: 10, output: 5}}
      : {message: {role: 'assistant', text: '', toolCalls: [{id: 'c1', name: 'Read', arguments: JSON.stringify({file_path: 'shot.png'})}]}, stop: 'tools', usage: {input: 10, output: 5}};
  }};
}
async function project() {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-automa-vision-'));
  await writeFile(join(cwd, 'shot.png'), PNG);
  const tools = new Tools(cwd, undefined, new PermissionEngine(cwd, 'creative'));
  return {tools, done: () => rm(cwd, {recursive: true, force: true})};
}
const toolMessage = (requests: readonly {messages: readonly ModelMessage[]}[]) => requests.at(-1)!.messages.find(message => message.role === 'tool');

test('the vision field is optional, kept only when true, and described in the tool description', () => {
  assert.equal(automaSchema.safeParse({jobs: [{brief: 'x', scope: 'exact', vision: true}]}).success, true);
  assert.equal(automaSchema.safeParse({jobs: [{brief: 'x', scope: 'exact'}]}).success, true);
  assert.ok(AUTOMA_DESCRIPTION.includes('`vision: true` when the job must look at images (screenshots, mockups, image files); the job then runs on a model that can see images.'));
  const jobs = (normalizeAutomaInput({jobs: [{brief: 'a', vision: 'true'}, {brief: 'b', vision: false}, {brief: 'c', vision: 'n/a'}]}) as {jobs: {vision?: boolean}[]}).jobs;
  assert.deepEqual(jobs.map(job => job.vision), [true, undefined, undefined]);
});

test('a worker on a model that cannot see images gets the placeholder and a Not verified line', async () => {
  const {tools, done} = await project();
  try {
    const requests: {messages: readonly ModelMessage[]}[] = [];
    tools.setAutomaEnvironment({resolveModel: () => ({provider: reader(requests), model: 'p/blind', vision: false}), profile: () => profile});
    const result = await tools.execute(dispatch({jobs: [{brief: 'Inspect shot.png'}]}), principal());
    assert.equal(result.isError, false, result.text);
    const tool = toolMessage(requests);
    assert.equal(tool?.role === 'tool' && tool.images, undefined);
    assert.match(tool!.text, /\[Image omitted: p\/blind cannot see images\.\] The dispatcher should resend the job with vision: true\./);
    assert.match(result.text, /^Not verified:\n- Images were omitted: p\/blind cannot see images\./m);
    assert.match(result.text, /model="p\/blind"/);
  } finally {await done();}
});

test('a worker on a model that can see images receives the image', async () => {
  const {tools, done} = await project();
  try {
    const requests: {messages: readonly ModelMessage[]}[] = [];
    tools.setAutomaEnvironment({resolveModel: () => ({provider: reader(requests), model: 'p/eyes', vision: true}), profile: () => profile});
    const result = await tools.execute(dispatch({jobs: [{brief: 'Inspect shot.png', vision: true}]}), principal());
    assert.equal(result.isError, false, result.text);
    const tool = toolMessage(requests);
    assert.ok(tool?.role === 'tool' && tool.images?.length === 1 && tool.images[0]!.mimeType === 'image/png');
    assert.doesNotMatch(tool!.text, /Image omitted/);
    assert.doesNotMatch(result.text, /Images were omitted/);
  } finally {await done();}
});

test('a vision job is refused alone when no model can see images; the other jobs still run, and the dispatcher flag reaches resolveModel', async () => {
  const {tools, done} = await project();
  try {
    const requests: {messages: readonly ModelMessage[]}[] = [], asked: (boolean | undefined)[] = [];
    const environment: AutomaEnvironment = {resolveModel: (_preferred, vision) => {asked.push(vision); return {provider: reader(requests), model: 'p/blind', vision: false};}, profile: () => profile};
    tools.setAutomaEnvironment(environment);
    const result = await tools.execute(dispatch({jobs: [{brief: 'Compare the mockup', title: 'Mockup', vision: true}, {brief: 'Inspect shot.png', title: 'Plain'}]}), principal());
    assert.match(result.text, /Job "Mockup" needs a model that can see images\. Choose a vision fallback under \/model automa\./);
    assert.match(result.text, /title="Mockup" status="denied"/);
    assert.match(result.text, /title="Plain" status="done"/);
    assert.deepEqual(asked.sort(), [undefined, true].sort(), 'only the vision job asks for a model that can see');
    assert.equal(requests.length, 2, 'the refused job never reached a model; the other job took two turns');
  } finally {await done();}
});

test('an actor on a model that cannot see images gets the placeholder instead of the image; one that can gets the image', async () => {
  for (const blind of [true, false]) {
    const cwd = await mkdtemp(join(tmpdir(), 'logox-actor-vision-'));
    try {
      await writeFile(join(cwd, 'shot.png'), PNG);
      const requests: ModelRequest[] = [];
      const turns: ModelTurn[] = [
        {stop: 'tools', message: {role: 'assistant', text: '', toolCalls: [{id: 'c1', name: 'Read', arguments: JSON.stringify({file_path: 'shot.png'})}]}},
        {stop: 'complete', message: {role: 'assistant', text: 'done'}},
      ];
      const provider: Provider = {async respond(request) {requests.push(structuredClone(request)); const turn = turns.shift(); assert.ok(turn); return structuredClone(turn);}};
      const config = await loadConfig(cwd, {permissions: {mode: 'creative'}, provider: {model: 'test', context_window: 131072}}, {}, cwd, cwd);
      const app = await createApplication({cwd, sessionId: 'vision', config, provider, resourceOptions: {home: cwd, boundary: cwd}});
      try {
        if (blind) await app.tools.marks.setVision(app.status('logox').model!.provider, 'test', false);
        await app.ensemble.dispatch('logox', 'look at shot.png').done;
        const tool = requests[1]!.messages.find(message => message.role === 'tool');
        assert.ok(tool?.role === 'tool');
        if (blind) {
          assert.equal(tool.images, undefined);
          assert.match(tool.text, /\[Image omitted: .*\/test cannot see images\.\] Ask the user to choose a model that can see images for this actor\./);
          assert.equal(requests[1]!.supportsVision, false);
        } else {
          assert.equal(tool.images?.length, 1);
          assert.doesNotMatch(tool.text, /Image omitted/);
        }
      } finally {await app.close();}
    } finally {await rm(cwd, {recursive: true, force: true});}
  }
});
