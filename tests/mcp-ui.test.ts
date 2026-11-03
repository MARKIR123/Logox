import test from 'node:test';
import assert from 'node:assert/strict';
import {RuntimeStore} from '../src/runtime/store.js';
import type {Step} from '../src/runtime/contracts.js';
import {buildStageRows} from '../src/tui/timeline/stage.js';
import {getToolUI} from '../src/tools/ui-registry.js';
import {palette} from '../src/tui/appearance/theme.js';
import {faintColor} from '../src/tui/appearance/colors.js';

function render(args: unknown, text: string, options: {state?: Step['state']; disposition?: Step['disposition']; open?: boolean; width?: number; name?: string} = {}) {
  const store = new RuntimeStore();
  const call = {id: 'remote', name: options.name ?? 'mcp', arguments: JSON.stringify(args)};
  const id = store.message('s', 'logox', 'notice', call.name + '\n' + text, {kind: 'tool', step: {
    title: call.name, call, callId: call.id, state: options.state ?? 'completed', elapsedMs: 600,
    ...(options.disposition ? {disposition: options.disposition} : {}),
  }});
  const snapshot = store.getSnapshot();
  const rows = buildStageRows(snapshot, 's', 'logox', options.width ?? 220, {[id]: options.open ?? false}, null);
  return {rows: rows.filter(row => row.messageId.startsWith(id) && !row.messageId.endsWith('-who')), snapshot, id};
}
const invoke = (tool: string, args: unknown = {}, server = 'inventory') => ({server, action: 'call', tool, arguments: args});
const display = (rows: readonly {text: string}[]) => rows.map(row => row.text).join('\n');

test('MCP titles read `mcp · server › tool`, for the generic tool and for direct mcp__server__tool names', () => {
  const title = (name: string, args: unknown) => getToolUI(name).title({id: 'x', name, arguments: JSON.stringify(args)});
  assert.equal(title('mcp', invoke('find_records', {query: 'hello', limit: 5})), 'mcp · inventory › find_records');
  assert.equal(title('mcp', {server: 'inventory', action: 'list'}), 'mcp · inventory › list');
  assert.equal(title('mcp__inventory__find_records', {query: 'x'}), 'mcp · inventory › find_records');
  assert.equal(getToolUI('mcp__inventory__find_records'), getToolUI('mcp'));
});

test('MCP card body: aligned key/value arguments, then the rendered result, with the shared empty state', () => {
  const {rows} = render(invoke('find_records', {query: 'hello', limit: 5, filter: {a: 1, b: [1, 2]}}), '# Results\n\n- **first**\n- second', {open: true});
  const lines = rows.map(row => (row.displayText ?? row.text).trimEnd());
  assert.match(lines[0]!, /^▾ mcp · inventory › find_records +0\.6s$/);
  assert.match(lines[1]!, /^ {2}query {3}hello$/);
  assert.match(lines[2]!, /^ {2}limit {3}5$/);
  assert.match(lines[3]!, /^ {2}filter {2}\{"a":1,"b":\[1,2\]\}$/);
  const key = rows[1]!.segments!.find(segment => segment.text.startsWith('query'))!;
  assert.equal(key.color, faintColor(), 'keys are faint');
  assert.equal(rows[1]!.segments!.find(segment => segment.text === 'hello')!.color, palette.fg, 'values use the foreground');
  const heading = rows.find(row => row.text.includes('Results'))!;
  assert.ok(heading.segments!.some(segment => segment.bold) && !heading.text.includes('#'), 'Markdown results are rendered');
  assert.ok(rows.some(row => row.text.trim().startsWith('• first')));
  const empty = render(invoke('ping', {}), '', {open: true});
  assert.deepEqual(empty.rows.map(row => row.text.trim()), [empty.rows[0]!.text.trim(), 'No output']);
  assert.equal(empty.rows[1]!.segments!.find(segment => segment.text === 'No output')!.italic, true);
});

test('MCP results use the 12-line cap with the shared expander and underline links', () => {
  const text = Array.from({length: 30}, (_, i) => `row ${i} see https://example.com/${i}`).join('\n');
  const {rows, id, snapshot} = render(invoke('dump', {}), text, {open: true});
  assert.ok(rows.some(row => row.text === '… 18 more lines'));
  const link = rows.find(row => row.text.includes('row 0'))!.segments!.find(segment => segment.text.startsWith('https://'))!;
  assert.equal(link.underline, true);
  assert.equal(link.color, palette.link);
  const more = buildStageRows(snapshot, 's', 'logox', 220, {[id]: true, [id + '-more']: true}, null);
  assert.equal(more.filter(row => /^row \d+ /.test(row.text)).length, 30);
  assert.ok(!more.some(row => /more lines/.test(row.text)));
});

test('MCP cards state images in the summary and keep each call separate', () => {
  const {rows} = render(invoke('capture'), 'Screenshot captured\n[Image: image/png]');
  assert.equal(rows.length, 1);
  assert.match(rows[0]!.text, /mcp · inventory › capture · 1 image +0\.6s/);
  const running = render(invoke('ping'), '{"server":"inventory"}', {state: 'running'});
  assert.ok(running.rows[0]!.text.includes('mcp · inventory › ping'));
  assert.doesNotMatch(running.rows[0]!.text, /Done|fields|server=/);
});

test('MCP failures use the shared failure view; outcomes follow execution status, not words in data', () => {
  const success = render(invoke('search'), 'No failed jobs found');
  assert.doesNotMatch(success.rows[0]!.text, /Error/);
  const failure = render(invoke('click'), '### Error\nElement reference expired', {disposition: 'error'});
  assert.ok(failure.rows[0]!.text.includes(' · ### Error'), failure.rows[0]!.text);
  const failed = render(invoke('click'), 'Error: Reference expired', {state: 'failed'});
  assert.match(failed.rows[0]!.text, /· Error: Reference expired +Error +0\.6s/);
  const denied = render(invoke('write'), 'Permission rejected', {disposition: 'denied'});
  assert.match(denied.rows[0]!.text, /· Permission rejected +Denied +0\.6s/);
  assert.doesNotMatch(render(invoke('write'), '', {state: 'cancelled'}).rows[0]!.text, /Done/);
});

test('MCP expanded cards mask credential fields in arguments and results', () => {
  const secret = 'DO_NOT_DISPLAY_TOKEN';
  const args = invoke('request', {url: 'https://user:password@example.com/?api_key=URL_SECRET', api_key: secret,
    headers: {Authorization: 'Bearer HEADER_SECRET'}, options: {password: 'NESTED_SECRET'}});
  const {rows, snapshot} = render(args, JSON.stringify({access_token: 'RETURNED_SECRET', message: 'Received ' + secret}), {open: true});
  const shown = display(rows);
  assert.match(shown, /\[redacted\]/);
  assert.doesNotMatch(shown, /DO_NOT_DISPLAY_TOKEN|URL_SECRET|HEADER_SECRET|NESTED_SECRET|RETURNED_SECRET|user:password/);
  assert.ok(snapshot.messages[0]!.step!.call!.arguments.includes(secret), 'Presentation must not mutate the execution ledger');
});

test('MCP masks credentials in mixed text and structured response blocks', () => {
  const {rows} = render(invoke('request'), 'Request completed\n{"access_token":"RETURNED_CREDENTIAL","credentials":{"value":"NESTED_RETURNED"}}\nAnother block\n{\n  "password": "PRETTY_RETURNED"\n}', {open: true});
  const shown = display(rows);
  assert.doesNotMatch(shown, /RETURNED_CREDENTIAL|NESTED_RETURNED|PRETTY_RETURNED/);
  assert.match(shown, /Request completed/);
  assert.match(shown, /\[redacted\]/);
});

test('MCP masks URL credentials echoed into a result, also on failure', () => {
  for (const [url, secret] of [
    ['https://user:URL_CREDENTIAL@example.com', 'URL_CREDENTIAL'],
    ['https://example.com/?api_key=URL_QUERY_CREDENTIAL', 'URL_QUERY_CREDENTIAL'],
  ] as const) {
    for (const state of ['completed', 'failed'] as const) {
      const {rows} = render(invoke('request', {url}), 'Authentication failed for ' + secret, {open: true, state});
      assert.ok(rows.every(row => !row.text.includes(secret)), rows.map(row => row.text).join('\n'));
    }
  }
});

test('MCP large payloads stay bounded: clipped arguments, capped result, no raw dump', () => {
  const args = invoke('arbitrary_operation', {code: 'x'.repeat(10_000), records: Array.from({length: 50}, (_, i) => ({id: i})),
    options: {deep: {value: 'private payload'}}, extra: 'fourth argument'});
  const title = getToolUI('mcp').title({id: 'x', name: 'mcp', arguments: JSON.stringify(args)});
  assert.ok(title.length < 250);
  assert.doesNotMatch(title, /x{60}|private payload/);
  const collapsed = render(args, 'z'.repeat(20_000), {width: 80});
  assert.equal(collapsed.rows.length, 1);
  const expanded = render(args, 'line\n'.repeat(200), {open: true, width: 80});
  assert.ok(expanded.rows.length < 30, String(expanded.rows.length));
  assert.ok(expanded.rows.every(row => row.text.length < 200));
  assert.match(display(expanded.rows), /… \d+ more lines/);
});

test('MCP presentation tolerates malformed historical calls and strips control characters', () => {
  assert.doesNotThrow(() => getToolUI('mcp').title({id: 'old', name: 'mcp', arguments: '{'}));
  const {rows} = render(invoke('inspect', {query: 'one\ntwo\u001b[2J'}), 'Ready\u0007', {open: true});
  assert.doesNotMatch(rows.map(row => row.text).join(''), /[\u0000-\u001f\u007f]/);
});
