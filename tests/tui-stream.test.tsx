import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough, Writable} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {render} from 'ink';
import {App} from '../src/tui/app.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {buildStageRows} from '../src/tui/stage.js';

class Input extends PassThrough {
  isTTY = true;
  setRawMode(): this {return this;}
  ref(): this {return this;}
  unref(): this {return this;}
}
class Output extends Writable {
  isTTY = true;
  columns = 80;
  rows = 24;
  text = '';
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void): void {this.text += chunk.toString(); done();}
}

test('正式全屏连续回复：不用 act，同批分片不触发布局更新循环，可继续发送和缩放', {timeout: 12000}, async () => {
  const input = new Input(), output = new Output(), store = new RuntimeStore();
  store.message('s', 'logox', 'user', '恢复的合成历史');
  store.message('s', 'logox', 'assistant', '之前的回复');
  const errors: string[] = [], originalError = console.error;
  console.error = (...args: unknown[]) => {errors.push(args.map(String).join(' '));};
  const submissions: string[] = [];
  // 有意不使用 act：正式 CLI 的布局通知和分片在普通事件循环中交错执行。
  const instance = render(<App stage sessionId="s" store={store} onCancel={() => {}} onClose={async () => {}}
    onSubmit={async text => {
      submissions.push(text);
      store.message('s', 'logox', 'user', text);
      const thinking = store.message('s', 'logox', 'assistant', '', {kind: 'thinking'});
      const reply = store.message('s', 'logox', 'assistant', '');
      for (let i = 0; i < 80; i++) {
        store.appendMessage(i < 10 ? thinking : reply, i < 10 ? '思考。' : '回复。');
        await Promise.resolve();
      }
      store.appendMessage(reply, '完整回复已结束。');
    }}/>, {stdout: output, stdin: input, stderr: output, interactive: true, alternateScreen: true,
    incrementalRendering: true, maxFps: 30, patchConsole: false, exitOnCtrlC: false});
  try {
    await delay(60);
    for (const text of ['你好', '再问一次']) {
      input.write(text); await delay(35); input.write('\r'); await delay(250);
      await instance.waitUntilRenderFlush();
      assert.equal(errors.filter(error => error.includes('Maximum update depth exceeded')).length, 0, errors.join('\n'));
      assert.ok(store.getSnapshot().messages.at(-1)?.text.endsWith('完整回复已结束。'), '完整分片回复保留');
      assert.ok(output.text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\s▎]/g, '').includes('已结束。'), '最后一段回复可见');
    }
    output.columns = 32; output.rows = 12; output.emit('resize');
    await delay(60); await instance.waitUntilRenderFlush();
    assert.deepEqual(submissions, ['你好', '再问一次']);
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally {
    instance.unmount(); await instance.waitUntilExit(); console.error = originalError;
    input.destroy(); output.destroy();
  }
});

test('正式 Ink 阅读：同批滚轮累加，阅读期间流式追加保留位置，滚到底恢复跟随', {timeout: 12000}, async () => {
  const input = new Input(), output = new Output(), store = new RuntimeStore();
  output.rows = 18;
  const id = store.message('s', 'logox', 'assistant', Array.from({length: 200}, (_, i) => 'ROW-' + String(i).padStart(3, '0')).join('\n'));
  const instance = render(<App stage sessionId="s" store={store} onCancel={() => {}} onClose={async () => {}} onSubmit={async () => {}}/>,
    {stdout: output, stdin: input, stderr: output, interactive: true, alternateScreen: true, incrementalRendering: false,
      maxFps: 60, patchConsole: false, exitOnCtrlC: false});
  const frame = async (action: () => void) => {
    output.text = ''; action(); await delay(80); await instance.waitUntilRenderFlush();
    return output.text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  };
  try {
    await delay(80); await instance.waitUntilRenderFlush();
    const total = buildStageRows(store.getSnapshot(), 's', 'logox', 79, {}, null).length;
    // Status always uses one row, leaving 14 history rows in this terminal.
    const start = total - 14 - 6;
    const expected = buildStageRows(store.getSnapshot(), 's', 'logox', 79, {}, null)[start]!.text;
    const wheel = await frame(() => input.write('\x1b[<64;5;5M\x1b[<64;5;5M'));
    assert.ok(wheel.includes(expected), '同一输入批次的两次滚轮各移动三行');
    const append = await frame(() => store.appendMessage(id, '\nTAIL-STREAM'));
    assert.ok(append.includes(expected), '追加后保留阅读位置');
    assert.ok(!append.includes('TAIL-STREAM'), '阅读期间不抢回底部');
    const down = await frame(() => input.write('\x1b[<65;5;5M'.repeat(20)));
    assert.ok(down.includes('TAIL-STREAM'), '滚轮回到底部');
    const following = await frame(() => store.appendMessage(id, '\nTAIL-FOLLOW'));
    assert.ok(following.includes('TAIL-FOLLOW'), '到底后新分片自动跟随');
    const page = await frame(() => input.write('\x1b[5~'));
    assert.ok(!page.includes('TAIL-FOLLOW'), 'PageUp 浏览历史');
    const end = await frame(() => input.write('\x05'));
    assert.ok(end.includes('TAIL-FOLLOW'), 'Ctrl+E 回到底部');
  } finally {
    instance.unmount(); await instance.waitUntilExit(); input.destroy(); output.destroy();
  }
});
