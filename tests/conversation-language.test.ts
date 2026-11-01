import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {detectConversationLanguage, sessionLanguage} from '../src/context/language.js';
import {EnvironmentState, formatEnvironment} from '../src/context/environment.js';
import {createApplication} from '../src/application.js';
import {loadConfig} from '../src/config/config.js';
import type {ModelRequest, Provider} from '../src/runtime/messages.js';

test('detection classifies by script and ignores code, paths and URLs', () => {
  assert.equal(detectConversationLanguage('请帮我修复这个登录页面的问题'), 'Chinese');
  assert.equal(detectConversationLanguage('帮我 fix the login page bug in the component 好吗'), 'Chinese');
  assert.equal(detectConversationLanguage('ログインページのバグを直してください'), 'Japanese');
  assert.equal(detectConversationLanguage('로그인 페이지 버그를 고쳐 주세요'), 'Korean');
  assert.equal(detectConversationLanguage('Please fix the login page bug'), 'English');
  assert.equal(detectConversationLanguage('```ts\nconst 变量 = "中文字符串";\n```'), undefined);
  assert.equal(detectConversationLanguage('看 `中文变量` 和 https://例子.com/中文 src/中文/a.ts'), undefined);
  assert.equal(detectConversationLanguage('ok'), undefined);
  assert.equal(detectConversationLanguage('👍👍'), undefined);
  assert.equal(sessionLanguage(['修复这个问题吧', 'src/a.ts', '👍']), 'Chinese');
  assert.equal(sessionLanguage(['修复这个问题吧', 'Now please explain it']), 'English');
});

const environment = {model: 'p/m', effort: 'medium', permission: 'default', directory: '/w', scratchpad: '/s', rules: 'r', services: []};

test('a language change is emitted as an environment delta', () => {
  const state = new EnvironmentState();
  const first = state.plan({...environment, language: 'Chinese'}, []);
  assert.match(first.updates[0]!.text, /Conversation language: Chinese \(reply, brief teammates and hand off in this language\)/);
  const history = first.updates;
  assert.equal(state.plan({...environment, language: 'Chinese'}, history).updates.length, 0);
  const change = state.plan({...environment, language: 'English'}, history).updates;
  assert.equal(change.length, 1);
  assert.equal(change[0]!.kind, 'environment-change');
  assert.equal(change[0]!.text.split('\n').length, 1);
  assert.ok(!formatEnvironment(environment).includes('Conversation language'));
});

test('human input drives the language for Director and actor requests; tool output does not', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'logox-language-'));
  const requests: ModelRequest[] = [];
  const provider: Provider = {async respond(request) {
    requests.push(structuredClone(request));
    return {stop: 'tools', message: {role: 'assistant', text: 'Done.', toolCalls: [{id: 'done' + requests.length, name: '_FinishRound',
      arguments: JSON.stringify({title: 'Done', verification: null, carry_forward: []})}]}};
  }};
  const config = await loadConfig(cwd, {provider: {model: 'fixture', context_window: 131072}}, {}, cwd, cwd);
  const app = await createApplication({cwd, sessionId: 's', config, provider, env: {}, authPath: join(cwd, 'auth.json'), resourceOptions: {home: cwd, boundary: cwd}});
  const contextText = (request: ModelRequest) => request.messages.flatMap(message => message.role === 'context' ? [message.text] : []).join('\n');
  try {
    await app.ensemble.dispatch('logox', '请解释一下这个项目的结构', 'direct', {inputKind: 'human'}).done;
    assert.match(contextText(requests[0]!), /Conversation language: Chinese/);
    app.store.message('s', 'logox', 'user', 'The build output says: error TS2304 cannot find name foo in module', {inputKind: 'actor'});
    app.store.message('s', 'logox', 'assistant', 'Plain English tool result and peer report text', {});
    await app.ensemble.dispatch('techne', 'Please investigate the build failure in detail', 'logox', {inputKind: 'director'}).done;
    const actorRequest = requests.at(-1)!;
    assert.match(contextText(actorRequest), /Conversation language: Chinese/);
    assert.match(actorRequest.system, /Conversation language: Chinese/);
    await app.ensemble.dispatch('logox', 'Now please explain it in English', 'direct', {inputKind: 'human'}).done;
    assert.match(contextText(requests.at(-1)!), /Conversation language: English/);
  } finally {await app.close(); await rm(cwd, {recursive: true, force: true});}
});
