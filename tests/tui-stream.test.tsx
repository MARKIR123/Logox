import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough, Writable} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {render} from 'ink';
import {App} from '../src/tui/app.js';
import {RuntimeStore} from '../src/runtime/store.js';

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
