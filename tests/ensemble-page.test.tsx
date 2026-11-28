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
import {ARCHIVE, ensembleLayout, initialState, treeFor} from '../src/tui/panels/ensemble-layout.js';
import {revealed} from '../src/tui/panels/ensemble-tree.js';
import {palette} from '../src/tui/appearance/theme.js';
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
    {name: 'house', description: 'House style', path: join(cwd, '.logox', 'skills', 'house.md'), level: 'core', pinned: true},
    {name: 'basics', description: 'Basics', path: join('x', 'dist', 'builtin-skills', 'public', 'basics.md'), level: 'core', public: true},
  ];
  // Skills the curator archived (user root `.archive/`), and the one it marked stale.
  const archivedNote = join(home, '.logox', 'skills', '.archive', 'kalon', 'retired-note.md');
  await mkdir(join(home, '.logox', 'skills', '.archive', 'kalon', 'design'), {recursive: true});
  await writeFile(archivedNote, '---\nname: retired-note\ndescription: Old note\n---\n# Retired\nRetired body.');
  const archived: SkillResource[] = [
    {name: 'retired-note', description: 'Old note', path: archivedNote, level: 'core'},
    {name: 'old-palette', description: 'Retired palette', path: join(home, '.logox', 'skills', '.archive', 'kalon', 'design', 'old-palette.md'), level: 'domain', category: 'design'}];
  const registry = new ToolRegistry(cwd, home);
  const merged = builtinActors.map(actor => actor.id === 'kalon' ? {...actor, prompt: 'user persona\n\nproject persona', defaultModel: {provider: 'p', model: 'kalon-model'}} : actor);
  const sources: EnsembleSources = {
    actors: () => merged, cwd, home,
    status: id => ({ownerId: id, name: id, state: 'Ready', model: {provider: 'p', model: id + '-model'}, effort: 'high', modelInfo: {window: 200000}}),
    policy: () => contextPolicySchema.parse({keep_recent_rounds: 0, keep_recent_tools: 2}),
    tools: id => registry.resolveForActor(id),
    mcp: () => [{server: 'playwright', listed: true, tools: [{name: 'browser_click', description: 'Click an element', inputSchema: {type: 'object', properties: {ref: {type: 'string', description: 'Element ref'}}, required: ['ref']}}]}],
    skills: () => skills, archived: () => archived, stale: () => new Set(['palette']),
    snapshot: () => ({revision: 1, pending: [], interactions: [], messages: [], activities: [
      {sessionId: 's', activityId: 'a', ownerId: 'kalon', kind: 'actor', title: 't', status: 'completed', stage: '', detail: '', version: 1},
      {sessionId: 's', activityId: 'b', ownerId: 'kalon', kind: 'actor', title: 't', status: 'failed', stage: '', detail: '', version: 1}]} as never),
    usage: () => ({input: 1500, output: 200, cost: 'USD 0.0100'}),
  };
  /** What the host rebuilds after a restore: the archived skill moves to its live place. */
  const restore = (name: string): EnsembleData => {
    const at = archived.findIndex(skill => skill.name === name), [moved] = archived.splice(at, 1);
    skills.push({...moved!, path: moved!.path.replace(join('.logox', 'skills', '.archive'), join('.logox', 'skills'))});
    return buildEnsemble(sources);
  };
  return {root, home, cwd, sources, data: buildEnsemble(sources), skillFile, restore, close: () => rm(root, {recursive: true, force: true})};
}

async function mount(data: EnsembleData, opts: {columns?: number; rows?: number; home?: string} = {}) {
  const columns = opts.columns ?? 100, rows = opts.rows ?? 40;
  const input = new Input(), output = new TerminalScreen(); output.columns = columns; output.rows = rows;
  const calls = {closed: 0, models: [] as string[], edits: [] as string[], notices: [] as string[], restored: [] as string[]};
  const listeners = new Set<(event: SgrMouseEvent) => void>();
  let instance!: ReturnType<typeof render>;
  const element = (current: EnsembleData): ReactElement => <MouseHost subscribe={handler => {listeners.add(handler); return () => {listeners.delete(handler);};}} color="#ff8800">
    <EnsemblePage data={current} width={columns} height={rows} home={opts.home ?? ''}
      onClose={() => {calls.closed++;}} onModel={id => {calls.models.push(id);}} onEdit={path => {calls.edits.push(path);}} onNotice={text => {calls.notices.push(text);}}
      onRestore={name => {calls.restored.push(name);}}/>
  </MouseHost>;
  await act(async () => {instance = render(element(data), {stdin: input, stdout: output, stderr: output, interactive: true, alternateScreen: true, patchConsole: false, exitOnCtrlC: false, maxFps: 100});});
  const flush = async () => {await act(async () => {await instance.waitUntilRenderFlush();});};
  const key = async (value: string) => {await act(async () => {input.write(value); await delay(value === '\x1b' ? 40 : 5);}); await flush();};
  const send = async (button: number, x: number, y: number, action: SgrMouseEvent['action']) => {
    await act(async () => {for (const listener of listeners) listener({button, x, y, action}); await delay(5);}); await flush();
  };
  await flush();
  const update = async (next: EnsembleData) => {await act(async () => {instance.rerender(element(next));}); await flush();};
  return {key, calls, update, lines: () => output.lines.map(line => line.trimEnd()), screen: () => output.lines.join('\n'),
    click: async (x: number, y: number) => {await send(0, x, y, 'press'); await send(0, x, y, 'release');},
    wheel: (x: number, y: number, direction: 1 | -1) => send(0, x, y, direction > 0 ? 'wheel_down' : 'wheel_up'),
    close: async () => {await act(async () => {instance.unmount();}); await instance.waitUntilExit(); input.destroy(); output.destroy();}};
}
const rowOf = (lines: readonly string[], text: string) => {const at = lines.findIndex(line => line.includes(text)); assert.ok(at >= 0, 'row with ' + text + '\n' + lines.join('\n')); return at;};
const RIGHT = '\x1b[C', LEFT = '\x1b[D', DOWN = '\x1b[B', UP = '\x1b[A', TAB = '\t', PGDN = '\x1b[6~', SPACE = ' ';

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
    assert.ok(!names(kalon).some(name => name.includes('_FinishRound')), 'the retired round tool is not listed');
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

const SELECTED = /^ {2}❯ /;
const selectedRow = (lines: readonly string[]) => lines.findIndex(line => SELECTED.test(line));
const selectedText = (ui: {lines(): string[]}) => ui.lines()[selectedRow(ui.lines())] ?? '(nothing selected)';
const lastRowOf = (lines: readonly string[], text: string) => {const at = lines.findLastIndex(line => line.includes(text)); assert.ok(at >= 0, 'row with ' + text + '\n' + lines.join('\n')); return at;};
/** Opens the Skills tree of Kalon from the main page. */
async function openKalonSkills(ui: Awaited<ReturnType<typeof mount>>) {await ui.key(RIGHT); await ui.key(DOWN); await ui.key(DOWN); await ui.key('\r');}

test('skills tree: scope roots open and deeper folders closed, counts, marks and the Archived branch', async () => {
  const f = await fixture();
  const ui = await mount(f.data, {home: f.home});
  try {
    await openKalonSkills(ui);
    const lines = ui.lines();
    assert.match(lines[2]!, /^ {2}Skills$/);
    const at = rowOf(lines, 'Built-in');
    const shown = lines.slice(at, at + 7).map(line => line.trim());
    assert.deepEqual(shown.slice(0, 6), ['❯ ▾ Built-in · 1', '▸ public · 1', '▾ User · 1', '▸ kalon · 1', '▸ Archived · 2', '▾ Project · 1']);
    assert.match(lines[at + 6]!, /^ {6}house +House style +pinned$/);
    assert.doesNotMatch(ui.screen(), /palette|basics|old-palette|retired-note/, 'deeper rows stay hidden until opened');
    assert.equal(selectedRow(lines), at, 'the first root is selected');
    assert.equal(lines.filter(line => line.includes('Archived ·')).length, 1, 'one Archived branch, under the scope that has archived skills');
  } finally {await ui.close(); await f.close();}
});

test('skills tree: Space folds and unfolds, Space on a leaf closes its folder, arrows switch the actor, Enter toggles a folder or opens a skill, Esc keeps the tree', async () => {
  const f = await fixture();
  const ui = await mount(f.data, {home: f.home});
  try {
    await openKalonSkills(ui);
    await ui.key(DOWN);
    assert.match(selectedText(ui), /▸ public · 1/);
    await ui.key(SPACE);
    assert.match(ui.screen(), /▾ public · 1/); assert.match(ui.screen(), /basics +Basics/);
    await ui.key(DOWN);
    assert.match(selectedText(ui), /basics/);
    await ui.key(SPACE);
    assert.match(selectedText(ui), /▸ public · 1/, 'Space on a leaf closes its folder and selects it');
    assert.doesNotMatch(ui.screen(), /basics/);
    await ui.key(UP); await ui.key(SPACE);
    assert.match(ui.screen(), /▸ Built-in · 1/, 'Space on an open root closes it');
    await ui.key('\r');
    assert.match(ui.screen(), /▾ Built-in · 1/, 'Enter toggles a folder');
    await ui.key(RIGHT);
    assert.match(ui.screen(), /⊞ Techne/, '→ switches the actor in a tree');
    assert.match(ui.lines()[2]!, /^ {2}Skills$/);
    await ui.key(LEFT);
    assert.match(ui.screen(), /✧ Kalon/);
    // Open the user branch down to palette and read it.
    while (!/User/.test(selectedText(ui))) await ui.key(DOWN);
    await ui.key(DOWN); await ui.key(SPACE);
    while (!/design/.test(selectedText(ui))) await ui.key(DOWN);
    await ui.key(SPACE);
    while (!/palette/.test(selectedText(ui))) await ui.key(DOWN);
    assert.match(selectedText(ui), /palette +Pick colours +stale/, 'the stale mark shows');
    await ui.key('\r');
    assert.match(ui.lines()[2]!, /^ {2}Skills › User › kalon › design › palette$/);
    assert.match(ui.screen(), /Use few colours/);
    await ui.key('e'); assert.deepEqual(ui.calls.edits, [f.skillFile]);
    await ui.key('\x1b');
    assert.match(ui.lines()[2]!, /^ {2}Skills$/);
    assert.match(selectedText(ui), /palette/, 'Esc returns to the tree with the selection kept');
    assert.match(ui.screen(), /▾ design · 1/, 'and the expansion kept');
    await ui.key('\x1b'); assert.match(ui.screen(), /Parameters/); assert.equal(ui.calls.closed, 0);
    await ui.key('\x1b'); assert.equal(ui.calls.closed, 1);
  } finally {await ui.close(); await f.close();}
});

test('skills tree: a click toggles a folder, a click on a skill opens it, a crumb returns, the wheel moves through the rows', async () => {
  const f = await fixture();
  const ui = await mount(f.data, {home: f.home});
  try {
    await openKalonSkills(ui);
    await ui.click(10, rowOf(ui.lines(), '▸ kalon'));
    assert.match(ui.screen(), /▾ kalon · 1/); assert.match(ui.screen(), /▸ design · 1/);
    assert.match(selectedText(ui), /▾ kalon · 1/, 'the clicked row becomes the selection');
    await ui.click(10, rowOf(ui.lines(), '▾ kalon'));
    assert.doesNotMatch(ui.screen(), /▸ design/, 'a second click closes it');
    await ui.click(10, rowOf(ui.lines(), '▸ public'));
    await ui.click(10, rowOf(ui.lines(), 'basics'));
    assert.match(ui.lines()[2]!, /^ {2}Skills › Built-in › public › basics$/);
    await ui.click(4, 2); // the Skills crumb
    assert.match(ui.lines()[2]!, /^ {2}Skills$/);
    assert.match(selectedText(ui), /basics/);
    const before = selectedRow(ui.lines());
    await ui.wheel(10, 6, 1);
    assert.equal(selectedRow(ui.lines()), before + 1, 'the wheel moves through the rows');
    await ui.wheel(10, 6, -1); await ui.wheel(10, 6, -1);
    assert.equal(selectedRow(ui.lines()), before - 1);
  } finally {await ui.close(); await f.close();}
});

test('skills tree: the row under the pointer is highlighted without moving the selection', async () => {
  const f = await fixture();
  try {
    const state = {...initialState(1, {kind: 'skills'}), selected: 0};
    const base = {data: {...f.data, initial: 'kalon'}, state, width: 100, height: 40, y: 0, home: f.home, readText: () => ''};
    const plain = ensembleLayout({...base, pointer: null});
    const row = plain.rows.findIndex(segs => segs.map(seg => seg.text).join('').includes('house'));
    assert.ok(row > 0);
    const hovered = ensembleLayout({...base, pointer: {x: 12, y: row + 2}}); // the body starts under the rule and the tab row
    const colors = (plan: typeof plain, at: number) => plan.rows[at]!.filter(seg => seg.text.trim()).map(seg => seg.color + (seg.bold ? '!' : ''));
    assert.notDeepEqual(colors(hovered, row), colors(plain, row), 'a hovered skill row is recoloured');
    assert.deepEqual(colors(hovered, row - 1), colors(plain, row - 1), 'other rows stay as they were');
    assert.equal(hovered.state.selected, 0);
  } finally {await f.close();}
});

test('skills tree: archived skills keep the folder structure under Archived, show dimmed, and restore from the detail page by r or a click on the footer', async () => {
  const f = await fixture();
  const ui = await mount(f.data, {home: f.home, rows: 40});
  try {
    await openKalonSkills(ui);
    await ui.click(10, rowOf(ui.lines(), '▸ Archived'));
    assert.match(ui.screen(), /▾ Archived · 2/); assert.match(ui.screen(), /▸ kalon · 2/);
    await ui.click(10, lastRowOf(ui.lines(), '▸ kalon'));
    assert.match(ui.screen(), /retired-note +Old note/); assert.match(ui.screen(), /▸ design · 1/);
    await ui.click(10, rowOf(ui.lines(), 'retired-note'));
    assert.match(ui.lines()[2]!, /^ {2}Skills › User › Archived › kalon › retired-note$/);
    assert.match(ui.screen(), /Archived · r restores it/); assert.match(ui.screen(), /Retired body/);
    const footerRow = ui.lines().length - 2;
    assert.match(ui.lines()[footerRow]!, /r restore/);
    await ui.click(ui.lines()[footerRow]!.indexOf('r restore') + 1, footerRow);
    assert.deepEqual(ui.calls.restored, ['retired-note'], 'the footer action reaches the host');
    assert.match(ui.lines()[2]!, /^ {2}Skills$/, 'the page goes back to the tree');
    await ui.update(f.restore('retired-note'));
    assert.match(selectedText(ui), /retired-note +Old note/, 'the restored skill is selected in its normal place');
    assert.ok(selectedRow(ui.lines()) < rowOf(ui.lines(), 'Archived ·'), 'above the Archived branch');
    assert.match(ui.screen(), /▾ Archived · 1/);
    assert.match(ui.screen(), /▾ kalon · 2/);
    // The key does the same from the detail page of the other archived skill.
    await ui.click(10, lastRowOf(ui.lines(), '▸ design'));
    await ui.click(10, rowOf(ui.lines(), 'old-palette'));
    assert.match(ui.screen(), /Archived · r restores it/);
    await ui.key('r');
    assert.deepEqual(ui.calls.restored, ['retired-note', 'old-palette']);
    // r on a live skill does nothing.
    await ui.update(f.restore('old-palette'));
    await ui.key('r');
    assert.equal(ui.calls.restored.length, 2);
  } finally {await ui.close(); await f.close();}
});

test('archived rows are dimmed leaves; the Archived branch counts its own skills and leaves the roots at live ones', async () => {
  const f = await fixture();
  try {
    const kalon = f.data.actors[1]!;
    const closed = treeFor(kalon, 'skills', {});
    const branch = closed.find(row => row.kind === 'folder' && row.name === ARCHIVE)!;
    assert.deepEqual([branch.kind === 'folder' && branch.label, branch.kind === 'folder' && branch.count, branch.kind === 'folder' && branch.open, branch.depth], ['Archived', 2, false, 1]);
    const user = closed.find(row => row.kind === 'folder' && row.name === 'User')!;
    assert.equal(user.kind === 'folder' && user.count, 1, 'a scope root counts its live skills');
    const open = revealed({}, 'kalon:skills', ['User', ARCHIVE, 'kalon']);
    const rows = treeFor(kalon, 'skills', open);
    const leaf = rows.find(row => row.kind === 'leaf' && row.name === 'retired-note')!;
    assert.ok(leaf.kind === 'leaf' && leaf.item.dim && leaf.depth === 3);
    assert.ok(!rows.some(row => row.kind === 'leaf' && !row.item.dim && row.path.includes(ARCHIVE)));
    const plan = ensembleLayout({data: f.data, state: {...initialState(1, {kind: 'skills'}), tree: open}, width: 100, height: 40, y: 0, pointer: null, home: f.home, readText: () => ''});
    const row = plan.rows.find(segs => segs.map(seg => seg.text).join('').includes('retired-note'))!;
    assert.equal(row.find(seg => seg.text.includes('retired-note'))!.color, palette.muted);
    const live = plan.rows.find(segs => segs.map(seg => seg.text).join('').includes('house'))!;
    assert.equal(live.find(seg => seg.text.includes('house'))!.color, palette.fg);
  } finally {await f.close();}
});

test('the page counts only live skills; archived ones are a separate list', async () => {
  const f = await fixture();
  try {
    const kalon = f.data.actors[1]!;
    assert.equal(kalon.skills.length, 3);
    assert.deepEqual(kalon.archivedSkills.map(skill => skill.scope + '/' + skill.folder.join('/') + '/' + skill.name), ['user/kalon/retired-note', 'user/kalon/design/old-palette']);
    assert.deepEqual(kalon.skills.filter(skill => skill.stale).map(skill => skill.name), ['palette']);
    assert.deepEqual(kalon.skills.filter(skill => skill.pinned).map(skill => skill.name), ['house']);
    assert.deepEqual(skillScope(join(f.home, '.logox', 'skills', '.archive', 'kalon', 'design', 'x.md'), f.cwd, f.home), {scope: 'user', folder: ['kalon', 'design']});
  } finally {await f.close();}
});

test('the Tools list is the same tree: folders closed by default, Enter, clicks and Space toggle, arrows switch the actor', async () => {
  const f = await fixture();
  const ui = await mount(f.data, {home: f.home});
  try {
    await ui.key(RIGHT); await ui.key(DOWN); await ui.key('\r');
    assert.match(ui.lines()[2]!, /^ {2}Tools$/);
    assert.match(ui.screen(), /▸ coordination · \d+/); assert.match(ui.screen(), /▸ mcp:playwright · 1/);
    assert.doesNotMatch(ui.screen(), /browser_click/);
    await ui.click(10, rowOf(ui.lines(), '▸ mcp:playwright'));
    assert.match(ui.screen(), /▾ mcp:playwright · 1/); assert.match(ui.screen(), /browser_click +Click an element/);
    await ui.key(DOWN); await ui.key('\r');
    assert.match(ui.lines()[2]!, /^ {2}Tools › mcp:playwright › browser_click$/);
    assert.match(ui.screen(), /ref +string +required/);
    await ui.key('\x1b');
    assert.match(selectedText(ui), /browser_click/);
    await ui.key(SPACE); assert.match(selectedText(ui), /▸ mcp:playwright · 1/);
    await ui.key(RIGHT); assert.match(ui.screen(), /⊞ Techne/);
    assert.match(ui.lines()[2]!, /^ {2}Tools$/);
  } finally {await ui.close(); await f.close();}
});

test('the page opens on the Skills tree when the data says so, each actor keeps its own expansion, Esc on the tree returns to the page', async () => {
  const f = await fixture();
  const ui = await mount({...f.data, initial: 'kalon', initialRoute: 'skills'}, {home: f.home});
  try {
    assert.match(ui.screen(), /✧ Kalon/); assert.match(ui.lines()[2]!, /^ {2}Skills$/);
    await ui.click(10, rowOf(ui.lines(), '▸ kalon'));
    assert.match(ui.screen(), /▾ kalon · 1/);
    await ui.key(RIGHT);
    assert.match(ui.screen(), /⊞ Techne/); assert.match(ui.lines()[2]!, /^ {2}Skills$/);
    assert.doesNotMatch(ui.screen(), /▾ kalon/, 'another actor starts from the defaults');
    await ui.key(LEFT);
    assert.match(ui.screen(), /✧ Kalon/); assert.match(ui.screen(), /▾ kalon · 1/, 'the expansion of the first actor is kept');
    await ui.key('\x1b'); assert.match(ui.screen(), /Parameters/);
    assert.match(ui.lines()[rowOf(ui.lines(), 'Skills ·')]!, /Skills · 3 +›$/, 'the count on the main page is live skills only');
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
