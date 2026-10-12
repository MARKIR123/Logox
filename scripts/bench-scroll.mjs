// Complete App -> React -> Ink -> simulated TTY replay; no live sessions or credentials.
// Usage after build: node scripts/bench-scroll.mjs [compiled app module] [fps]
import {PassThrough, Writable} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {performance, monitorEventLoopDelay} from 'node:perf_hooks';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
delete process.env.NO_COLOR;
process.env.FORCE_COLOR = process.env.LOGOX_BENCH_COLOR ?? '3';
const {createElement, Profiler} = await import('react');
const {renderTerminal: render} = await import('../dist/src/tui/terminal.js');
const {App} = await import(pathToFileURL(resolve(process.argv[2] ?? 'dist/src/tui/app.js')).href);
const {RuntimeStore} = await import('../dist/src/runtime/store.js');
const fps = Number(process.argv[3] ?? 30);
class Input extends PassThrough {
  isTTY = true;
  setRawMode() {return this;}
  ref() {return this;}
  unref() {return this;}
}
class Output extends Writable {
  isTTY = true;
  bytes = 0;
  writes = 0;
  _write(chunk, _encoding, done) {this.bytes += chunk.length; this.writes++; done();}
}
const stats = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const pick = fraction => +(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0).toFixed(2);
  return {count: values.length, median: pick(.5), p95: pick(.95), max: pick(1)};
};
const scenarios = process.env.LOGOX_BENCH_SINGLE ? [[180, 65, 50]] : [[80, 24, 50], [180, 65, 50], [180, 65, 400]];
for (const [columns, rows, history] of scenarios) {
  const input = new Input(), output = new Output(), store = new RuntimeStore();
  output.columns = columns; output.rows = rows;
  for (let i = 0; i < history; i++) store.message('bench', 'logox', 'assistant',
    '## 历史 ' + i + '\n' + Array.from({length: 12}, (_, line) => '- **阅读 ' + line + '**：`src/tui/app.tsx` 中文🙂内容。'.repeat(4)).join('\n'));
  let collecting = false;
  const errors = [], originalError = console.error;
  console.error = (...values) => errors.push(values.map(String).join(' '));
  const commits = [], drawing = [], frameTimes = [], inputs = [], historyDrawing = [], historyFrames = [], scrolls = [];
  const instance = render(createElement(Profiler, {id: 'app', onRender: (_id, _phase, ms) => {if (collecting) commits.push(ms);}},
    createElement(App, {stage: true, sessionId: 'bench', store, onCancel() {}, async onClose() {}, async onSubmit() {}})),
    {stdout: output, stdin: input, stderr: output, interactive: true, alternateScreen: true, incrementalRendering: true,
      maxFps: fps, patchConsole: false, exitOnCtrlC: false,
      onHistoryFrame: ({renderTime, scrolled}) => {if (collecting) {historyDrawing.push(renderTime); historyFrames.push(performance.now()); scrolls.push(scrolled);}},
      onRender: ({renderTime}) => {if (collecting) {drawing.push(renderTime); frameTimes.push(performance.now());}}});
  try {
    await delay(150); await instance.waitUntilRenderFlush();
    output.bytes = 0; output.writes = 0; collecting = true;
    const loop = monitorEventLoopDelay({resolution: 1}); loop.enable();
    const cpu = process.cpuUsage(), start = performance.now();
    for (let i = 0; i < 80; i++) {
      const before = performance.now(); input.write('\x1b[<64;5;5M'); inputs.push(performance.now() - before);
      await delay(16);
    }
    await delay(80); await instance.waitUntilRenderFlush();
    const elapsed = performance.now() - start, usage = process.cpuUsage(cpu);
    loop.disable(); collecting = false;
    console.log(JSON.stringify({columns, rows, history, fps, elapsedMs: +elapsed.toFixed(2),
      cpuMs: +(usage.user / 1000 + usage.system / 1000).toFixed(2), commits: stats(commits), inkDraw: stats(drawing),
      historyDraw: stats(historyDrawing), historyFrameGaps: stats(historyFrames.slice(1).map((time, i) => time - historyFrames[i])), hardwareScrolls: scrolls.filter(Boolean).length,
      inputHandling: stats(inputs), frameGaps: stats(frameTimes.slice(1).map((time, i) => time - frameTimes[i])),
      loopP95Ms: +(loop.percentile(95) / 1e6).toFixed(2), loopMaxMs: +(loop.max / 1e6).toFixed(2), bytes: output.bytes, writes: output.writes, errors}));
  } finally {instance.unmount(); await instance.waitUntilExit(); input.destroy(); output.destroy(); console.error = originalError;}
}
