import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import type {EnsembleActor, EnsembleData, EnsembleSkill, EnsembleTool} from '../../runtime/ensemble-view.js';
import {palette} from '../appearance/theme.js';
import {faintColor, mixHex} from '../appearance/colors.js';
import {clipLine} from '../terminal/text.js';
import {inRegion, type Pointer, type Region} from '../terminal/mouse.js';
import {panePadding, panelRows} from '../components/panel-frame.js';
import {layoutMarkdown} from '../timeline/markdown.js';
import {buildTree, folderIndex, foldStep, leafIndex, revealed, withOpen, type Overrides, type TreeItem, type TreeRow} from './ensemble-tree.js';

/**
 * The /ensemble page is drawn and hit-tested from this one plan: `ensembleLayout` returns the styled rows and every region they were built from.
 * `stepEnsemble` is the one reducer keyboard, mouse and footer buttons all run.
 */
export interface Seg {readonly text: string; readonly color: string; readonly bold?: boolean; readonly italic?: boolean; readonly bg?: string}
export type Route =
  | {readonly kind: 'main'}
  | {readonly kind: 'tools'}
  | {readonly kind: 'skills'}
  | {readonly kind: 'tool'; readonly path: readonly string[]; readonly name: string}
  | {readonly kind: 'skill'; readonly path: readonly string[]; readonly name: string};
export interface EnsembleState {
  readonly tab: number; readonly route: Route; readonly scroll: number; readonly selected: number;
  /** Open and closed folders of the Tools and Skills trees (`ensemble-tree.ts`); kept per actor and list while the page is open. */
  readonly tree: Overrides;
  /** A restored skill to select once the refreshed data lists it in its normal place. */
  readonly reveal?: {readonly path: readonly string[]; readonly name: string};
}
export const initialState = (tab = 0, route: Route = {kind: 'main'}): EnsembleState => ({tab, route, scroll: 0, selected: 0, tree: {}});
export type EnsembleCommand =
  | {readonly kind: 'tab'; readonly index: number} | {readonly kind: 'tabStep'; readonly delta: number}
  | {readonly kind: 'move'; readonly delta: number} | {readonly kind: 'scroll'; readonly delta: number} | {readonly kind: 'page'; readonly delta: number}
  | {readonly kind: 'edge'; readonly end: boolean}
  | {readonly kind: 'select'; readonly index: number} | {readonly kind: 'open'; readonly index: number}
  | {readonly kind: 'fold'} | {readonly kind: 'restore'}
  | {readonly kind: 'back'} | {readonly kind: 'crumb'; readonly depth: number}
  | {readonly kind: 'model'} | {readonly kind: 'edit'};
export type EnsembleEffect =
  | {readonly kind: 'close'} | {readonly kind: 'model'; readonly actorId: string}
  | {readonly kind: 'edit'; readonly path: string} | {readonly kind: 'notice'; readonly text: string} | {readonly kind: 'restore'; readonly name: string};
export interface EnsembleHit {readonly region: Region; readonly command: EnsembleCommand}
/** One leaf of the Tools or Skills tree: what its row shows. */
export interface Leaf extends TreeItem {readonly detail: string; readonly marks: string; readonly dim: boolean}
export interface EnsemblePlan {
  readonly actor: EnsembleActor; readonly color: string;
  readonly tabs: readonly Seg[];
  readonly rows: readonly (readonly Seg[])[];
  readonly hits: readonly EnsembleHit[];
  readonly footer: {readonly text: string; readonly actions: readonly {readonly label: string; readonly command: EnsembleCommand}[]};
  readonly state: EnsembleState;
  /** Body rows below the breadcrumb, the number of lines of the page, and the furthest scroll offset. */
  readonly viewHeight: number; readonly total: number; readonly maxScroll: number;
  /** The visible rows of the Tools or Skills tree the route belongs to (empty on the main page). */
  readonly tree: readonly TreeRow<Leaf>[];
  /** Line offsets of the three main-page rows (Model, Tools, Skills). */
  readonly actionable: readonly number[];
  readonly sections: readonly {readonly id: string; readonly from: number; readonly to: number; readonly path?: string}[];
  readonly editPath?: string;
}

interface Line {readonly segs: readonly Seg[]; readonly hit?: EnsembleCommand; readonly selected?: boolean; readonly hover?: boolean}
const LABEL = 11;
export const hintOrder = ['←→ actor', '↑↓ scroll', '↑↓ choose', 'Space fold', 'Enter open', 'm model', 'e edit', 'r restore', 'Esc back'] as const;
/** The folder name an archived skill's branch uses; real folders never start with a dot (skill scans skip them). */
export const ARCHIVE = '.archive';

const scopeLabels: Record<EnsembleSkill['scope'], string> = {'built-in': 'Built-in', user: 'User', project: 'Project'};
const scopeOrder = ['Built-in', 'User', 'Project'];
export const homeShort = (path: string, home: string): string => {
  const a = path.replaceAll('\\', '/'), h = home.replaceAll('\\', '/').replace(/\/$/, '');
  return h && a.toLowerCase().startsWith(h.toLowerCase() + '/') ? '~' + a.slice(h.length) : a;
};

type List = 'tools' | 'skills';
const listOf = (route: Route): List | undefined =>
  route.kind === 'tools' || route.kind === 'tool' ? 'tools' : route.kind === 'skills' || route.kind === 'skill' ? 'skills' : undefined;
const skillPath = (skill: EnsembleSkill, archived: boolean): string[] => [scopeLabels[skill.scope], ...(archived ? [ARCHIVE] : []), ...skill.folder];
const leaves = (actor: EnsembleActor, list: List): Leaf[] => list === 'tools'
  ? actor.tools.map(tool => ({path: tool.folder, name: tool.name, detail: tool.summary, marks: '', dim: false}))
  : [...actor.skills.map(skill => ({path: skillPath(skill, false), name: skill.name, detail: skill.description, marks: skill.stale ? 'stale' : skill.pinned ? 'pinned' : '', dim: false})),
    ...actor.archivedSkills.map(skill => ({path: skillPath(skill, true), name: skill.name, detail: skill.description, marks: skill.pinned ? 'pinned' : '', dim: true}))];
const treeScope = (actor: EnsembleActor, list: List) => actor.id + ':' + list;
/** The visible rows of one actor's Tools or Skills tree: scope roots open, everything deeper closed until toggled; archived skills hang under a trailing `Archived` branch of their scope. */
export function treeFor(actor: EnsembleActor, list: List, overrides: Overrides): TreeRow<Leaf>[] {
  return buildTree(leaves(actor, list), overrides, list === 'skills'
    ? {scope: treeScope(actor, list), defaultOpen: depth => depth === 0, rootOrder: scopeOrder, trailing: ARCHIVE, label: name => name === ARCHIVE ? 'Archived' : name}
    : {scope: treeScope(actor, list), defaultOpen: () => false});
}
const findTool = (actor: EnsembleActor, route: Route): EnsembleTool | undefined => route.kind === 'tool' ? actor.tools.find(tool => tool.name === route.name && tool.folder.join('/') === route.path.join('/')) : undefined;
const findSkill = (actor: EnsembleActor, route: Route): {readonly skill: EnsembleSkill; readonly archived: boolean} | undefined => {
  if (route.kind !== 'skill') return undefined;
  for (const archived of [false, true]) {
    const skill = (archived ? actor.archivedSkills : actor.skills).find(item => item.name === route.name && skillPath(item, archived).join('/') === route.path.join('/'));
    if (skill) return {skill, archived};
  }
  return undefined;
};

/** Sub-page title chain (`Skills › User › kalon › palette`), one entry per clickable crumb. */
function crumbs(route: Route): string[] {
  if (route.kind === 'main') return [];
  const root = route.kind === 'tools' || route.kind === 'tool' ? 'Tools' : 'Skills';
  if (route.kind === 'tools' || route.kind === 'skills') return [root];
  return [root, ...route.path.map(name => name === ARCHIVE ? 'Archived' : name), route.name];
}

/** The text of a skill file without its frontmatter. */
export function skillBody(text: string): string {return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();}

// Markdown layout is the costly part of a render and does not depend on the pointer, so it is cached per text and width.
const markdownCache = new Map<string, readonly Line[]>();
function markdownLines(text: string, columns: number, pad: number): readonly Line[] {
  const key = columns + '|' + pad + '|' + palette.fg + palette.muted + palette.accent + '|' + text;
  const hit = markdownCache.get(key);
  if (hit) return hit;
  const margin: Seg = {text: ' '.repeat(pad), color: palette.fg};
  const lines = layoutMarkdown(text.trim(), columns).map((line): Line => ({segs: [margin, ...line.pieces.map((piece): Seg => ({text: piece.text,
    color: piece.muted ? palette.muted : piece.code ? palette.accent : palette.fg, ...(piece.bold ? {bold: true} : {}), ...(piece.italic ? {italic: true} : {})}))]}));
  if (markdownCache.size >= 48) markdownCache.clear();
  markdownCache.set(key, lines);
  return lines;
}

const wrap = (text: string, columns: number): string[] => text ? wrapAnsi(text, Math.max(1, columns), {hard: true, trim: true}).split('\n') : [''];
const plural = (count: number, one: string, many: string) => count + ' ' + (count === 1 ? one : many);
const compact = (n: number) => n < 1000 ? String(n) : n < 1_000_000 ? (n / 1000).toFixed(n < 100_000 ? 1 : 0).replace(/\.0$/, '') + 'k' : (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';

interface Content {readonly lines: readonly Line[]; readonly actionable: readonly number[]; readonly sections: readonly {id: string; from: number; to: number; path?: string}[]}

function mainContent(actor: EnsembleActor, columns: number, pad: number, home: string, selected: number): Content {
  const lines: Line[] = [], faint = faintColor(), rule = mixHex(actor.color, palette.bg, 0.35), margin: Seg = {text: ' '.repeat(pad), color: palette.fg};
  const push = (...segs: Seg[]) => {lines.push({segs: [margin, ...segs]});};
  const blank = () => lines.push({segs: [margin]});
  const heading = (text: string, ...extra: Seg[]) => {
    const used = stringWidth(text) + extra.reduce((sum, seg) => sum + stringWidth(seg.text), 0);
    push({text, color: actor.color, bold: true}, ...extra, ...(used + 2 < columns ? [{text: ' ' + '─'.repeat(columns - used - 1), color: rule}] : []));
  };
  const actionable: number[] = [];
  const valueRoom = Math.max(8, columns - 2 - LABEL);
  const row = (label: string, parts: readonly Seg[][], hit?: EnsembleCommand, mark?: number) => {
    // `parts` is a list of wrapped rows of value segments; the first is aligned with the label.
    parts.forEach((value, index) => {
      const active = mark !== undefined && selected === mark;
      const lead: Seg[] = [{text: index === 0 && hit ? (active ? '❯ ' : '  ') : '  ', color: actor.color, bold: true}, {text: (index === 0 ? label : '').padEnd(LABEL), color: palette.muted}];
      if (index === 0 && mark !== undefined) actionable[mark] = lines.length;
      lines.push({segs: [margin, ...lead, ...value], ...(hit ? {hit} : {}), ...(active ? {selected: true} : {}), ...(hit ? {hover: true} : {})});
    });
  };
  const wrapped = (text: string, color: string, extra: Partial<Seg> = {}): Seg[][] => wrap(text, valueRoom).map(part => [{text: part, color, ...extra}]);

  push({text: actor.glyph + ' ' + actor.name, color: actor.color, bold: true}, {text: ' · ', color: faint}, {text: actor.title, color: palette.muted});
  for (const part of wrap(actor.description, columns)) push({text: part, color: palette.muted});
  blank();
  heading('Parameters');
  const model = actor.model;
  const modelSegs: Seg[] = [{text: model.text, color: palette.fg, bold: true}, {text: '  ' + (model.source === 'set' ? 'set for ' + actor.name : 'follows session'), color: palette.muted}];
  row('Model', [modelSegs], {kind: 'open', index: 0}, 0);
  row('Context', wrapped(actor.context, palette.fg));
  const profile: Seg[][] = [];
  for (const part of wrap(homeShort(actor.userPath, home), valueRoom)) profile.push([{text: part, color: palette.fg}]);
  if (actor.projectPath) {
    const tag = '+ project ';
    wrap(homeShort(actor.projectPath, home), Math.max(4, valueRoom - tag.length)).forEach((part, index) =>
      profile.push([{text: index === 0 ? tag : ' '.repeat(tag.length), color: actor.color, bold: true}, {text: part, color: palette.fg}]));
  }
  row('Profile', profile);
  const link = (label: string, count: number, mark: number) => {
    const text = label + ' · ' + count, room = columns - 2;
    const gap = Math.max(1, room - stringWidth(text) - 1), active = selected === mark;
    actionable[mark] = lines.length;
    lines.push({segs: [margin, {text: active ? '❯ ' : '  ', color: actor.color, bold: true}, {text: label, color: palette.fg, bold: active}, {text: ' · ' + count, color: palette.muted},
      {text: ' '.repeat(gap), color: palette.fg}, {text: '›', color: active ? actor.color : palette.muted, bold: active}], hit: {kind: 'open', index: mark}, hover: true, ...(active ? {selected: true} : {})});
  };
  link('Tools', actor.tools.length, 1);
  link('Skills', actor.skills.length, 2);
  blank();
  heading('This session');
  const stats = actor.stats;
  const failed = (count: number): Seg => ({text: count + ' failed', color: count ? palette.warning : palette.muted});
  const sep: Seg = {text: ' · ', color: faint};
  row('Tasks', [[{text: stats.completed + ' completed', color: palette.fg}, sep, failed(stats.failed)]]);
  row('Tool calls', [[{text: String(stats.toolCalls), color: palette.fg}, sep, failed(stats.toolsFailed)]]);
  row('Approvals', [[{text: String(stats.approvals), color: palette.fg}]]);
  row('Tokens', [[{text: compact(stats.tokensIn) + ' in', color: palette.fg}, sep, {text: compact(stats.tokensOut) + ' out', color: palette.fg}]]);
  if (stats.cost) row('Cost', [[{text: stats.cost, color: palette.fg}]]);

  const sections: {id: string; from: number; to: number; path?: string}[] = [];
  for (const prompt of actor.prompts) {
    blank();
    const from = lines.length;
    heading(prompt.heading, {text: '  ' + prompt.file, color: faint}, ...(prompt.project ? [{text: '  + project', color: actor.color, bold: true}] : []));
    lines.push(...markdownLines(prompt.text, columns, pad));
    sections.push({id: prompt.id, from, to: lines.length, ...(prompt.path ? {path: prompt.path} : {})});
  }
  return {lines, actionable, sections};
}

function treeContent(actor: EnsembleActor, list: List, columns: number, pad: number, selected: number, rows: readonly TreeRow<Leaf>[]): Content {
  const lines: Line[] = [], margin: Seg = {text: ' '.repeat(pad), color: palette.fg}, faint = faintColor();
  if (!rows.length) {
    lines.push({segs: [margin, {text: 'No ' + list + ' are available to ' + actor.name + '.', color: palette.muted, italic: true}]});
    return {lines, actionable: [], sections: []};
  }
  const indent = (depth: number) => '  '.repeat(depth);
  const nameWidth = Math.min(Math.max(...rows.map(row => row.kind === 'leaf' ? stringWidth(indent(row.depth) + row.name) : 0), 8), Math.max(8, Math.floor(columns / 2) - 2));
  rows.forEach((row, index) => {
    const active = index === selected, flags = {hit: {kind: 'open', index} as EnsembleCommand, hover: true, ...(active ? {selected: true} : {})};
    const lead: Seg = {text: active ? '❯ ' : '  ', color: actor.color, bold: true};
    if (row.kind === 'folder') {
      lines.push({segs: [margin, lead, {text: clipLine(indent(row.depth) + (row.open ? '▾ ' : '▸ ') + row.label, columns - 2), color: palette.fg, bold: active}, {text: ' · ' + row.count, color: palette.muted}], ...flags});
      return;
    }
    const {item} = row, name = clipLine(indent(row.depth) + row.name, nameWidth), marks = item.marks;
    const room = columns - 2 - nameWidth - 2, markWidth = marks ? stringWidth(marks) + 2 : 0;
    const detail = room - markWidth >= 6 ? clipLine(item.detail, room - markWidth) : '';
    lines.push({segs: [margin, lead, {text: name + ' '.repeat(Math.max(0, nameWidth - stringWidth(name))), color: item.dim ? palette.muted : palette.fg, bold: active},
      ...(detail ? [{text: '  ' + detail + ' '.repeat(Math.max(0, room - markWidth - stringWidth(detail))), color: item.dim ? faint : palette.muted}] : []),
      ...(marks && (detail || room >= markWidth) ? [{text: '  ' + marks, color: faint}] : [])], ...flags});
  });
  return {lines, actionable: [], sections: []};
}

function toolContent(actor: EnsembleActor, tool: EnsembleTool, columns: number, pad: number): Content {
  const lines: Line[] = [], faint = faintColor(), margin: Seg = {text: ' '.repeat(pad), color: palette.fg}, rule = mixHex(actor.color, palette.bg, 0.35);
  const push = (...segs: Seg[]) => {lines.push({segs: [margin, ...segs]});};
  const heading = (text: string) => {push({text, color: actor.color, bold: true}, ...(stringWidth(text) + 3 < columns ? [{text: ' ' + '─'.repeat(columns - stringWidth(text) - 1), color: rule}] : []));};
  push({text: tool.name, color: palette.fg, bold: true}, {text: '  ' + (tool.folder.length ? tool.folder.join(' › ') : 'core'), color: faint});
  lines.push({segs: [margin]});
  lines.push(...markdownLines(tool.description || tool.summary || 'No description.', columns, pad));
  lines.push({segs: [margin]});
  heading('Parameters');
  if (!tool.params.length) push({text: 'No parameters.', color: palette.muted, italic: true});
  for (const param of tool.params) {
    push({text: param.name, color: palette.fg, bold: true}, {text: '  ' + param.type, color: palette.muted}, {text: '  ' + (param.required ? 'required' : 'optional'), color: param.required ? actor.color : faint});
    if (param.description) for (const part of wrap(param.description, columns - 2)) push({text: '  ' + part, color: palette.muted});
  }
  lines.push({segs: [margin]});
  heading('Availability');
  const fact = (label: string, value: string) => {
    wrap(value, Math.max(8, columns - LABEL)).forEach((part, index) => push({text: (index === 0 ? label : '').padEnd(LABEL), color: palette.muted}, {text: part, color: palette.fg}));
  };
  fact('Roles', tool.roles);
  fact('Loading', tool.loading === 'eager' ? 'eager; the full contract is always in context' : 'on demand; loaded by name before first use');
  fact('Shown as', tool.visibility === 'card' ? 'a card in the timeline' : tool.visibility === 'notice' ? 'a one-line notice' : 'nothing on success (silent)');
  fact('Source', tool.source === 'mcp' ? 'MCP server ' + tool.folder[0]!.replace(/^mcp:/, '') : 'built in');
  return {lines, actionable: [], sections: []};
}

function skillContent(actor: EnsembleActor, skill: EnsembleSkill, archived: boolean, text: string, columns: number, pad: number, home: string): Content {
  const lines: Line[] = [], faint = faintColor(), margin: Seg = {text: ' '.repeat(pad), color: palette.fg};
  const push = (...segs: Seg[]) => {lines.push({segs: [margin, ...segs]});};
  push({text: skill.name, color: palette.fg, bold: true}, {text: '  ' + scopeLabels[skill.scope], color: faint},
    ...(archived ? [{text: '  Archived · r restores it', color: palette.warning}] : []), ...(skill.stale ? [{text: '  stale', color: faint}] : []), ...(skill.pinned ? [{text: '  pinned', color: faint}] : []));
  for (const part of wrap(skill.description, columns)) push({text: part, color: palette.muted});
  for (const part of wrap(homeShort(skill.path, home), columns)) push({text: part, color: faint, italic: true});
  lines.push({segs: [margin]});
  lines.push(...markdownLines(skillBody(text) || '*(empty file)*', columns, pad));
  return {lines, actionable: [], sections: []};
}

function tabsRow(data: EnsembleData, tab: number, width: number, y: number, pointer: Pointer | null): {segs: Seg[]; hits: EnsembleHit[]} {
  const pad = panePadding(width), columns = Math.max(1, width - 2 * pad), gap = 3;
  const full = data.actors.map(actor => stringWidth(actor.glyph + ' ' + actor.name));
  const total = (compactInactive: boolean) => data.actors.reduce((sum, actor, index) => sum + (compactInactive && index !== tab ? stringWidth(actor.glyph) : full[index]!), 0) + gap * Math.max(0, data.actors.length - 1);
  const compactInactive = total(false) > columns;
  const segs: Seg[] = [{text: ' '.repeat(pad), color: palette.fg}], hits: EnsembleHit[] = [];
  let x = pad;
  data.actors.forEach((actor, index) => {
    const active = index === tab, text = active || !compactInactive ? actor.glyph + ' ' + actor.name : actor.glyph, w = stringWidth(text);
    if (x + w > pad + columns) return;
    const region = {y, x0: x, x1: x + w}, hover = !active && inRegion(pointer, region);
    segs.push({text: actor.glyph, color: active || hover ? actor.color : mixHex(actor.color, palette.bg, 0.6), bold: active || hover});
    if (text.length > actor.glyph.length) segs.push({text: text.slice(actor.glyph.length), color: active ? actor.color : hover ? actor.color : palette.muted, bold: active || hover});
    hits.push({region, command: {kind: 'tab', index}});
    x += w;
    if (index < data.actors.length - 1 && x + gap <= pad + columns) {segs.push({text: ' '.repeat(gap), color: palette.fg}); x += gap;}
  });
  return {segs, hits};
}

function fitHints(parts: readonly string[], columns: number): string[] {
  const kept = [...parts], drop = ['e edit', 'm model', '↑↓ scroll', 'Space fold', '↑↓ choose', 'Enter open', '←→ actor'];
  while (kept.join(' · ').length > columns) {
    const victim = drop.find(label => kept.includes(label));
    if (!victim) break;
    kept.splice(kept.indexOf(victim), 1);
  }
  return kept;
}
const hintCommand: Record<string, EnsembleCommand> = {
  '←→ actor': {kind: 'tabStep', delta: 1}, 'Space fold': {kind: 'fold'}, 'r restore': {kind: 'restore'}, '↑↓ scroll': {kind: 'scroll', delta: 1}, '↑↓ choose': {kind: 'move', delta: 1}, 'Enter open': {kind: 'open', index: -1},
  'm model': {kind: 'model'}, 'e edit': {kind: 'edit'}, 'Esc back': {kind: 'back'},
};

export interface LayoutInput {
  data: EnsembleData; state: EnsembleState; width: number; height: number; y: number; pointer: Pointer | null; hoverColor?: string | undefined;
  home: string; readText: (path: string) => string | undefined; notice?: string | undefined;
}
export function ensembleLayout(input: LayoutInput): EnsemblePlan {
  const {data, width, height, y, pointer, home} = input;
  const tabIndex = Math.max(0, Math.min(data.actors.length - 1, input.state.tab)), actor = data.actors[tabIndex]!, color = actor.color;
  const hoverColor = color;
  const pad = panePadding(width), columns = Math.max(1, width - 2 * pad), frame = panelRows(height);
  const route = input.state.route, crumbChain = crumbs(route), showCrumbs = crumbChain.length > 0 && frame.bodyHeight >= 3;
  const viewHeight = Math.max(1, frame.bodyHeight - (showCrumbs ? 1 : 0));
  const list = listOf(route), listRoute = route.kind === 'tools' || route.kind === 'skills';

  let selected = input.state.selected, overrides = input.state.tree, reveal = input.state.reveal;
  let tree = list ? treeFor(actor, list, overrides) : [];
  if (reveal && list === 'skills') {
    // A restored skill is selected in its normal place as soon as the refreshed data lists it there.
    const opened = revealed(overrides, treeScope(actor, 'skills'), reveal.path), rows = treeFor(actor, 'skills', opened), at = leafIndex(rows, reveal.path, reveal.name);
    if (at >= 0) {overrides = opened; tree = rows; selected = at; reveal = undefined;}
  }
  let content: Content;
  if (route.kind === 'main') {
    selected = Math.max(0, Math.min(2, selected));
    content = mainContent(actor, columns, pad, home, selected);
  } else if (listRoute) {
    selected = Math.max(0, Math.min(Math.max(0, tree.length - 1), selected));
    content = treeContent(actor, route.kind, columns, pad, selected, tree);
  } else if (route.kind === 'tool') {
    const tool = findTool(actor, route);
    content = tool ? toolContent(actor, tool, columns, pad) : {lines: [{segs: [{text: ' '.repeat(pad) + 'This tool is no longer available.', color: palette.muted, italic: true}]}], actionable: [], sections: []};
  } else {
    const found = findSkill(actor, route);
    content = found ? skillContent(actor, found.skill, found.archived, input.readText(found.skill.path) ?? '*Could not read this file.*', columns, pad, home)
      : {lines: [{segs: [{text: ' '.repeat(pad) + 'This skill is no longer available.', color: palette.muted, italic: true}]}], actionable: [], sections: []};
  }
  const total = content.lines.length, maxScroll = Math.max(0, total - viewHeight);
  let scroll = Math.max(0, Math.min(maxScroll, input.state.scroll));
  if (listRoute) {
    if (selected < scroll) scroll = selected;
    if (selected >= scroll + viewHeight) scroll = selected - viewHeight + 1;
    scroll = Math.max(0, Math.min(maxScroll, scroll));
  }

  // Body rows and their hit regions.
  const bodyY = y + frame.bodyY + (showCrumbs ? 1 : 0), faint = faintColor();
  const tinted = mixHex(color, palette.bg, 0.12);
  const rows: Seg[][] = [], hits: EnsembleHit[] = [];
  const tabs = tabsRow(data, tabIndex, width, y + 1, pointer);
  hits.push(...tabs.hits);
  if (showCrumbs) {
    const segs: Seg[] = [{text: ' '.repeat(pad), color: palette.fg}];
    let x = pad;
    crumbChain.forEach((name, depth) => {
      const last = depth === crumbChain.length - 1, text = clipLine(name, Math.max(1, pad + columns - x));
      if (!text) return;
      const region = {y: y + frame.bodyY, x0: x, x1: x + stringWidth(text)}, hot = !last && inRegion(pointer, region);
      segs.push({text, color: last ? color : hot ? hoverColor : palette.muted, bold: last || hot});
      if (!last) hits.push({region, command: {kind: 'crumb', depth}});
      x += stringWidth(text);
      if (!last) {segs.push({text: ' › ', color: faint}); x += 3;}
    });
    rows.push(segs);
  }
  content.lines.slice(scroll, scroll + viewHeight).forEach((line, offset) => {
    const rowY = bodyY + offset, hovered = line.hover === true && pointer !== null && pointer.y === rowY && !line.selected;
    let segs = line.segs;
    if (hovered) segs = segs.map(seg => seg.color === palette.fg || seg.color === palette.muted ? {...seg, color: hoverColor, bold: true} : seg);
    if (line.selected) {
      const used = segs.reduce((sum, seg) => sum + stringWidth(seg.text), 0);
      segs = [...segs.map(seg => ({...seg, bg: tinted})), {text: ' '.repeat(Math.max(0, width - used)), color: palette.fg, bg: tinted}];
    }
    rows.push([...segs]);
    if (line.hit) hits.push({region: {y: rowY, x0: 0, x1: width}, command: line.hit.kind === 'open' ? {...line.hit} : line.hit});
  });
  while (rows.length < frame.bodyHeight) rows.push([{text: ' ', color: palette.fg}]);

  // Footer: hints for the current route, dropping the least important first on narrow screens.
  const editPath = editTarget(actor, route, content, scroll, viewHeight, input.readText);
  let labels: string[];
  if (route.kind === 'main') labels = ['←→ actor', '↑↓ scroll', 'Enter open', 'm model', 'e edit', 'Esc back'];
  else if (listRoute) labels = ['←→ actor', '↑↓ choose', 'Space fold', 'Enter open', 'Esc back'];
  else labels = ['←→ actor', '↑↓ scroll', ...(route.kind === 'skill' ? [...(findSkill(actor, route)?.archived ? ['r restore'] : []), 'e edit'] : []), 'Esc back'];
  const shown = fitHints(labels, columns);
  const footer = {text: input.notice || shown.join(' · '), actions: input.notice ? [] : shown.map(label => ({label, command: hintCommand[label]!}))};
  return {actor, color, tabs: tabs.segs, rows, hits, footer, state: {tab: tabIndex, route, scroll, selected, tree: overrides, ...(reveal ? {reveal} : {})}, viewHeight, total, maxScroll, tree, actionable: content.actionable, sections: content.sections,
    ...(editPath ? {editPath} : {})};
}

/** The file `e` opens: the skill on a skill page, else the prompt section at the top of the viewport (the first one in view while the top is still above them). */
function editTarget(actor: EnsembleActor, route: Route, content: Content, scroll: number, viewHeight: number, _read: (path: string) => string | undefined): string | undefined {
  if (route.kind === 'skill') return findSkill(actor, route)?.skill.path;
  if (route.kind !== 'main' || !content.sections.length) return undefined;
  const containing = content.sections.find(section => section.from <= scroll && scroll < section.to);
  const target = containing ?? content.sections.find(section => section.from >= scroll && section.from < scroll + viewHeight) ?? content.sections[0]!;
  return target.path;
}

export interface StepResult {readonly state: EnsembleState; readonly effect?: EnsembleEffect}
/** Applies one command to the state the plan was drawn from. */
export function stepEnsemble(from: EnsembleState, command: EnsembleCommand, plan: EnsemblePlan, data: EnsembleData): StepResult {
  // A pending reveal belongs to the restore that set it; any other command forgets it.
  const {reveal: _pending, ...rest} = from, state: EnsembleState = command.kind === 'restore' ? from : rest;
  const actor = plan.actor, route = state.route, count = data.actors.length, rows = plan.tree, overrides = plan.state.tree;
  const clampScroll = (value: number) => Math.max(0, Math.min(plan.maxScroll, value));
  const listRoute = route.kind === 'tools' || route.kind === 'skills';
  const last = Math.max(0, rows.length - 1);
  const switchTab = (tab: number): StepResult => {
    const list = listOf(route);
    return {state: {tab, route: list ? {kind: list} : {kind: 'main'}, scroll: 0, selected: 0, tree: overrides}};
  };
  switch (command.kind) {
    case 'tab': return command.index >= 0 && command.index < count && command.index !== state.tab ? switchTab(command.index) : {state};
    case 'tabStep': return count > 1 ? switchTab((state.tab + command.delta + count * 2) % count) : {state};
    case 'scroll': case 'move': {
      const delta = command.delta;
      if (listRoute) return {state: {...state, tree: overrides, selected: Math.max(0, Math.min(last, plan.state.selected + delta))}};
      if (route.kind === 'main' && command.kind === 'move') {
        const next = plan.state.selected + delta, line = plan.actionable[next];
        const visible = line !== undefined && line >= plan.state.scroll && line < plan.state.scroll + plan.viewHeight;
        if (next >= 0 && next <= 2 && visible) return {state: {...state, selected: next, scroll: plan.state.scroll}};
      }
      return {state: {...state, scroll: clampScroll(plan.state.scroll + delta)}};
    }
    case 'page': {
      const step = Math.max(1, plan.viewHeight - 1) * command.delta;
      if (listRoute) return {state: {...state, tree: overrides, selected: Math.max(0, Math.min(last, plan.state.selected + step))}};
      return {state: {...state, scroll: clampScroll(plan.state.scroll + step)}};
    }
    case 'edge':
      if (listRoute) return {state: {...state, tree: overrides, selected: command.end ? last : 0}};
      return {state: {...state, scroll: command.end ? plan.maxScroll : 0}};
    case 'select': return {state: {...state, selected: Math.max(0, command.index)}};
    case 'fold': {
      if (!listRoute) return {state};
      const result = foldStep(rows, plan.state.selected, overrides);
      return result ? {state: {...state, tree: result.overrides, selected: result.selected}} : {state};
    }
    case 'open': {
      const index = command.index < 0 ? plan.state.selected : command.index;
      if (route.kind === 'main') {
        if (index === 0) return {state, effect: {kind: 'model', actorId: actor.id}};
        if (index === 1) return {state: {...state, route: {kind: 'tools'}, scroll: 0, selected: 0}};
        if (index === 2) return {state: {...state, route: {kind: 'skills'}, scroll: 0, selected: 0}};
        return {state};
      }
      if (listRoute) {
        const row = rows[index];
        if (!row) return {state};
        // A folder toggles in place (selection and scroll stay); a leaf opens its detail page.
        if (row.kind === 'folder') return {state: {...state, tree: withOpen(overrides, row.key, !row.open), selected: index, scroll: plan.state.scroll}};
        return {state: {...state, tree: overrides, route: {kind: route.kind === 'tools' ? 'tool' : 'skill', path: row.path, name: row.name}, scroll: 0, selected: index}};
      }
      return {state};
    }
    case 'crumb': {
      if (route.kind === 'main') return {state};
      const list = listOf(route)!, folder = route.kind === 'tool' || route.kind === 'skill' ? route.path.slice(0, command.depth) : [];
      // The root crumb is Esc (back to where the page was); a folder crumb lands on that folder.
      const selected = command.depth > 0 ? folderIndex(rows, folder) : route.kind === 'tool' || route.kind === 'skill' ? leafIndex(rows, route.path, route.name) : 0;
      return {state: {...state, tree: overrides, route: {kind: list}, scroll: 0, selected: Math.max(0, selected)}};
    }
    case 'back': {
      if (route.kind === 'main') return {state, effect: {kind: 'close'}};
      if (route.kind === 'tool' || route.kind === 'skill') {
        return {state: {...state, tree: overrides, route: {kind: route.kind === 'tool' ? 'tools' : 'skills'}, scroll: 0, selected: Math.max(0, leafIndex(rows, route.path, route.name))}};
      }
      return {state: {...state, route: {kind: 'main'}, scroll: 0, selected: route.kind === 'tools' ? 1 : 2}};
    }
    case 'model': return route.kind === 'main' ? {state, effect: {kind: 'model', actorId: actor.id}} : {state};
    case 'restore': {
      const found = findSkill(actor, route);
      if (!found?.archived || route.kind !== 'skill') return {state};
      // Back to the tree at once; the refreshed data puts the skill in its normal place and `reveal` selects it there.
      return {state: {...state, tree: overrides, route: {kind: 'skills'}, scroll: 0, selected: 0, reveal: {path: route.path.filter(name => name !== ARCHIVE), name: route.name}},
        effect: {kind: 'restore', name: found.skill.name}};
    }
    case 'edit': return plan.editPath ? {state, effect: {kind: 'edit', path: plan.editPath}}
      : {state, effect: {kind: 'notice', text: route.kind === 'tool' || listRoute ? 'Nothing to edit here.' : 'No file to edit for this section.'}};
  }
}
