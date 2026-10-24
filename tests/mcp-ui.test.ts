import test from 'node:test';
import assert from 'node:assert/strict';
import {RuntimeStore} from '../src/runtime/store.js';
import type {Step} from '../src/runtime/contracts.js';
import {buildStageRows} from '../src/tui/stage.js';
import {getToolUI} from '../src/tools/ui-registry.js';

function render(args: unknown, text: string, options: {state?: Step['state']; disposition?: Step['disposition']; open?: boolean; width?: number} = {}) {
  const store = new RuntimeStore();
  const call = {id: 'remote', name: 'mcp', arguments: JSON.stringify(args)};
  const id = store.message('s', 'logox', 'notice', 'mcp\n' + text, {kind: 'tool', step: {
    title: 'mcp', call, callId: call.id, state: options.state ?? 'completed', elapsedMs: 600,
    ...(options.disposition ? {disposition: options.disposition} : {}),
  }});
  const snapshot = store.getSnapshot();
  const rows = buildStageRows(snapshot, 's', 'logox', options.width ?? 220, {[id]: options.open ?? false}, null);
  return {rows: rows.filter(row => row.messageId.startsWith(id)), snapshot, id};
}
const invoke = (tool: string, args: unknown = {}, server = 'playwright') => ({server, action: 'call', tool, arguments: args});

test('MCP titles use service, original tool and named arguments without tool-specific mappings', () => {
  for (const [args, expected] of [
    [invoke('browser_click', {element: 'START', target: 'e3'}), 'playwright.browser_click(element="START", target="e3")'],
    [invoke('find_records', {query: 'hello', limit: 5}, 'inventory'), 'inventory.find_records(query="hello", limit=5)'],
    [{server: 'inventory', action: 'list'}, 'inventory.list()'],
  ] as const) {
    assert.equal(getToolUI('mcp').title({id: 'x', name: 'mcp', arguments: JSON.stringify(args)}), expected);
  }
});

test('MCP cards show factual outcomes before duration and keep each call separate', () => {
  for (const [args, text, expected] of [
    [invoke('ping', {}, 'custom'), 'Ready', 'custom.ping() · Ready · 0.6s'],
    [invoke('empty'), '', 'playwright.empty() · Done · 0.6s'],
    [invoke('capture'), 'Screenshot captured\n[Image: image/png]', 'playwright.capture() · 1 image · 0.6s'],
    [invoke('find'), '[{"id":1},{"id":2}]', 'playwright.find() · 2 items · 0.6s'],
    [{server: 'custom', action: 'list'}, '[{"name":"one"},{"name":"two"}]', 'custom.list() · 2 tools · 0.6s'],
  ] as const) {
    const {rows} = render(args, text);
    assert.equal(rows.length, 1);
    assert.ok(rows[0]!.text.includes(expected), rows[0]!.text);
  }
  const running = render(invoke('ping'), '{"server":"playwright"}', {state: 'running'});
  assert.ok(running.rows[0]!.text.includes('playwright.ping()'));
  assert.doesNotMatch(running.rows[0]!.text, /Done|fields|server=/);
});

test('MCP outcomes use execution status, not words in successful data', () => {
  const success = render(invoke('search'), 'No failed jobs found');
  assert.doesNotMatch(success.rows[0]!.text, /Error/);
  const failure = render(invoke('click'), '### Error\nElement reference expired', {disposition: 'error'});
  assert.ok(failure.rows[0]!.text.includes(' · Error: Element reference expired · 0.6s'), failure.rows[0]!.text);
  assert.equal((failure.rows[0]!.text.match(/Error/g) ?? []).length, 1);
  assert.equal((render(invoke('click'), 'Error: Reference expired', {state: 'failed'}).rows[0]!.text.match(/Error/g) ?? []).length, 1);
  const denied = render(invoke('write'), 'Permission rejected', {disposition: 'denied'});
  assert.match(denied.rows[0]!.text, /Denied: Permission rejected · 0.6s/);
  assert.doesNotMatch(render(invoke('write'), '', {state: 'cancelled'}).rows[0]!.text, /Done/);
});

test('MCP expanded cards show bounded arguments and results while masking credential fields', () => {
  const secret = 'DO_NOT_DISPLAY_TOKEN';
  const args = invoke('request', {url: 'https://user:password@example.com/?api_key=URL_SECRET', api_key: secret,
    headers: {Authorization: 'Bearer HEADER_SECRET'}, options: {password: 'NESTED_SECRET'}});
  const {rows, snapshot} = render(args, JSON.stringify({access_token: 'RETURNED_SECRET', message: 'Received ' + secret}), {open: true});
  const display = rows.map(row => row.text).join('\n');
  assert.match(display, /Arguments/);
  assert.match(display, /Result/);
  assert.match(display, /\[redacted\]/);
  assert.doesNotMatch(display, /DO_NOT_DISPLAY_TOKEN|URL_SECRET|HEADER_SECRET|NESTED_SECRET|RETURNED_SECRET|user:password/);
  assert.ok(snapshot.messages[0]!.step!.call!.arguments.includes(secret), 'Presentation must not mutate the execution ledger');
});

test('MCP masks credentials in mixed text and structured response blocks', () => {
  const {rows} = render(invoke('request'), 'Request completed\n{"access_token":"RETURNED_CREDENTIAL","credentials":{"value":"NESTED_RETURNED"}}\nAnother block\n{\n  "password": "PRETTY_RETURNED"\n}', {open: true});
  const display = rows.map(row => row.text).join('\n');
  assert.doesNotMatch(display, /RETURNED_CREDENTIAL|NESTED_RETURNED|PRETTY_RETURNED/);
  assert.match(display, /Request completed/);
  assert.match(display, /\[redacted\]/);
});

test('MCP masks URL credentials echoed into a result', () => {
  for (const [url, secret] of [
    ['https://user:URL_CREDENTIAL@example.com', 'URL_CREDENTIAL'],
    ['https://example.com/?api_key=URL_QUERY_CREDENTIAL', 'URL_QUERY_CREDENTIAL'],
  ] as const) {
    const {rows} = render(invoke('request', {url}), 'Authentication failed for ' + secret, {open: true});
    assert.ok(rows.every(row => !row.text.includes(secret)), rows.map(row => row.text).join('\n'));
  }
});

test('MCP large payloads stay bounded and narrow collapsed cards preserve outcome and timing', () => {
  const args = invoke('arbitrary_operation', {code: 'x'.repeat(10_000), records: Array.from({length: 50}, (_, i) => ({id: i})),
    options: {deep: {value: 'private payload'}}, extra: 'fourth argument'});
  const title = getToolUI('mcp').title({id: 'x', name: 'mcp', arguments: JSON.stringify(args)});
  assert.ok(title.length < 250);
  assert.doesNotMatch(title, /x{60}|private payload/);
  const {rows} = render(args, 'z'.repeat(20_000), {width: 80});
  assert.equal(rows.length, 1);
  assert.match(rows[0]!.text, /\) · .*KB · 0.6s/);
  const expanded = render(args, 'line\n'.repeat(200), {open: true});
  assert.ok(expanded.rows.length < 60);
  assert.match(expanded.rows.map(row => row.text).join('\n'), /omitted/);
});

test('MCP presentation tolerates malformed historical calls and strips control characters', () => {
  assert.doesNotThrow(() => getToolUI('mcp').title({id: 'old', name: 'mcp', arguments: '{'}));
  const {rows} = render(invoke('inspect', {query: 'one\ntwo\u001b[2J'}), 'Ready\u0007');
  assert.doesNotMatch(rows.map(row => row.text).join(''), /[\u0000-\u001f\u007f]/);
});
