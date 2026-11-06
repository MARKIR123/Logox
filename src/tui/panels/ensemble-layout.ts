import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import type {EnsembleActor, EnsembleData, EnsembleSkill, EnsembleTool} from '../../runtime/ensemble-view.js';
import {palette} from '../appearance/theme.js';
import {faintColor, mixHex} from '../appearance/colors.js';
import {clipLine} from '../terminal/text.js';
import {inRegion, type Pointer, type Region} from '../terminal/mouse.js';
import {panePadding, panelRows} from '../components/panel-frame.js';
import {layoutMarkdown} from '../timeline/markdown.js';

/**
 * The /ensemble page is drawn and hit-tested from this one plan: `ensembleLayout` returns the styled rows and every region they were built from.
 * `stepEnsemble` is the one reducer keyboard, mouse and footer buttons all run.
 */
export interface Seg {readonly text: string; readonly color: string; readonly bold?: boolean; readonly italic?: boolean; readonly bg?: string}
export type Route =
  | {readonly kind: 'main'}
  | {readonly kind: 'tools'; readonly path: readonly string[]}
  | {readonly kind: 'skills'; readonly path: readonly string[]}
  | {readonly kind: 'tool'; readonly path: readonly string[]; readonly name: string}
  | {readonly kind: 'skill'; readonly path: readonly string[]; readonly name: string};
export interface EnsembleState {readonly tab: number; readonly route: Route; readonly scroll: number; readonly selected: number}
export const initialState = (tab = 0): EnsembleState => ({tab, route: {kind: 'main'}, scroll: 0, selected: 0});
export type EnsembleCommand =
  | {readonly kind: 'tab'; readonly index: number} | {readonly kind: 'tabStep'; readonly delta: number}
  | {readonly kind: 'move'; readonly delta: number} | {readonly kind: 'scroll'; readonly delta: number} | {readonly kind: 'page'; readonly delta: number}
  | {readonly kind: 'edge'; readonly end: boolean}
  | {readonly kind: 'select'; readonly index: number} | {readonly kind: 'open'; readonly index: number}
  | {readonly kind: 'back'} | {readonly kind: 'crumb'; readonly depth: number}
  | {readonly kind: 'model'} | {readonly kind: 'edit'};
export type EnsembleEffect =
  | {readonly kind: 'close'} | {readonly kind: 'model'; readonly actorId: string}
  | {readonly kind: 'edit'; readonly path: string} | {readonly kind: 'notice'; readonly text: string};
export interface EnsembleHit {readonly region: Region; readonly command: EnsembleCommand}
export interface ListEntry {
  readonly kind: 'folder' | 'item'; readonly name: string; readonly label: string; readonly detail: string; readonly count?: number;
}
export interface EnsemblePlan {
  readonly actor: EnsembleActor; readonly color: string;
  readonly tabs: readonly Seg[];
  readonly rows: readonly (readonly Seg[])[];
  readonly hits: readonly EnsembleHit[];
  readonly footer: {readonly text: string; readonly actions: readonly {readonly label: string; readonly command: EnsembleCommand}[]};
  readonly state: EnsembleState;
  /** Body rows below the breadcrumb, the number of lines of the page, and the furthest scroll offset. */
  readonly viewHeight: number; readonly total: number; readonly maxScroll: number;
  readonly entries: readonly ListEntry[];
  /** Line offsets of the three main-page rows (Model, Tools, Skills). */
  readonly actionable: readonly number[];
  readonly sections: readonly {readonly id: string; readonly from: number; readonly to: number; readonly path?: string}[];
  readonly editPath?: string;
}

interface Line {readonly segs: readonly Seg[]; readonly hit?: EnsembleCommand; readonly selected?: boolean; readonly hover?: boolean}
const LABEL = 11;
export const hintOrder = ['←→ actor', '↑↓ scroll', '↑↓ choose', 'Enter open', 'm model', 'e edit', 'Esc back'] as const;

const scopeLabels: Record<EnsembleSkill['scope'], string> = {'built-in': 'Built-in', user: 'User', project: 'Project'};
const scopeOrder = ['Built-in', 'User', 'Project'];
export const homeShort = (path: string, home: string): string => {
  const a = path.replaceAll('\\', '/'), h = home.replaceAll('\\', '/').replace(/\/$/, '');
  return h && a.toLowerCase().startsWith(h.toLowerCase() + '/') ? '~' + a.slice(h.length) : a;
};

/** Entries of one directory level: leaves first, then one `▸` folder per sub-category. */
export function listAt<T extends {readonly path: readonly string[]}>(items: readonly T[], at: readonly string[]): {leaves: T[]; folders: {name: string; count: number}[]} {
  const leaves: T[] = [], folders = new Map<string, number>();
  for (const item of items) {
    if (item.path.length < at.length || at.some((segment, index) => item.path[index] !== segment)) continue;
    if (item.path.length === at.length) leaves.push(item);
    else {const name = item.path[at.length]!; folders.set(name, (folders.get(name) ?? 0) + 1);}
  }
  const order = (name: string) => at.length === 0 && scopeOrder.includes(name) ? scopeOrder.indexOf(name) : 0;
  return {leaves, folders: [...folders].map(([name, count]) => ({name, count})).sort((a, b) => order(a.name) - order(b.name) || a.name.localeCompare(b.name))};
}
const toolItems = (actor: EnsembleActor) => actor.tools.map(tool => ({path: tool.folder, tool}));
const skillItems = (actor: EnsembleActor) => actor.skills.map(skill => ({path: [scopeLabels[skill.scope], ...skill.folder], skill}));
export function entriesFor(actor: EnsembleActor, route: Route): ListEntry[] {
  if (route.kind === 'tools') {
    const {leaves, folders} = listAt(toolItems(actor), route.path);
    return [...leaves.map(({tool}): ListEntry => ({kind: 'item', name: tool.name, label: tool.name, detail: tool.summary})),
      ...folders.map((folder): ListEntry => ({kind: 'folder', name: folder.name, label: '▸ ' + folder.name, detail: '· ' + folder.count, count: folder.count}))];
  }
  if (route.kind === 'skills') {
    const {leaves, folders} = listAt(skillItems(actor), route.path);
    return [...leaves.map(({skill}): ListEntry => ({kind: 'item', name: skill.name, label: skill.name, detail: skill.description})),
      ...folders.map((folder): ListEntry => ({kind: 'folder', name: folder.name, label: '▸ ' + folder.name, detail: '· ' + folder.count, count: folder.count}))];
  }
  return [];
}
const findTool = (actor: EnsembleActor, route: Route): EnsembleTool | undefined => route.kind === 'tool' ? actor.tools.find(tool => tool.name === route.name && tool.folder.join('/') === route.path.join('/')) : undefined;
const findSkill = (actor: EnsembleActor, route: Route): EnsembleSkill | undefined => route.kind === 'skill' ? actor.skills.find(skill => skill.name === route.name && [scopeLabels[skill.scope], ...skill.folder].join('/') === route.path.join('/')) : undefined;

/** Sub-page title chain (`Tools › coordination`), one entry per clickable crumb. */
function crumbs(route: Route): string[] {
  if (route.kind === 'main') return [];
  const root = route.kind === 'tools' || route.kind === 'tool' ? 'Tools' : 'Skills';
  const detail = route.kind === 'tool' || route.kind === 'skill' ? [route.name] : [];
  return [root, ...route.path, ...detail];
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

function listContent(actor: EnsembleActor, route: Route, columns: number, pad: number, selected: number, entries: readonly ListEntry[]): Content {
  const lines: Line[] = [], margin: Seg = {text: ' '.repeat(pad), color: palette.fg};
  if (!entries.length) {
    lines.push({segs: [margin, {text: route.kind === 'tools' ? 'No tools are available to ' + actor.name + '.' : 'No skills are available to ' + actor.name + '.', color: palette.muted, italic: true}]});
    return {lines, actionable: [], sections: []};
  }
  const nameWidth = Math.min(Math.max(...entries.filter(entry => entry.kind === 'item').map(entry => stringWidth(entry.label)), 8), Math.floor(columns / 2) - 2);
  entries.forEach((entry, index) => {
    const active = index === selected;
    const label = clipLine(entry.label, entry.kind === 'folder' ? columns - 2 : nameWidth);
    const lead: Seg = {text: active ? '❯ ' : '  ', color: actor.color, bold: true};
    if (entry.kind === 'folder') {
      lines.push({segs: [margin, lead, {text: label, color: palette.fg, bold: active}, {text: ' ' + entry.detail, color: palette.muted}], hit: {kind: 'open', index}, hover: true, ...(active ? {selected: true} : {})});
      return;
    }
    const room = columns - 2 - nameWidth - 2;
    lines.push({segs: [margin, lead, {text: label + ' '.repeat(Math.max(0, nameWidth - stringWidth(label))), color: palette.fg, bold: active},
      ...(room >= 6 ? [{text: '  ' + clipLine(entry.detail, room), color: palette.muted}] : [])], hit: {kind: 'open', index}, hover: true, ...(active ? {selected: true} : {})});
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

function skillContent(actor: EnsembleActor, skill: EnsembleSkill, text: string, columns: number, pad: number, home: string): Content {
  const lines: Line[] = [], faint = faintColor(), margin: Seg = {text: ' '.repeat(pad), color: palette.fg};
  const push = (...segs: Seg[]) => {lines.push({segs: [margin, ...segs]});};
  push({text: skill.name, color: palette.fg, bold: true}, {text: '  ' + scopeLabels[skill.scope], color: faint});
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
  const kept = [...parts], drop = ['e edit', 'm model', '↑↓ scroll', '↑↓ choose', 'Enter open', '←→ actor'];
  while (kept.join(' · ').length > columns) {
    const victim = drop.find(label => kept.includes(label));
    if (!victim) break;
    kept.splice(kept.indexOf(victim), 1);
  }
  return kept;
}
const hintCommand: Record<string, EnsembleCommand> = {
  '←→ actor': {kind: 'tabStep', delta: 1}, '↑↓ scroll': {kind: 'scroll', delta: 1}, '↑↓ choose': {kind: 'move', delta: 1}, 'Enter open': {kind: 'open', index: -1},
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
  const entries = entriesFor(actor, route);
  const listRoute = route.kind === 'tools' || route.kind === 'skills';

  let selected = input.state.selected;
  let content: Content;
  if (route.kind === 'main') {
    selected = Math.max(0, Math.min(2, selected));
    content = mainContent(actor, columns, pad, home, selected);
  } else if (listRoute) {
    selected = Math.max(0, Math.min(Math.max(0, entries.length - 1), selected));
    content = listContent(actor, route, columns, pad, selected, entries);
  } else if (route.kind === 'tool') {
    const tool = findTool(actor, route);
    content = tool ? toolContent(actor, tool, columns, pad) : {lines: [{segs: [{text: ' '.repeat(pad) + 'This tool is no longer available.', color: palette.muted, italic: true}]}], actionable: [], sections: []};
  } else {
    const skill = findSkill(actor, route);
    content = skill ? skillContent(actor, skill, input.readText(skill.path) ?? '*Could not read this file.*', columns, pad, home)
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
  else if (listRoute) labels = ['←→ actor', '↑↓ choose', 'Enter open', 'Esc back'];
  else labels = ['←→ actor', '↑↓ scroll', ...(route.kind === 'skill' ? ['e edit'] : []), 'Esc back'];
  const shown = fitHints(labels, columns);
  const footer = {text: input.notice || shown.join(' · '), actions: input.notice ? [] : shown.map(label => ({label, command: hintCommand[label]!}))};
  return {actor, color, tabs: tabs.segs, rows, hits, footer, state: {tab: tabIndex, route, scroll, selected}, viewHeight, total, maxScroll, entries, actionable: content.actionable, sections: content.sections,
    ...(editPath ? {editPath} : {})};
}

/** The file `e` opens: the skill on a skill page, else the prompt section at the top of the viewport (the first one in view while the top is still above them). */
function editTarget(actor: EnsembleActor, route: Route, content: Content, scroll: number, viewHeight: number, _read: (path: string) => string | undefined): string | undefined {
  if (route.kind === 'skill') return findSkill(actor, route)?.path;
  if (route.kind !== 'main' || !content.sections.length) return undefined;
  const containing = content.sections.find(section => section.from <= scroll && scroll < section.to);
  const target = containing ?? content.sections.find(section => section.from >= scroll && section.from < scroll + viewHeight) ?? content.sections[0]!;
  return target.path;
}

export interface StepResult {readonly state: EnsembleState; readonly effect?: EnsembleEffect}
/** Applies one command to the state the plan was drawn from. */
export function stepEnsemble(state: EnsembleState, command: EnsembleCommand, plan: EnsemblePlan, data: EnsembleData): StepResult {
  const actor = plan.actor, route = state.route, count = data.actors.length;
  const clampScroll = (value: number) => Math.max(0, Math.min(plan.maxScroll, value));
  const listRoute = route.kind === 'tools' || route.kind === 'skills';
  const switchTab = (tab: number): StepResult => {
    const root: Route = route.kind === 'tools' || route.kind === 'tool' ? {kind: 'tools', path: []} : route.kind === 'skills' || route.kind === 'skill' ? {kind: 'skills', path: []} : {kind: 'main'};
    return {state: {tab, route: root, scroll: 0, selected: 0}};
  };
  switch (command.kind) {
    case 'tab': return command.index >= 0 && command.index < count && command.index !== state.tab ? switchTab(command.index) : {state};
    case 'tabStep': return count > 1 ? switchTab((state.tab + command.delta + count * 2) % count) : {state};
    case 'scroll': case 'move': {
      const delta = command.delta;
      if (listRoute) {
        const max = Math.max(0, plan.entries.length - 1);
        return {state: {...state, selected: Math.max(0, Math.min(max, plan.state.selected + delta))}};
      }
      if (route.kind === 'main' && command.kind === 'move') {
        const next = plan.state.selected + delta, line = plan.actionable[next];
        const visible = line !== undefined && line >= plan.state.scroll && line < plan.state.scroll + plan.viewHeight;
        if (next >= 0 && next <= 2 && visible) return {state: {...state, selected: next, scroll: plan.state.scroll}};
      }
      return {state: {...state, scroll: clampScroll(plan.state.scroll + delta)}};
    }
    case 'page': {
      const step = Math.max(1, plan.viewHeight - 1) * command.delta;
      if (listRoute) return {state: {...state, selected: Math.max(0, Math.min(Math.max(0, plan.entries.length - 1), plan.state.selected + step))}};
      return {state: {...state, scroll: clampScroll(plan.state.scroll + step)}};
    }
    case 'edge':
      if (listRoute) return {state: {...state, selected: command.end ? Math.max(0, plan.entries.length - 1) : 0}};
      return {state: {...state, scroll: command.end ? plan.maxScroll : 0}};
    case 'select': return {state: {...state, selected: Math.max(0, command.index)}};
    case 'open': {
      const index = command.index < 0 ? plan.state.selected : command.index;
      if (route.kind === 'main') {
        if (index === 0) return {state, effect: {kind: 'model', actorId: actor.id}};
        if (index === 1) return {state: {...state, route: {kind: 'tools', path: []}, scroll: 0, selected: 0}};
        if (index === 2) return {state: {...state, route: {kind: 'skills', path: []}, scroll: 0, selected: 0}};
        return {state};
      }
      if (listRoute) {
        const entry = plan.entries[index];
        if (!entry) return {state};
        if (entry.kind === 'folder') return {state: {...state, route: {kind: route.kind, path: [...route.path, entry.name]}, scroll: 0, selected: 0}};
        return {state: {...state, route: {kind: route.kind === 'tools' ? 'tool' : 'skill', path: route.path, name: entry.name}, scroll: 0, selected: index}};
      }
      return {state};
    }
    case 'crumb': {
      if (route.kind === 'main') return {state};
      const kind = route.kind === 'tools' || route.kind === 'tool' ? 'tools' : 'skills';
      return {state: {...state, route: {kind, path: route.path.slice(0, command.depth)}, scroll: 0, selected: 0}};
    }
    case 'back': {
      if (route.kind === 'main') return {state, effect: {kind: 'close'}};
      if (route.kind === 'tool' || route.kind === 'skill') {
        const kind = route.kind === 'tool' ? 'tools' : 'skills', list = {kind, path: route.path} as Route;
        const index = entriesFor(actor, list).findIndex(entry => entry.kind === 'item' && entry.name === route.name);
        return {state: {...state, route: list, scroll: 0, selected: Math.max(0, index)}};
      }
      if (route.path.length > 0) {
        const left = route.path.at(-1)!, parent = {kind: route.kind, path: route.path.slice(0, -1)} as Route;
        return {state: {...state, route: parent, scroll: 0, selected: Math.max(0, entriesFor(actor, parent).findIndex(entry => entry.kind === 'folder' && entry.name === left))}};
      }
      return {state: {...state, route: {kind: 'main'}, scroll: 0, selected: route.kind === 'tools' ? 1 : 2}};
    }
    case 'model': return route.kind === 'main' ? {state, effect: {kind: 'model', actorId: actor.id}} : {state};
    case 'edit': return plan.editPath ? {state, effect: {kind: 'edit', path: plan.editPath}}
      : {state, effect: {kind: 'notice', text: route.kind === 'tool' || listRoute ? 'Nothing to edit here.' : 'No file to edit for this section.'}};
  }
}
