import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {Profiler} from 'react';
import {renderTerminal} from '../src/tui/terminal/terminal.js';
import {App} from '../src/tui/app.js';
import {RuntimeStore} from '../src/runtime/store.js';
import {buildStageRows} from '../src/tui/timeline/stage.js';
import {TerminalScreen} from './terminal-screen.js';
import {CommandSurfaces} from '../src/commands/surfaces.js';
import stringWidth from 'string-width';

class Input extends PassThrough {
  isTTY = true;
  setRawMode(): this {return this;}
  ref(): this {return this;}
  unref(): this {return this;}
}

test('实际会话屏幕中的表格保持内容宽度，代码框线铺满，缩放后仍正确', {timeout: 5000}, async () => {
  const input = new Input(), output = new TerminalScreen(), store = new RuntimeStore();
  output.columns = 80; output.rows = 24;
  store.message('s', 'logox', 'assistant', '| 阶段 | 状态 |\n| --- | --- |\n| 基本功能 | 进行中 |\n\n```powershell\nnpm ci --ignore-scripts\nnpm run build\nnpm start\n```');
  const instance = renderTerminal(<App stage sessionId="s" store={store} onSubmit={async () => {}} onCancel={() => {}} onClose={async () => {}}/>,
    {stdout: output, stdin: input, stderr: output, interactive: true, alternateScreen: true, incrementalRendering: true, maxFps: 30, patchConsole: false, exitOnCtrlC: false});
  try {
    for (const width of [80, 180, 24]) {
      output.resize(width, 24);
      await delay(65); await instance.waitUntilRenderFlush();
      const top = output.lines.find(line => line.startsWith('▎ ┌'));
      const bottom = output.lines.find(line => line.startsWith('▎ └'));
      const codeTop = output.lines.find(line => line.includes('── powershell'));
      const codeBottom = output.lines.find(line => /^▎ ─+$/.test(line));
      assert.ok(top && bottom && codeTop && codeBottom, '上下框线都出现在实际屏幕');
      for (const line of [top, bottom]) assert.equal(stringWidth(line), 23, '宽窗口不拉伸短表格');
      for (const line of [codeTop, codeBottom]) assert.equal(stringWidth(line), width - 1, '代码横线继续铺满可用宽度');
      assert.ok(top.endsWith('┐') && bottom.endsWith('┘'), '右侧角点未被终端裁掉');
      assert.ok(output.lines.some(line => line.includes('npm start')), '代码正文没有被框线覆盖');
    }
  } finally {instance.unmount(); await instance.waitUntilExit(); input.destroy(); output.destroy();}
});

test('独立滚动画布：实际屏幕正确，纯滚轮不更新 React，输入/缩放/窗口/流式/复制/退出一致', {timeout: 12000}, async () => {
  const input = new Input(), output = new TerminalScreen(), store = new RuntimeStore();
  output.columns = 180; output.rows = 65;
  const id = store.message('s', 'logox', 'assistant', Array.from({length: 250}, (_, i) => 'ROW-' + String(i).padStart(3, '0') + ' **中文🙂** `代码`').join('\n'));
  store.message('s', 'aletheia', 'assistant', '侦察者的独立回复');
  const surfaces = new CommandSurfaces(() => {});
  let commits = 0;
  const errors: string[] = [], originalError = console.error;
  console.error = (...args: unknown[]) => {errors.push(args.map(String).join(' '));};
  const instance = renderTerminal(<Profiler id="app" onRender={() => {commits++;}}><App stage sessionId="s" store={store} surfaces={surfaces}
    onSubmit={async () => {}} onCancel={() => {}} onClose={async () => {}}/></Profiler>,
    {stdout: output, stdin: input, stderr: output, interactive: true, alternateScreen: true, incrementalRendering: true, maxFps: 30, patchConsole: false, exitOnCtrlC: false});
  const settle = async () => {await delay(65); await instance.waitUntilRenderFlush();};
  const topText = () => output.lines[0]!.replace(/^▎ /, '');
  try {
    await settle(); input.write('保留草稿'); await settle();
    const footer = output.lines.slice(61);
    assert.ok(footer.some(line => line.includes('保留草稿')), '草稿显示在会话画布之外');
    const before = commits; output.text = '';
    input.write('\x1b[<64;5;5M'.repeat(2)); await settle();
    const all = buildStageRows(store.getSnapshot(), 's', 'logox', 179, {}, null);
    assert.equal(topText(), all[all.length - 61 - 6]!.text, '同批两次滚轮累计六行');
    assert.equal(commits, before, '纯滚轮完全绕开 React');
    assert.ok(/\x1b\[1;61r\x1b\[6T\x1b\[r/.test(output.text), '局部硬件滚动');
    assert.deepEqual(output.lines.slice(61), footer, '输入区与状态栏不被滚动');
    const reading = topText();
    store.appendMessage(id, '\n新分片'); await settle();
    assert.equal(topText(), reading, '阅读时追加保持位置');
    input.write('继续'); await settle();
    assert.equal(topText(), reading, 'Ink 重画输入后正确恢复画布');
    input.write('\x1b[200~\n第二行\x1b[201~'); await settle();
    assert.ok(output.lines.some(line => line.includes('第二行')));
    assert.ok(!output.lines.slice(60).some(line => line.includes('ROW-')), '输入增高释放的历史行必须清空');
    surfaces.openPage('配置页面', [{id: 'one', title: '设置', lines: ['页面内容', '', '第三行']}], 'one'); await settle();
    assert.ok(output.lines.some(line => line.includes('页面内容')));
    assert.ok(!output.lines.some(line => line.includes('ROW-')), '页面空白位置没有旧画布残影');
    surfaces.cancel(); await settle();
    assert.ok(output.lines.some(line => line.includes(reading.slice(0, 7))), '关闭页面恢复历史');
    input.write('\x07'); await settle();
    assert.ok(output.lines.some(line => line.includes('侦察者的独立回复')));
    assert.ok(!output.lines.some(line => line.includes('ROW-')));
    input.write('\x1b'); await settle();
    assert.equal(topText(), reading, '返回主窗口保留锚点');
    assert.ok(output.lines.some(line => line.includes('保留草稿继续')));
    output.resize(60, 18); await settle();
    assert.ok(output.lines.some(line => line.includes(reading.slice(0, 7))), '缩放保留原文位置');
    input.write('\x05'); await settle();
    store.message('s', 'logox', 'assistant', '跟随末尾'); await settle();
    assert.ok(output.lines.some(line => line.includes('跟随末尾')));
    // Select actual current rows after a scroll; hit testing must not use App's previous viewport.
    input.write('\x1b[<64;5;5M'); await settle();
    const selected = output.lines[0]!.replace(/^▎ /, '');
    output.text = '';
    input.write('\x1b[<0;3;1M\x1b[<32;80;1M\x1b[<0;80;1m'); await settle();
    const clipboard = /\x1b\]52;c;([^\x07]*)\x07/.exec(output.text);
    assert.ok(clipboard, '释放鼠标复制原文');
    assert.ok(Buffer.from(clipboard[1]!, 'base64').toString().includes(selected.slice(0, 7)), '复制当前画布行');
    assert.equal(errors.length, 0, errors.join('\n'));
  } finally {
    instance.unmount(); await instance.waitUntilExit();
    const length = output.text.length; await delay(30);
    assert.equal(output.text.length, length, '退出后没有残留滚动帧');
    assert.ok(output.text.includes('\x1b[?1049l'));
    assert.equal(output.listenerCount('resize'), 0);
    console.error = originalError; surfaces.close(); input.destroy(); output.destroy();
  }
});

test('异步 stdout 的 Ink 与画布写出顺序一致，屏幕阅读器保留 Ink 正文', {timeout: 8000}, async () => {
  for (const screenReader of [false, true]) {
    class AsyncScreen extends TerminalScreen {
      override _write(chunk: Buffer, encoding: BufferEncoding, done: () => void): void {setImmediate(() => super._write(chunk, encoding, done));}
    }
    const input = new Input(), output = new AsyncScreen(), store = new RuntimeStore();
    output.columns = 40; output.rows = 12;
    const id = store.message('s', 'logox', 'assistant', Array.from({length: 50}, (_, i) => 'ASYNC-' + i).join('\n'));
    const instance = renderTerminal(<App stage store={store} sessionId="s" onSubmit={async () => {}} onCancel={() => {}} onClose={async () => {}}/>,
      {stdout: output, stdin: input, stderr: output, interactive: true, alternateScreen: true, incrementalRendering: true,
        isScreenReaderEnabled: screenReader, maxFps: 100, patchConsole: false, exitOnCtrlC: false});
    const settle = async () => {await delay(50); await instance.waitUntilRenderFlush();};
    try {
      await settle(); input.write('输入保留'); await settle();
      const rows = buildStageRows(store.getSnapshot(), 's', 'logox', 39, {}, null);
      // One composer, two separators, and the new single-line statusbar.
      const historyHeight = output.rows - 4;
      const expectedTop = rows[rows.length - historyHeight - 3]!.text;
      input.write('\x1b[<64;5;2M'); await settle();
      store.appendMessage(id, '\n追加'); await settle();
      if (screenReader) assert.ok(output.text.includes('ASYNC-'), '阅读器没有丢失正文');
      else {
        assert.equal(output.lines[0], '▎ ' + expectedTop);
        assert.ok(output.lines.slice(historyHeight).some(line => line.includes('输入保留')));
        assert.ok(!output.lines.some(line => line.includes('追加')), '异步写出期间不抢回底部');
        output.resize(4, 8); await settle();
        assert.ok(output.lines.every(line => line.length <= 4), '极窄屏不写出窗口边界');
      }
    } finally {instance.unmount(); await instance.waitUntilExit(); input.destroy(); output.destroy();}
  }
});
