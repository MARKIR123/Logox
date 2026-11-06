import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {act, type ReactElement} from 'react';
import {setTimeout as delay} from 'node:timers/promises';
import {renderTerminal as render} from '../src/tui/terminal/terminal.js';
import {TerminalScreen} from './terminal-screen.js';
import {MouseHost, type SgrMouseEvent} from '../src/tui/terminal/mouse.js';
import {EnsemblePage} from '../src/tui/panels/ensemble-page.js';
import {buildEnsemble, contextSentence, skillScope, type EnsembleSources} from '../src/commands/ensemble-model.js';
import {resolveEditor, openInEditor} from '../src/commands/editor.js';
import {ToolRegistry} from '../src/tools/registry.js';
import {builtinActors} from '../src/actors/builtins.js';
import {contextPolicySchema} from '../src/config/config.js';
import {commandCatalog} from '../src/commands.js';
import type {SkillResource} from '../src/resources/manager.js';
import type {EnsembleData} from '../src/runtime/ensemble-view.js';
Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
class Input extends PassThrough {isTTY = true; setRawMode(): this {return this;} ref(): this {return this;} unref(): this {return this;}}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'logox-ensemble-'));
  const home = join(root, 'home'), cwd = join(root, 'project');
  await mkdir(join(home, '.logox', 'actors', 'kalon'), {recursive: true});
  await mkdir(join(home, '.logox', 'skills', 'kalon', 'design'), {recursive: true});
  await mkdir(join(cwd, '.logox', 'actors', 'kalon'), {recursive: true});
  await mkdir(join(cwd, '.logox', 'skills'), {recursive: true});
  await writeFile(join(home, '.logox', 'actors', 'kalon', 'persona.md'), 'user persona');
  await writeFile(join(cwd, '.logox', 'actors', 'kalon', 'persona.md'), 'project persona');
  const skillFile = join(home, '.logox', 'skills', 'kalon', 'design', 'palette.md');
  await writeFile(skillFile, '---\nname: palette\ndescription: Pick colours\n---\n# Palette\nUse **few** colours.');
  const skills: SkillResource[] = [
    {name: 'palette', description: 'Pick colours', path: skillFile, level: 'domain', category: 'design'},
    {name: 'house', description: 'House style', path: join(cwd, '.logox', 'skills', 'house.md'), level: 'core'},
    {name: 'basics', description: 'Basics', path: join('x', 'dist', 'builtin-skills', 'public', 'basics.md'), level: 'core', public: true},
  ];
  const registry = new ToolRegistry(cwd, home);
  const merged = builtinActors.map(actor => actor.id === 'kalon' ? {...actor, prompt: 'user persona\n\nproject persona', defaultModel: {provider: 'p', model: 'kalon-model'}} : actor);
  const sources: EnsembleSources = {
    actors: () => merged, cwd, home,
    status: id => ({ownerId: id, name: id, state: 'Ready', model: {provider: 'p', model: id + '-model'}, effort: 'high', modelInfo: {window: 200000}}),
    policy: () => contextPolicySchema.parse({keep_recent_rounds: 0, keep_recent_tools: 2}),
    tools: id => registry.resolveForActor(id),
    mcp: () => [{server: 'playwright', listed: true, tools: [{name: 'browser_click', description: 'Click an element', inputSchema: {type: 'object', properties: {ref: {type: 'string', description: 'Element ref'}}, required: ['ref']}}]}],
    skills: () => skills,
    snapshot: () => ({revision: 1, pending: [], interactions: [], messages: [], activities: [
      {sessionId: 's', activityId: 'a', ownerId: 'kalon', kind: 'actor', title: 't', status: 'completed', stage: '', detail: '', version: 1},
      {sessionId: 's', activityId: 'b', ownerId: 'kalon', kind: 'actor', title: 't', status: 'failed', stage: '', detail: '', version: 1}]} as never),
    usage: () => ({input: 1500, output: 200, cost: 'USD 0.0100'}),
  };
  return {root, home, cwd, sources, data: buildEnsemble(sources), skillFile, close: () => rm(root, {recursive: true, force: true})};
}

async function mount(data: EnsembleData, opts: {columns?: number; rows?: number; home?: string} = {}) {
  const columns = opts.columns ?? 100, rows = opts.rows ?? 40;
  const input = new Input(), output = new TerminalScreen(); output.columns = columns; output.rows = rows;
  const calls = {closed: 0, models: [] as string[], edits: [] as string[], notices: [] as string[]};
  const listeners = new Set<(event: SgrMouseEvent) => void>();
  let instance!: ReturnType<typeof render>;
  const element: ReactElement = <MouseHost subscribe={handler => {listeners.add(handler); return () => {listeners.delete(handler);};}} color="#ff8800">
    <EnsemblePage data={data} width={columns} height={rows} home={opts.home ?? ''}
      onClose={() => {calls.closed++;}} onModel={id => {calls.models.push(id);}} onEdit={path => {calls.edits.push(path);}} onNotice={text => {calls.notices.push(text);}}/>
  </MouseHost>;
  await act(async () => {instance = render(element, {stdin: input, stdout: output, stderr: output, interactive: true, alternateScreen: true, patchConsole: false, exitOnCtrlC: false, maxFps: 100});});
  const flush = async () => {await act(async () => {await instance.waitUntilRenderFlush();});};
  const key = async (value: string) => {await act(async () => {input.write(value); await delay(value === '\x1b' ? 40 : 5);}); await flush();};
  const send = async (button: number, x: number, y: number, action: SgrMouseEvent['action']) => {
    await act(async () => {for (const listener of listeners) listener({button, x, y, action}); await delay(5);}); await flush();
  };
  await flush();
  return {key, calls, lines: () => output.lines.map(line => line.trimEnd()), screen: () => output.lines.join('\n'),
    click: async (x: number, y: number) => {await send(0, x, y, 'press'); await send(0, x, y, 'release');},
    wheel: (x: number, y: number, direction: 1 | -1) => send(0, x, y, direction > 0 ? 'wheel_down' : 'wheel_up'),
    close: async () => {await act(async () => {instance.unmount();}); await instance.waitUntilExit(); input.destroy(); output.destroy();}};
}
const rowOf = (lines: readonly string[], text: string) => {const at = lines.findIndex(line => line.includes(text)); assert.ok(at >= 0, 'row with ' + text + '\n' + lines.join('\n')); return at;};
const RIGHT = '\x1b[C', LEFT = '\x1b[D', DOWN = '\x1b[B', UP = '\x1b[A', TAB = '\t', PGDN = '\x1b[6~';

test('the /actors command is gone and /ensemble is the one catalog entry', () => {
  assert.equal(commandCatalog.some(entry => entry.name === 'actors'), false);
  assert.equal(commandCatalog.filter(entry => entry.name === 'ensemble').length, 1);
});

test('context sentence uses the real window and watermark', () => {
  const policy = contextPolicySchema.parse({keep_recent_rounds: 0, keep_recent_tools: 2});
  assert.equal(contextSentence(policy, 200000), 'keeps 0 rounds and 2 tool results · compacts at 84% (167k)');
  assert.equal(contextSentence(contextPolicySchema.parse({keep_recent_rounds: 1, keep_recent_tools: 1}), undefined), 'keeps 1 round and 1 tool result · compacts at 80% of the model window');
});

test('model: roster order, merged persona with project overlay, per-actor tool availability, skills by scope', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(f.data.actors.map(actor => actor.id), ['logox', 'kalon', 'techne', 'aletheia']);
    const kalon = f.data.actors[1]!, logox = f.data.actors[0]!;
    const persona = kalon.prompts.find(prompt => prompt.id === 'persona')!;
    assert.equal(persona.text, 'user persona\n\nproject persona');
    assert.equal(persona.project, true);
    assert.equal(persona.path, join(f.home, '.logox', 'actors', 'kalon', 'persona.md'));
    assert.equal(kalon.projectPath, join(f.cwd, '.logox', 'actors', 'kalon'));
    assert.equal(logox.projectPath, undefined);
    assert.equal(kalon.model.source, 'set'); assert.equal(logox.model.source, 'follows');
    assert.equal(kalon.model.text, 'kalon-model · high');
    assert.deepEqual(kalon.stats, {completed: 1, failed: 1, toolCalls: 0, toolsFailed: 0, approvals: 0, tokensIn: 1500, tokensOut: 200, cost: 'USD 0.0100'});
    const names = (actor: typeof kalon) => actor.tools.map(tool => (tool.folder.join('/') || 'core') + ':' + tool.name);
    assert.ok(names(logox).includes('orchestration:Actor'), 'the Director dispatches actors');
    assert.ok(!names(kalon).includes('orchestration:Actor'), 'companions do not get the Director-only tool');
    assert.ok(names(kalon).includes('core:Read') && names(kalon).includes('coordination:SendMessage'));
    assert.ok(names(kalon).includes('mcp:playwright:browser_click'), 'MCP servers are folders');
    assert.ok(names(kalon).includes('protocol:_FinishRound'), 'protocol tools are listed: timeline-hidden is not catalog-hidden');
    const read = kalon.tools.find(tool => tool.name === 'Read')!;
    assert.ok(read.params.some(param => param.name === 'file_path' && param.required));
    assert.deepEqual(kalon.skills.map(skill => skill.scope + '/' + skill.folder.join('/')), ['built-in/public', 'project/', 'user/kalon/design']);
    assert.deepEqual(skillScope(join(f.cwd, '.logox', 'skills', 'a', 'b.md'), f.cwd, f.home), {scope: 'project', folder: ['a']});
  } finally {await f.close();}
});

test('tabs switch by keyboard and mouse; the page shows header, parameters, session and prompts', async () => {
  const f = await fixture();
  const ui = await mount(f.data, {home: f.home});
  try {
    let lines = ui.lines();
    assert.match(lines[1]!, /^ {2}◈ Logox {3}✧ Kalon {3}⊞ Techne {3}◎ Aletheia/);
    assert.match(ui.screen(), /◈ Logox · Director/);
    assert.match(lines[rowOf(lines, 'Model')]!, /Model +.*follows session/);
    assert.match(ui.screen(), /keeps 0 rounds and 2 tool results · compacts at 84% \(167k\)/);
    await ui.key(RIGHT);
    assert.match(ui.screen(), /✧ Kalon · Aesthete/);
    assert.match(ui.screen(), /Model +kalon-model · high +set for Kalon/);
    assert.match(ui.screen(), /[+] project [\s\S]*project/);
    await ui.key(TAB); assert.match(ui.screen(), /⊞ Techne · Builder/);
    await ui.key(LEFT); await ui.key(LEFT); assert.match(ui.screen(), /◈ Logox · Director/);
    await ui.click(12, 1); assert.match(ui.screen(), /✧ Kalon · Aesthete/, 'clicking a tab selects it');
    lines = ui.lines();
    assert.match(lines[rowOf(lines, 'Tools ·')]!, /Tools · \d+ +›$/);
    assert.match(lines[rowOf(lines, 'Skills ·')]!, /Skills · 3 +›$/);
    assert.match(ui.screen(), /Tasks +1 completed · 1 failed/);
    assert.match(ui.screen(), /Tokens +1\.5k in · 200 out/);
    assert.match(ui.screen(), /Persona +persona[.]md +[+] project/);
  } finally {await ui.close(); await f.close();}
});

test('tools sub-page mirrors the directory; folders, breadcrumb and tool detail', async () => {
  const f = await fixture();
  const ui = await mount(f.data, {home: f.home});
  try {
    await ui.key(RIGHT);
    await ui.key(DOWN); await ui.key('\r');
    let lines = ui.lines();
    assert.match(lines[2]!, /Tools$/);
    assert.match(lines[rowOf(lines, 'Read')]!, /Read +\S/);
    assert.match(ui.screen(), /▸ coordination · \d+/);
    assert.match(ui.screen(), /▸ mcp:playwright · 1/);
    assert.doesNotMatch(ui.screen(), /^ +Actor +/m, 'the Director-only tool is not listed');
    await ui.click(10, rowOf(ui.lines(), '▸ mcp:playwright'));
    assert.match(ui.lines()[2]!, /Tools › mcp:playwright$/);
    await ui.key('\r');
    lines = ui.lines();
    assert.match(lines[2]!, /Tools › mcp:playwright › browser_click$/);
    assert.match(ui.screen(), /Click an element/);
    assert.match(ui.screen(), /ref +string +required/);
    assert.match(ui.screen(), /Roles +everyone/);
    await ui.key('\x1b'); assert.match(ui.lines()[2]!, /Tools › mcp:playwright$/);
    await ui.key('\x1b'); assert.match(ui.lines()[2]!, /Tools$/);
    await ui.key('\x1b'); assert.match(ui.screen(), /Parameters/);
    assert.equal(ui.calls.closed, 0);
    await ui.key('\x1b'); assert.equal(ui.calls.closed, 1);
  } finally {await ui.close(); await f.close();}
});

test('skills sub-page groups by scope and folder; detail renders the file; e opens it', async () => {
  const f = await fixture();
  const ui = await mount(f.data, {home: f.home});
  try {
    await ui.key(RIGHT);
    await ui.key(DOWN); await ui.key(DOWN); await ui.key('\r');
    assert.match(ui.screen(), /▸ Built-in · 1/); assert.match(ui.screen(), /▸ User · 1/); assert.match(ui.screen(), /▸ Project · 1/);
    await ui.click(10, rowOf(ui.lines(), '▸ User'));
    await ui.key('\r');
    await ui.key('\r');
    assert.match(ui.lines()[2]!, /Skills › User › kalon › design$/);
    assert.match(ui.screen(), /palette +Pick colours/);
    await ui.key('\r');
    assert.match(ui.screen(), /Palette/); assert.match(ui.screen(), /Use few colours/);
    assert.doesNotMatch(ui.screen(), /description: Pick colours/);
    await ui.key('e');
    assert.deepEqual(ui.calls.edits, [f.skillFile]);
  } finally {await ui.close(); await f.close();}
});

test('e edits the prompt in view; m and a click on Model open the picker; footer hints are clickable', async () => {
  const f = await fixture();
  const ui = await mount(f.data, {home: f.home});
  try {
    await ui.key(RIGHT);
    await ui.key('e');
    assert.equal(ui.calls.edits[0], join(f.home, '.logox', 'actors', 'kalon', 'persona.md'));
    await ui.key('m'); assert.deepEqual(ui.calls.models, ['kalon']);
    await ui.click(10, rowOf(ui.lines(), 'Model')); assert.deepEqual(ui.calls.models, ['kalon', 'kalon']);
    const footerRow = ui.lines().length - 2, footer = ui.lines()[footerRow]!;
    assert.match(footer, /^ {2}←→ actor · ↑↓ scroll · Enter open · m model · e edit · Esc back/);
    await ui.click(footer.indexOf('←→') + 1, footerRow);
    assert.match(ui.screen(), /⊞ Techne · Builder/);
  } finally {await ui.close(); await f.close();}
});

test('the wheel scrolls the page; narrow widths keep every row inside the screen', async () => {
  const f = await fixture();
  for (const columns of [80, 60]) {
    const ui = await mount(f.data, {columns, rows: 24, home: f.home});
    try {
      assert.ok(ui.lines().every(line => [...line].length <= columns), columns + ': no row is wider than the screen');
      const before = ui.screen();
      await ui.wheel(5, 8, 1); await ui.wheel(5, 8, 1);
      assert.notEqual(ui.screen(), before, 'wheel scrolls');
      assert.ok(ui.lines().every(line => [...line].length <= columns));
    } finally {await ui.close();}
  }
  await f.close();
});

test('external editor resolution: VISUAL, then EDITOR, then the OS opener', async () => {
  assert.equal(resolveEditor('/a/b.md', {env: {VISUAL: 'code -w', EDITOR: 'vim'}, platform: 'linux'}).source, 'VISUAL');
  assert.equal(resolveEditor('/a/b.md', {env: {VISUAL: ' ', EDITOR: 'vim'}, platform: 'linux'}).command, 'vim "/a/b.md"');
  assert.deepEqual(resolveEditor('/a/b.md', {env: {}, platform: 'linux'}), {source: 'os', command: 'xdg-open', args: ['/a/b.md'], shell: false});
  assert.equal(resolveEditor('/a/b.md', {env: {}, platform: 'darwin'}).command, 'open');
  assert.equal(resolveEditor('C:\\a\\b.md', {env: {}, platform: 'win32'}).command, 'cmd');
  const spawned: unknown[][] = [];
  const spawn = ((command: string, args: readonly string[], options: unknown) => {
    spawned.push([command, args, options]);
    const handlers: Record<string, () => void> = {};
    setImmediate(() => handlers.spawn?.());
    return {once: (event: string, handler: () => void) => {handlers[event] = handler;}, unref: () => {}};
  }) as never;
  const result = await openInEditor('/a/b.md', {env: {EDITOR: 'nano'}, platform: 'linux', spawn});
  assert.equal(result.ok, true); assert.match(result.message, /Opened b\.md via \$EDITOR/);
  assert.equal(spawned[0]![0], 'nano "/a/b.md"');
  const failing = (() => ({once: (event: string, handler: (error: Error) => void) => {if (event === 'error') setImmediate(() => handler(new Error('ENOENT')));}, unref: () => {}})) as never;
  const failed = await openInEditor('/a/b.md', {env: {}, platform: 'linux', spawn: failing});
  assert.equal(failed.ok, false); assert.match(failed.message, /Could not open b\.md/);
});
