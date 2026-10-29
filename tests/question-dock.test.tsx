import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {act} from 'react';
import {TerminalScreen} from './terminal-screen.js';
import {renderTerminal as render} from '../src/tui/terminal/terminal.js';
import {App} from '../src/tui/app.js';
import {RuntimeStore} from '../src/runtime/store.js';
Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
class TerminalInput extends PassThrough {
  isTTY = true; setRawMode(): this {return this;} ref(): this {return this;} unref(): this {return this;}
}
class TerminalOutput extends TerminalScreen {}

test('没有活动锚点的提问渲染在底部停靠区，而不是时间线里', async () => {
  const store = new RuntimeStore();
  const sessionId = 'dock-probe';
  const ticket = store.interactions.open({
    sessionId, activityId: 'login-probe', ownerId: 'logox', kind: 'question', title: 'Login',
    questions: [{
      id: 'provider', header: 'Provider', question: 'Which provider?', hideCustomInput: true,
      options: [{id: 'a', label: 'Account login', description: 'browser'}, {id: 'b', label: 'Custom URL', description: 'endpoint'}],
    }],
  });
  const input = new TerminalInput(), output = new TerminalOutput();
  let instance!: ReturnType<typeof render>;
  await act(async () => {
    instance = render(<App stage sessionId={sessionId} store={store}
      onSubmit={async () => {}} onCancel={() => {}} onClose={async () => {store.interactions.close();}}/>,
    {stdout: output, stdin: input, stderr: output, interactive: true, alternateScreen: true, patchConsole: false, exitOnCtrlC: false, maxFps: 100});
  });
  try {
    await instance.waitUntilRenderFlush();
    const screen = output.lines.join('\n');
    assert.equal(store.getSnapshot().activities.length, 0, '没有任何活动，提问仍然可见');
    assert.ok(screen.includes('Which provider?'), '问题正文出现在底部停靠区');
    assert.ok(screen.includes('Account login'), '选项可见');
    assert.ok(screen.includes('Login'), '标题带出来源');
    assert.equal(screen.split('Which provider?').length - 1, 1, '同一提问只渲染一次，不重复内联');
    // Tab 能把焦点切到停靠的提问，说明它和普通提问共用同一套焦点与回答路径。
    await act(async () => {input.write('\t');}); await instance.waitUntilRenderFlush();
    assert.ok(output.lines.join('\n').includes('Which provider?'));
    await act(async () => {input.write('\r');});
    const outcome = await ticket.result;
    assert.equal(outcome.status, 'answered');
  } finally {
    await act(async () => {instance.unmount();});
    await instance.waitUntilExit(); input.destroy(); output.destroy(); store.interactions.close();
  }
});
