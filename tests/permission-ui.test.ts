import test from 'node:test';
import assert from 'node:assert/strict';
import {RuntimeStore} from '../src/runtime/store.js';
import {answerEnvelope} from '../src/runtime/interactions.js';
import {buildStageRows} from '../src/tui/timeline/stage.js';
import {approvalModel, approvalTarget, optionIndex} from '../src/tui/interactions/approval-view.js';
import {initialPermissionsUi, permissionsView, reducePermissions, selectedRule, type PermissionsUi} from '../src/tui/panels/permissions-editor.js';
import type {PermissionsPageData} from '../src/runtime/command-surface.js';
import type {Interaction} from '../src/runtime/contracts.js';

const base = {sessionId: 's', activityId: 'a', ownerId: 'techne', title: 'Allow shell?', reason: 'deletes files outside the scratchpad', mode: 'auto'} as const;
function open(store: RuntimeStore, extra: Record<string, unknown>) {
  const ticket = store.interactions.open({kind: 'permission', ...base, tool: 'shell', arguments: {command: 'npm ci --ignore-scripts'}, ...extra});
  return {ticket, request: store.interactions.list().find(item => item.requestId === ticket.requestId)! as Extract<Interaction, {kind: 'permission'}>};
}
const suggestion = {tool: 'shell', pattern: 'npm ci', label: 'npm ci *'};
const flat = (rows: readonly (readonly {text: string}[])[]) => rows.map(row => row.map(cell => cell.text).join('')).join('\n');

test('审批卡视图：Shell 显示 $ 命令，其他工具显示紧凑目标而不是原始 JSON，选项随建议出现', () => {
  const store = new RuntimeStore();
  const {request} = open(store, {suggestion});
  const model = approvalModel(request, 'Techne');
  assert.deepEqual(model.target, {kind: 'shell', text: 'npm ci --ignore-scripts'});
  assert.deepEqual(model.options.map(option => [option.id, option.key]), [['allow_once', 'y'], ['allow_session', 's'], ['allow_project', 'a'], ['deny', 'n']]);
  assert.equal(model.options[3]!.suffix, 'and tell Techne why…');
  assert.equal(optionIndex(model, 'a'), 2);
  assert.equal(approvalModel(open(store, {}).request, 'Techne').options.length, 2, '没有建议时只有一次允许和拒绝');
  assert.deepEqual(approvalTarget('write', {file_path: 'src/a.ts', content: 'x'.repeat(5000)}), {kind: 'target', text: 'src/a.ts'});
  assert.equal(approvalTarget('web_fetch', {url: 'https://example.com/x'}).text, 'https://example.com/x');
  const summary = approvalTarget('mcp:playwright:browser_click', {element: 'Save', ref: 'e3', nested: {a: 1}}).text;
  assert.equal(summary, 'element: Save · ref: e3'); assert.ok(!summary.includes('{'));
  store.interactions.close();
});

test('时间线审批卡：标题、$ 命令、风险行与四个选项，点击动作带选项序号', () => {
  const store = new RuntimeStore();
  const {request} = open(store, {suggestion});
  const draft = {questionIndex: 0, selected: 1, text: '', error: ''};
  const rows = buildStageRows(store.getSnapshot(), 's', 'logox', 100, {[request.requestId]: true}, null, {[request.requestId]: draft});
  const text = rows.map(row => row.text).join('\n');
  assert.match(text, /wants to run · Shell/); assert.match(text, /Awaiting approval/);
  assert.match(text, /\$ npm ci --ignore-scripts/); assert.match(text, /▲ deletes files outside the scratchpad\s+·\s+mode auto/);
  assert.match(text, /Allow once\s+y/); assert.match(text, /Allow npm ci \* for this session\s+s/); assert.match(text, /Always allow npm ci \* in this project\s+a/);
  assert.match(text, /❯ Allow npm ci \* for this session/); assert.match(text, /Deny and tell Techne why…\s+n/);
  assert.ok(!text.includes('"command"'), '不显示原始 JSON');
  const values = rows.flatMap(row => row.action?.kind === 'select_answer' ? [row.action.value] : []);
  assert.deepEqual([...new Set(values)], ['0', '1', '2', '3']);
  const noting = buildStageRows(store.getSnapshot(), 's', 'logox', 100, {[request.requestId]: true}, null, {[request.requestId]: {...draft, selected: 3, text: '先测试', noting: true}})
    .map(row => row.text).join('\n');
  assert.match(noting, /Tell Techne why › 先测试/);
  store.interactions.close();
});

test('审批响应模式：会话与项目授权需要建议，说明只属于拒绝，拒绝说明回到等待方', async () => {
  const store = new RuntimeStore();
  const plain = open(store, {});
  assert.equal(store.interactions.respond(answerEnvelope(plain.request, {kind: 'permission', decision: 'allow_session'})).ok, false);
  assert.equal(store.interactions.respond(answerEnvelope(plain.request, {kind: 'permission', decision: 'allow_once', note: 'x'})).ok, false);
  assert.equal(store.interactions.respond(answerEnvelope(plain.request, {kind: 'permission', decision: 'deny', note: '先备份'})).ok, true);
  const outcome = await plain.ticket.result;
  assert.ok(outcome.status === 'answered' && outcome.response.kind === 'permission' && outcome.response.note === '先备份' && outcome.response.decision === 'deny');
  const withRule = open(store, {suggestion});
  assert.equal(store.interactions.respond(answerEnvelope(withRule.request, {kind: 'permission', decision: 'allow_project'})).ok, true);
  store.interactions.close();
});

const data = (over: Partial<PermissionsPageData> = {}): PermissionsPageData => ({
  mode: {current: 'auto', options: [{id: 'default', description: 'asks'}, {id: 'auto', description: 'reviews'}, {id: 'creative', description: 'free'}]},
  rules: [
    {id: 'u1', scope: 'user', decision: 'ask', tool: 'shell', pattern: 'git push', hits: 2, lastHit: Date.now() - 120_000},
    {id: 'p1', scope: 'project', decision: 'allow', tool: 'shell', pattern: 'npm test', hits: 0},
    {id: 'p2', scope: 'project', decision: 'deny', tool: 'write', pattern: '.env*', hits: 5, lastHit: Date.now()},
  ], stats: {approvals: 12, asked: 3, reviewed: 9, tokens: 1800}, userScope: true, ...over});
const press = (page: PermissionsPageData, ui: PermissionsUi, input: string, key: Record<string, boolean> = {}) => reducePermissions(page, ui, input, key);
const typeText = (page: PermissionsPageData, ui: PermissionsUi, text: string) => [...text].reduce((state, ch) => press(page, state, ch).ui, ui);

test('/permissions 页：模式草稿标 unsaved，Enter 才保存；说明随选中模式变化；统计行与分组', () => {
  const page = data();
  let step = press(page, initialPermissionsUi, '', {rightArrow: true});
  assert.equal(step.ui.draftMode, 'creative'); assert.equal(step.action, undefined);
  let text = flat(permissionsView(page, step.ui, 100).rows);
  assert.match(text, /creative\s+unsaved/); assert.match(text, /free/);
  step = press(page, step.ui, '', {return: true});
  assert.equal(step.action, 'set_mode:creative');
  assert.equal(press(page, step.ui, '', {leftArrow: true}).ui.draftMode, undefined, '回到当前模式即不再是草稿');
  text = flat(permissionsView(page, initialPermissionsUi, 100).rows);
  assert.match(text, /Rules\s+·\s+3/); assert.match(text, /user\n.*ask\s+shell\s+git push\s+2 hits · 2m ago/); assert.match(text, /project\n/);
  assert.match(text, /no hits/); assert.match(text, /This run\s+·\s+12 approvals\s+·\s+3 asked you\s+·\s+9 by review model\s+·\s+1\.8k tokens/);
  assert.equal(press(page, initialPermissionsUi, '', {return: true}).action, undefined, '没有草稿时 Enter 不保存');
});

test('/permissions 页：删除需要内联确认，y 才执行，其他键取消', () => {
  const page = data();
  const down = press(page, initialPermissionsUi, '', {downArrow: true}).ui;
  assert.equal(selectedRule(page, down)!.id, 'p1');
  const asked = press(page, down, 'd').ui;
  assert.equal(asked.confirmDelete, 'p1');
  assert.match(flat(permissionsView(page, asked, 100).rows), /Delete this rule\? y \/ n/);
  assert.equal(press(page, asked, 'x').action, undefined); assert.equal(press(page, asked, 'x').ui.confirmDelete, undefined);
  assert.equal(press(page, asked, 'y').action, 'delete_rule:p1');
  assert.equal(press(page, down, '', {delete: true}).ui.confirmDelete, 'p1', 'Del 键同样触发');
  assert.equal(press(data({rules: []}), initialPermissionsUi, 'd').ui.confirmDelete, undefined);
});

test('/permissions 页：新增规则表单校验字段并产出 add_rule 动作', () => {
  const page = data();
  let ui = press(page, initialPermissionsUi, 'a').ui;
  assert.ok(ui.form);
  let step = press(page, ui, '', {return: true});
  assert.match(step.ui.form!.error, /Tool is required/); assert.equal(step.action, undefined);
  ui = press(page, step.ui, '', {rightArrow: true}).ui; assert.equal(ui.form!.decision, 1, '←→ 切换决定');
  ui = press(page, ui, '', {tab: true}).ui; ui = typeText(page, ui, 'Shell');
  ui = press(page, ui, '', {tab: true}).ui; ui = typeText(page, ui, 'npm run && x');
  step = press(page, ui, '', {return: true});
  assert.match(step.ui.form!.error, /static token prefixes/);
  ui = step.ui;
  for (let i = 0; i < 5; i++) ui = press(page, ui, '', {backspace: true}).ui;
  ui = typeText(page, ui, ' build'); ui = press(page, ui, '', {tab: true}).ui; ui = press(page, ui, '', {rightArrow: true}).ui;
  step = press(page, ui, '', {return: true});
  assert.equal(step.action, 'add_rule:' + JSON.stringify({scope: 'user', decision: 'ask', tool: 'shell', pattern: 'npm run build'}));
  assert.equal(step.ui.form, undefined);
  assert.equal(press(page, press(page, initialPermissionsUi, 'a').ui, '', {escape: true}).ui.form, undefined);
});
