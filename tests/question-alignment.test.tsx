import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {act} from 'react';
import {TerminalScreen} from './terminal-screen.js';
import {renderTerminal as render} from '../src/tui/terminal/terminal.js';
import {Interactions} from '../src/runtime/interactions.js';
import {interactionInputSchema} from '../src/runtime/contracts.js';
import {QuestionCard} from '../src/tools/AskUserQuestionTool/QuestionCard.js';
import {UI} from '../src/tools/AskUserQuestionTool/UI.js';
Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
class TerminalInput extends PassThrough {
  isTTY = true; setRawMode(): this {return this;} ref(): this {return this;} unref(): this {return this;}
}
class TerminalOutput extends TerminalScreen {}

function questionRequest(extra: Record<string, unknown> = {}) {
  const interactions = new Interactions(() => {});
  interactions.open({
    sessionId: 's', activityId: 'a', ownerId: 'logox', kind: 'question', title: 'Provider',
    questions: [{
      id: 'q', header: 'Key', question: 'Paste the API key', options: [
        {id: 'a', label: 'Alpha', description: 'first'},
        {id: 'b', label: 'Beta', description: 'second'},
      ],
      ...extra,
    }],
  });
  return interactions.list()[0]!;
}

test('提问契约接受 detail / link / secret / hideCustomInput', () => {
  const parsed = interactionInputSchema.parse({
    sessionId: 's', activityId: 'a', ownerId: 'logox', kind: 'question', title: 't',
    questions: [{
      id: 'q', header: 'H', question: 'Q', detail: 'D', link: 'https://example.test', secret: true, hideCustomInput: true,
      options: [{id: 'a', label: 'A', description: ''}, {id: 'b', label: 'B', description: ''}],
    }],
  });
  if (parsed.kind !== 'question') throw new Error('question expected');
  assert.equal(parsed.questions[0]!.secret, true);
  assert.equal(parsed.questions[0]!.hideCustomInput, true);
  assert.equal(parsed.questions[0]!.detail, 'D');
  assert.equal(parsed.questions[0]!.link, 'https://example.test');
  assert.throws(() => interactionInputSchema.parse({
    sessionId: 's', activityId: 'a', ownerId: 'logox', kind: 'question', title: 't',
    questions: [{id: 'q', header: 'H', question: 'Q', options: [{id: 'a', label: 'A', description: ''}], secret: 'yes'}],
  }));
});

test('hideCustomInput：选项是唯一答案来源，自由文本不参与、方向键不越界', () => {
  const request = questionRequest({hideCustomInput: true});
  if (request.kind !== 'question') throw new Error('question expected');
  const draft = {questionIndex: 0, selected: 0, text: '', error: ''};
  const reduce = UI.interaction!.reduce;

  const typed = reduce({request, draft, answers: {}}, {kind: 'text', text: 'ignored'});
  assert.equal(typed.draft?.text ?? draft.text, '', '隐藏自由输入后文本动作被忽略');

  const wrapped = reduce({request, draft: {...draft, selected: 1}, answers: {}}, {kind: 'move', delta: 1});
  assert.equal(wrapped.draft?.selected, 0, '两个选项之间循环');

  const confirmed = reduce({request, draft, answers: {}}, {kind: 'submit'});
  assert.deepEqual(confirmed.answers, {q: {type: 'option', optionId: 'a'}});
  assert.equal(confirmed.complete, true);
});

test('QuestionCard：遮罩答案、渲染 detail 与 link，并隐藏 Custom input 行', async () => {
  const request = questionRequest({secret: true, hideCustomInput: true, detail: 'Stored in ~/.logox/auth.json', link: 'https://platform.openai.test/keys'});
  const input = new TerminalInput(), output = new TerminalOutput();
  let instance!: ReturnType<typeof render>;
  await act(async () => {
    instance = render(<QuestionCard request={request} draft={{questionIndex: 0, selected: 0, text: 'sk-secret-value', error: ''}} focused/>,
      {stdout: output, stdin: input, stderr: output, interactive: true, alternateScreen: true, patchConsole: false, exitOnCtrlC: false, maxFps: 100});
  });
  try {
    await instance.waitUntilRenderFlush();
    const screen = output.lines.join('\n');
    assert.ok(screen.includes('Stored in ~/.logox/auth.json'), 'detail 行可见');
    assert.ok(screen.includes('https://platform.openai.test/keys'), 'link 行可见');
    assert.ok(!screen.includes('Custom input'), 'hideCustomInput 时不渲染自定义行');
    assert.ok(!screen.includes('sk-secret-value'), '密文不得出现在舞台');
  } finally {
    await act(async () => {instance.unmount();});
  }
});

test('QuestionCard：普通问题仍显示 Custom input 与明文草稿', async () => {
  const request = questionRequest();
  const input = new TerminalInput(), output = new TerminalOutput();
  let instance!: ReturnType<typeof render>;
  await act(async () => {
    instance = render(<QuestionCard request={request} draft={{questionIndex: 0, selected: 2, text: 'typed answer', error: ''}} focused/>,
      {stdout: output, stdin: input, stderr: output, interactive: true, alternateScreen: true, patchConsole: false, exitOnCtrlC: false, maxFps: 100});
  });
  try {
    await instance.waitUntilRenderFlush();
    const screen = output.lines.join('\n');
    assert.ok(screen.includes('Custom input'), '默认保留自由输入行');
    assert.ok(screen.includes('typed answer'), '非 secret 显示明文');
  } finally {
    await act(async () => {instance.unmount();});
  }
});

test('默认行为不变：未设置 hideCustomInput 时自由输入仍是第 3 行', () => {
  const request = questionRequest();
  if (request.kind !== 'question') throw new Error('question expected');
  const draft = {questionIndex: 0, selected: 2, text: 'answer text', error: ''};
  const confirmed = UI.interaction!.reduce({request, draft, answers: {}}, {kind: 'submit'});
  assert.deepEqual(confirmed.answers, {q: {type: 'text', text: 'answer text'}});
});
