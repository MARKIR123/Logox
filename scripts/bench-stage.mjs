// Run after build: node scripts/bench-stage.mjs [compiled stage module]
// The optional module makes the same fixture reusable against the baseline.
import {performance} from 'node:perf_hooks';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const {buildStageRows} = await import(pathToFileURL(resolve(process.argv[2] ?? 'dist/src/tui/stage.js')).href);
const messages = Array.from({length: 400}, (_, i) => ({id: String(i), sessionId: 's', ownerId: 'logox', role: 'assistant',
  text: '# 标题\n- 项目\n```ts\nconst x = 1;\n```\n' + '中文阅读🙂段落。'.repeat(100)}));
let snapshot = {revision: 0, messages, activities: [], interactions: []};
const measure = (width, hovered) => {
  const start = performance.now();
  const rows = buildStageRows(snapshot, 's', 'logox', width, {}, hovered);
  return {ms: +(performance.now() - start).toFixed(2), rows: rows.length};
};
console.log('cold', measure(80, null));
console.log('warm/hover', Array.from({length: 7}, (_, i) => measure(80, i % 2 ? 'missing' : null)));
snapshot = {...snapshot, revision: 1, messages: [...messages.slice(0, -1), {...messages.at(-1), text: messages.at(-1).text + '流式追加'}]};
console.log('one streamed message', measure(80, null));
console.log('resize cold', measure(40, null));
console.log('resize warm', measure(40, null));
