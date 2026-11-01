import test from 'node:test';
import assert from 'node:assert/strict';
import type {Message} from '../src/runtime/contracts.js';
import {categorizeToolMessage, groupToolMessages, summarizeGroup, type ToolGroup} from '../src/tui/timeline/tool-groups.js';

let counter = 0;
function tool(name: string, args: Record<string, unknown>, step: Partial<NonNullable<Message['step']>> = {}): Message {
  const id = `t${++counter}`;
  const argText = JSON.stringify(args);
  return {id, sessionId: 's', ownerId: 'logox', role: 'assistant', kind: 'tool', text: `${name}\n${argText}`,
    step: {title: name, state: 'completed', elapsedMs: 100, call: {id, name, arguments: argText}, ...step}};
}
const read = (file: string, step?: Partial<NonNullable<Message['step']>>) => tool('Read', {file_path: file}, step);
const grep = (pattern: string) => tool('Grep', {pattern});
const shell = (command: string, step?: Partial<NonNullable<Message['step']>>) => tool('Shell', {command}, step);
const msg = (role: Message['role'], text: string, extra: Partial<Message> = {}): Message =>
  ({id: `m${++counter}`, sessionId: 's', ownerId: 'logox', role, text, ...extra});
const thinking = (text = 'hmm') => msg('assistant', text, {kind: 'thinking'});
const shape = (items: ReturnType<typeof groupToolMessages>) => items.map(item => item.type === 'group' ? `G${item.messages.length}` : 'M');

test('categorizeToolMessage covers the collapsible tools', () => {
  assert.equal(categorizeToolMessage(read('a.ts')), 'read');
  assert.equal(categorizeToolMessage(grep('x')), 'search');
  assert.equal(categorizeToolMessage(tool('Glob', {pattern: '*.ts'})), 'search');
  assert.equal(categorizeToolMessage(shell('rg foo')), 'search');
  assert.equal(categorizeToolMessage(shell('ls')), 'list');
  assert.equal(categorizeToolMessage(shell('npm test')), 'command');
  assert.equal(categorizeToolMessage(tool('mcp', {tool: 'browser_navigate', url: 'https://a.dev/x'})), 'browse');
  for (const name of ['browser_click', 'browser_take_screenshot', 'browser_type', 'browser_fill_form', 'browser_press_key', 'browser_hover', 'browser_select_option', 'browser_wait_for', 'browser_snapshot', 'browser_close', 'browser_tabs']) {
    assert.equal(categorizeToolMessage(tool('mcp', {server: 'playwright', action: 'call', tool: name})), 'browse', name);
    assert.equal(categorizeToolMessage(tool('mcp', {tool: name})), 'browse', name + ' without a server');
  }
  assert.equal(categorizeToolMessage(tool('mcp', {server: 'playwright', action: 'list'})), 'browse', 'listing the Playwright tools');
  assert.equal(categorizeToolMessage(tool('mcp__playwright__browser_click', {})), 'browse');
  assert.equal(categorizeToolMessage(tool('mcp', {server: 'github', action: 'call', tool: 'create_issue'})), undefined, 'other servers stay ungrouped');
  assert.equal(categorizeToolMessage(tool('mcp', {server: 'github', action: 'list'})), undefined);
  assert.equal(categorizeToolMessage(tool('Edit', {file_path: 'a'})), undefined);
  assert.equal(categorizeToolMessage(msg('assistant', 'hi')), undefined);
});

test('a run of mixed Playwright calls collapses into one browse group', () => {
  const calls = ['browser_navigate', 'browser_click', 'browser_take_screenshot', 'browser_click', 'browser_take_screenshot', 'browser_close']
    .map(name => tool('mcp', {server: 'playwright', action: 'call', tool: name}));
  const [group, ...rest] = groupToolMessages(calls) as ToolGroup[];
  assert.equal(rest.length, 0);
  assert.equal(group?.type, 'group');
  assert.equal(group!.counts.browse, 6);
});

test('two reads of one file count as 2 calls, not 1 file', () => {
  const [group] = groupToolMessages([read('src/a.ts'), read('src/a.ts')]);
  assert.equal(group?.type, 'group');
  const g = group as ToolGroup;
  assert.equal(g.counts.read, 2);
  assert.deepEqual(g.targets, ['a.ts']);
  assert.equal(summarizeGroup(g), 'read 2 files');
});

test('a single collapsible call is a plain message', () => {
  assert.deepEqual(shape(groupToolMessages([read('a.ts')])), ['M']);
});

test('summary, targets and elapsed combine all categories', () => {
  const [g] = groupToolMessages([grep('foo'), grep('bar'), read('a/b.ts'), read('c.ts'), read('d.ts'), shell('ls'),
    tool('mcp', {tool: 'browser_navigate', url: 'https://example.com/p'}), shell('npm test'), shell('git status'), shell('make')]) as ToolGroup[];
  assert.equal(summarizeGroup(g!), 'searched 2 · read 3 files · listed 1 · browsed 1 · ran 3');
  assert.equal(g!.elapsedMs, 1000);
  assert.ok(g!.targets.includes('example.com'));
  assert.ok(g!.targets.includes('foo'));
  assert.ok(g!.targets.includes('b.ts'));
  assert.ok(!g!.targets.includes('npm') && !g!.targets.includes('git') && !g!.targets.includes('make'), 'shell command names are never targets');
});

test('failed or denied collapsible calls flush and render alone', () => {
  const failed = read('x.ts', {state: 'failed'});
  const denied = read('y.ts', {disposition: 'denied'});
  const items = groupToolMessages([read('a'), read('b'), failed, read('c'), read('d'), denied, read('e')]);
  assert.deepEqual(shape(items), ['G2', 'M', 'G2', 'M', 'M']);
  assert.equal((items[1] as {message: Message}).message, failed);
});

test('thinking does not break the group and is kept inside it', () => {
  const t = thinking();
  const [g, ...rest] = groupToolMessages([read('a'), t, read('b')]);
  assert.equal(rest.length, 0);
  assert.deepEqual((g as ToolGroup).messages.map(m => m.id).includes(t.id), true);
  assert.equal((g as ToolGroup).messages.length, 3);
});

test('short assistant text between tools is never silently dropped', () => {
  const note = msg('assistant', 'Checking the config.');
  const items = groupToolMessages([read('a'), read('b'), note, read('c'), read('d')]);
  assert.deepEqual(shape(items), ['G2', 'M', 'G2']);
  assert.equal((items[1] as {message: Message}).message, note);
});

test('trailing and leading thinking stay outside the group', () => {
  const lead = thinking('lead'), tail = thinking('tail');
  const items = groupToolMessages([lead, read('a'), read('b'), tail]);
  assert.deepEqual(shape(items), ['M', 'G2', 'M']);
  assert.equal((items[2] as {message: Message}).message, tail);
});

test('edit, write and other tools flush and render normally', () => {
  const edit = tool('Edit', {file_path: 'a.ts'});
  assert.deepEqual(shape(groupToolMessages([read('a'), read('b'), edit, read('c'), read('d')])), ['G2', 'M', 'G2']);
  assert.deepEqual(shape(groupToolMessages([read('a'), read('b'), tool('Write', {file_path: 'n'})])), ['G2', 'M']);
});

test('user, collaboration and system messages flush', () => {
  for (const other of [msg('user', 'hey'), msg('assistant', 'from peer', {inputKind: 'collaboration'}), msg('system', 'boom'), msg('notice', 'n')]) {
    assert.deepEqual(shape(groupToolMessages([read('a'), read('b'), other, read('c'), read('d')])), ['G2', 'M', 'G2'], other.role);
  }
});

test('context messages are ignored and do not break a group', () => {
  const ctx = msg('system', 'ctx') as unknown as Record<string, unknown>;
  ctx.role = 'context';
  assert.deepEqual(shape(groupToolMessages([read('a'), ctx as unknown as Message, read('b')])), ['G2']);
});

test('empty or narration-only assistant text does not break; real text does', () => {
  assert.deepEqual(shape(groupToolMessages([read('a'), msg('assistant', '  '), read('b')])), ['G3']);
  assert.deepEqual(shape(groupToolMessages([read('a'), msg('assistant', '⏵ Scanning\n'), read('b')])), ['G3']);
  assert.deepEqual(shape(groupToolMessages([read('a'), msg('assistant', '⏵ Scanning\nReal words'), read('b')])), ['M', 'M', 'M']);
});

test('stage option: a narration message flushes and labels the next run', () => {
  const stage = msg('assistant', '⏵ Mapping the repo');
  const items = groupToolMessages([read('a'), read('b'), stage, read('c'), read('d')], {stages: true});
  assert.deepEqual(shape(items), ['G2', 'M', 'G2']);
  assert.equal((items[0] as ToolGroup).stage, undefined);
  assert.equal((items[2] as ToolGroup).stage, 'Mapping the repo');
  const without = groupToolMessages([read('a'), read('b'), stage, read('c'), read('d')]);
  assert.deepEqual(shape(without), ['G5']);
});

test('running group exposes the active label and shell comments win', () => {
  const running = shell('npm run build', {state: 'running', elapsedMs: 2500});
  const [g] = groupToolMessages([read('a/file.ts'), running]) as ToolGroup[];
  assert.equal(g!.running, true);
  assert.deepEqual(g!.active, {label: '$ npm run build', elapsedMs: 2500});
  const [c] = groupToolMessages([read('a'), shell('# Verify the build\nnpm run build', {state: 'running'})]) as ToolGroup[];
  assert.equal(c!.active?.label, 'Verify the build');
  const [r] = groupToolMessages([shell('ls'), read('src/z.ts', {state: 'running'})]) as ToolGroup[];
  assert.equal(r!.active?.label, 'Read z.ts');
  const [done] = groupToolMessages([read('a'), read('b')]) as ToolGroup[];
  assert.equal(done!.active, undefined);
  assert.equal(done!.running, false);
});

test('group id is stable and derived from the first message', () => {
  const first = read('a');
  const [g] = groupToolMessages([first, read('b')]) as ToolGroup[];
  assert.equal(g!.id, first.id + '-group');
});
