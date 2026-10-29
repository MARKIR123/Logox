import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {RuntimeStore} from '../src/runtime/store.js';
import {App} from '../src/tui/app.js';
import {renderTerminal} from '../src/tui/terminal/terminal.js';
import {TerminalScreen} from './terminal-screen.js';

class Input extends PassThrough {
  isTTY = true;
  setRawMode() {return this;}
  ref() {return this;}
  unref() {return this;}
}

test('Ink 与历史恢复共用输出事务，每个可见提交都保留历史，异步输出不露出清空中间帧', {timeout: 8000}, async () => {
  for (const latency of [0, 5]) {
    class ObservedScreen extends TerminalScreen {
      observe = false;
      synchronized = false;
      missing = 0;
      override _write(chunk: Buffer, encoding: BufferEncoding, done: () => void): void {
        const parts = chunk.toString().split(/(\x1b\[\?2026[hl])/);
        for (const part of parts) {
          if (part === '\x1b[?2026h') this.synchronized = true;
          else if (part === '\x1b[?2026l') this.synchronized = false;
          else super._write(Buffer.from(part), encoding, () => {});
          if (this.observe && !this.synchronized && !this.lines.some(line => line.includes('MARKER'))) this.missing++;
        }
        if (latency) setTimeout(done, latency); else done();
      }
    }
    const store = new RuntimeStore(), output = new ObservedScreen(), input = new Input();
    const id = store.message('s', 'logox', 'assistant', 'MARKER TOKEN00');
    const ui = renderTerminal(<App stage store={store} sessionId="s" onSubmit={async () => {}} onCancel={() => {}} onClose={async () => {}}/>,
      {stdout: output, stdin: input, stderr: output, alternateScreen: true, interactive: true, incrementalRendering: true,
        maxFps: 100, patchConsole: false, exitOnCtrlC: false});
    try {
      await delay(100); await ui.waitUntilRenderFlush();
      assert.ok(output.lines.some(line => line.includes('MARKER')));
      output.observe = true;
      for (let index = 1; index <= 12; index++) {
        store.updateMessage(id, {text: 'MARKER TOKEN' + String(index).padStart(2, '0')});
        await delay(35);
      }
      await ui.waitUntilRenderFlush(); output.observe = false;
      assert.equal(output.missing, 0, '事务结束和非同步写入都不能让历史消失；stdout 延迟 ' + latency + 'ms');
      assert.ok(output.lines.some(line => line.includes('TOKEN12')));
      assert.equal(output.synchronized, false, '绘制后退出同步模式');
    } finally {output.observe = false; ui.unmount(); await ui.waitUntilExit(); input.destroy(); output.destroy();}
  }
});
