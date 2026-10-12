import test from 'node:test';
import assert from 'node:assert/strict';
import {RuntimeStore} from '../src/runtime/store.js';
import {answerEnvelope} from '../src/runtime/interactions.js';
import type {InteractionInput} from '../src/runtime/contracts.js';

function question(ownerId = 'kalon'): InteractionInput {
  return {kind: 'question', sessionId: 's', activityId: ownerId + '-task', ownerId, title: '方向',
    questions: [{id: 'choice', header: '选择', question: '做什么？', options: [
      {id: 'a', label: '界面', description: '打磨舞台'}, {id: 'b', label: '内核', description: '完善循环'},
    ]}, {id: 'notes', header: '补充', question: '补充要求？'}]};
}
test('不同角色异步提问可独立回答，并保留另一请求等待', async () => {
  const store = new RuntimeStore();
  const first = store.interactions.open(question());
  const second = store.interactions.open(question('techne'));
  const request = store.interactions.list()[1]!;
  const result = store.interactions.respond(answerEnvelope(request, {kind: 'question', answers: {
    choice: {type: 'option', optionId: 'a'}, notes: {type: 'text', text: '中文自由回答'},
  }}));
  assert.equal(result.ok, true);
  assert.equal((await second.result).status, 'answered');
  assert.equal(store.interactions.list()[0]!.status, 'pending');
  store.interactions.cancel(first.requestId);
  assert.equal((await first.result).status, 'cancelled');
});
test('身份不匹配、漏题与无效选项均不解除等待', async () => {
  const store = new RuntimeStore();
  const ticket = store.interactions.open(question());
  const request = store.interactions.list()[0]!;
  const valid = answerEnvelope(request, {kind: 'question', answers: {
    choice: {type: 'option', optionId: 'a'}, notes: {type: 'text', text: '要求'},
  }});
  assert.equal(store.interactions.respond({...valid, sessionId: 'wrong'}).ok, false);
  assert.equal(store.interactions.respond({...valid, ownerId: 'techne'}).ok, false);
  assert.equal(store.interactions.respond({...valid, answers: {choice: {type: 'option', optionId: 'a'}}}).ok, false);
  assert.equal(store.interactions.respond({...valid, answers: {
    choice: {type: 'option', optionId: 'missing'}, notes: {type: 'text', text: '要求'},
  }}).ok, false);
  assert.equal(store.interactions.list()[0]!.status, 'pending');
  assert.equal(store.interactions.respond(valid).ok, true);
  await ticket.result;
  assert.equal(store.interactions.respond(valid).ok, false);
});
test('活动取消只解除所属请求；关闭解除全部等待', async () => {
  const store = new RuntimeStore();
  const a = store.interactions.open(question());
  const b = store.interactions.open(question('techne'));
  store.interactions.cancelActivity('s', 'kalon-task');
  assert.equal((await a.result).status, 'cancelled');
  assert.equal(store.interactions.list()[1]!.status, 'pending');
  store.interactions.close();
  assert.equal((await b.result).status, 'cancelled');
  assert.equal((await store.interactions.open(question()).result).status, 'cancelled');
});
test('已中断与等待中断均可完成，权限取消不产生允许回答', async () => {
  const store = new RuntimeStore();
  const before = new AbortController(); before.abort();
  assert.equal((await store.interactions.open(question(), before.signal).result).status, 'cancelled');
  const after = new AbortController();
  const ticket = store.interactions.open({kind: 'permission', sessionId: 's', activityId: 'a', ownerId: 'techne',
    title: '许可', tool: 'write', arguments: {path: 'a.txt'}, reason: '写文件'}, after.signal);
  after.abort();
  assert.equal((await ticket.result).status, 'cancelled');
});
test('重复问题或选项 ID 被拒绝，发布的数据不可被界面修改', () => {
  const store = new RuntimeStore();
  const input = question();
  assert.equal(input.kind, 'question');
  if (input.kind !== 'question') return;
  assert.throws(() => store.interactions.open({...input, questions: [input.questions[0], input.questions[0]]}));
  store.interactions.open(input);
  assert.throws(() => { store.interactions.list()[0]!.title = '篡改'; });
  store.interactions.close();
});
test('同一活动更新不重复生成卡片；终态不能重新运行', () => {
  const store = new RuntimeStore();
  store.activities.create({sessionId: 's', activityId: 'a', ownerId: 'kalon', kind: 'actor', title: 'Kalon',
    status: 'queued', stage: '排队', detail: ''});
  store.activities.update('s', 'a', {status: 'running', stage: '工作'});
  store.activities.update('s', 'a', {status: 'waiting_input'});
  assert.equal(store.getSnapshot().activities.length, 1);
  store.activities.update('s', 'a', {status: 'running'});
  store.activities.update('s', 'a', {status: 'completed'});
  assert.throws(() => store.activities.update('s', 'a', {status: 'running'}));
});
