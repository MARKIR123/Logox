import stringWidth from 'string-width';
import type {ToolUI} from '../../ui-types.js';
import {callArgs} from '../../ui-format.js';
import {createToolUI, messageToolCall} from '../../../tui/timeline/tool-ui.js';
import {cardTitle, renderToolCard, summaryPiece, wrapText, type ToolLine, type ToolView} from '../../../tui/timeline/tool-card.js';
import type {SceneSegment} from '../../../tui/timeline/scene.js';
import {palette} from '../../../tui/appearance/theme.js';
import {faintColor} from '../../../tui/appearance/colors.js';

/**
 * Plan card: the model reads the compact runtime answer (`PlanTool.ts:executePlan`); the person reads this view of the same text. One row per step
 * with a status glyph, its owner and what it waits for (by title), a plan title and `N of M done`. Internal ids (`p2`, `1.1`) never appear: they
 * only order and indent the steps, and resolve `after` references to titles.
 */

interface Step {
  /** The runtime id, used only to indent and to resolve references; never shown. */
  readonly id: string;
  readonly title: string;
  readonly owner: string;
  readonly status: string;
  readonly after: readonly string[];
  /** `done/total` of the children, from the outline. */
  readonly progress?: string;
  readonly details: readonly string[];
}
type Block =
  | {readonly kind: 'heading'; readonly text: string}
  | {readonly kind: 'plan'; readonly title: string}
  | {readonly kind: 'step'; readonly step: Step}
  | {readonly kind: 'text'; readonly text: string};

const ID = '\\d+(?:\\.\\d+){0,2}';
const LABEL = new RegExp(`^(${ID}) (.+) \\(([^()\\s]+)\\)$`);
const SPLIT_LABELS = new RegExp(`; (?=${ID} )`);
const NODE = new RegExp(`^(\\s*)(${ID}) (.+) \\[(\\w+)\\] (\\S+)(?: after ([\\d.,]+))?(?: (\\d+)/(\\d+))?$`);
const depth = (id: string) => id.split('.').length;

/** `techne` -> `Techne`. */
export const ownerName = (owner: string): string => owner ? owner[0]!.toUpperCase() + owner.slice(1) : owner;

const GLYPH: Readonly<Record<string, {glyph: string; color: () => string; note?: string}>> = {
  pending: {glyph: '○', color: () => palette.muted},
  ready: {glyph: '○', color: () => palette.fg},
  running: {glyph: '●', color: () => palette.accent, note: 'working'},
  waiting: {glyph: '◌', color: () => palette.muted, note: 'waiting for a teammate'},
  done: {glyph: '✓', color: () => palette.success, note: 'finished, awaiting acceptance'},
  accepted: {glyph: '✓', color: () => palette.success},
  failed: {glyph: '✗', color: () => palette.error, note: 'failed'},
  interrupted: {glyph: '◐', color: () => palette.warning, note: 'interrupted'},
  abandoned: {glyph: '–', color: () => faintColor(), note: 'dropped'},
  removed: {glyph: '–', color: () => faintColor(), note: 'removed'},
};

function labelSteps(text: string, status: string): Block[] {
  return text.split(SPLIT_LABELS).map((part): Block => {
    const match = LABEL.exec(part.trim());
    return match ? {kind: 'step', step: {id: match[1]!, title: match[2]!, owner: match[3]!, status, after: [], details: []}} : {kind: 'text', text: part};
  });
}

/** The blocks of a result text, line by line (a multi-op call is the lines of its ops in order). */
export function planBlocks(result: string): {blocks: Block[]; progress?: string} {
  const blocks: Block[] = [];
  let progress: string | undefined;
  let last: {step: Step} | undefined;
  const push = (block: Block) => {blocks.push(block); last = block.kind === 'step' ? block : undefined;};
  const detail = (text: string) => {
    if (!last) return false;
    const index = blocks.indexOf(last as Block);
    blocks[index] = {kind: 'step', step: {...last.step, details: [...last.step.details, text]}};
    last = blocks[index] as {step: Step};
    return true;
  };
  for (const raw of result.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    let match: RegExpExecArray | null;
    if ((match = /^Plan \S+ is (\w+): (\d+)\/(\d+) top-level nodes accepted\.$/.exec(line))) {
      progress = match[1] === 'abandoned' ? 'abandoned' : match[1] === 'done' || match[2] === match[3] ? `all ${match[3]} done` : `${match[2]} of ${match[3]} done`;
    } else if ((match = /^Plan \S+ "(.*)" \[(\w+)\] (\d+)\/(\d+) accepted$/.exec(line))) {
      push({kind: 'plan', title: match[1]!});
      progress = match[2] === 'abandoned' ? 'abandoned' : match[2] === 'done' || match[3] === match[4] ? `all ${match[4]} done` : `${match[3]} of ${match[4]} done`;
    } else if ((match = /^Created plan \S+ "(.*?)"(?: with (.*))?\.$/.exec(line))) {
      push({kind: 'plan', title: match[1]!});
      if (match[2]) for (const block of labelSteps(match[2], 'pending')) push(block);
    } else if ((match = /^Added (.*)\.$/.exec(line))) {
      push({kind: 'heading', text: 'Added to the plan'});
      for (const block of labelSteps(match[1]!, 'pending')) push(block);
    } else if ((match = /^Updated (.*)\.$/.exec(line))) {
      push({kind: 'heading', text: 'Updated'});
      for (const block of labelSteps(match[1]!, 'pending')) push(block);
    } else if ((match = /^Removed (.*?)(?: and (\d+) below it)?\.$/.exec(line))) {
      push({kind: 'heading', text: match[2] ? `Removed, with ${match[2]} below it` : 'Removed'});
      for (const block of labelSteps(match[1]!, 'removed')) push(block);
    } else if ((match = /^Accepted (.*)\.$/.exec(line))) {
      push({kind: 'heading', text: 'Accepted'});
      for (const block of labelSteps(match[1]!, 'accepted')) push(block);
    } else if ((match = /^Reopened (.*)\.$/.exec(line))) {
      push({kind: 'heading', text: 'Reopened'});
      for (const block of labelSteps(match[1]!, 'pending')) push(block);
    } else if ((match = /^Abandoned plan \S+ "(.*)"\.$/.exec(line))) {
      push({kind: 'text', text: `Plan dropped: ${match[1]}`});
    } else if ((match = /^Abandoned (.*)\.$/.exec(line)) && LABEL.test(match[1]!)) {
      push({kind: 'heading', text: 'Dropped'});
      for (const block of labelSteps(match[1]!, 'abandoned')) push(block);
    } else if ((match = NODE.exec(line))) {
      push({kind: 'step', step: {id: match[2]!, title: match[3]!, owner: match[5]!, status: match[4]!, after: match[6] ? match[6].split(',') : [],
        ...(match[7] ? {progress: `${match[7]} of ${match[8]}`} : {}), details: []}});
    } else if ((match = /^\s*- (acceptance|note|accepted by (\S+)): (.*)$/.exec(line)) && last) {
      detail(match[1] === 'acceptance' ? `Done when: ${match[3]}` : match[1] === 'note' ? `Note: ${match[3]}` : `Accepted by ${ownerName(match[2]!)}: ${match[3]}`);
    } else push({kind: 'text', text: line});
  }
  return {blocks, ...(progress ? {progress} : {})};
}

/** `after` references the call named, by the title they were written under: node title -> referenced ids. */
function afterFromCall(args: Record<string, unknown>): {byTitle: Map<string, string[]>; byId: Map<string, string[]>} {
  const byTitle = new Map<string, string[]>(), byId = new Map<string, string[]>();
  const refs = (value: unknown): string[] => Array.isArray(value) ? value.map(String) : [];
  const walk = (nodes: unknown) => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      const item = node as Record<string, unknown>;
      if (typeof item.title === 'string' && refs(item.after).length) byTitle.set(item.title.trim(), refs(item.after));
      walk(item.nodes);
    }
  };
  const ops = Array.isArray(args.ops) ? args.ops as Record<string, unknown>[] : [args];
  for (const op of ops) {
    if (!op || typeof op !== 'object') continue;
    walk(op.nodes);
    if (typeof op.id === 'string' && refs(op.after).length) byId.set(op.id, refs(op.after));
  }
  return {byTitle, byId};
}

/** One step: glyph, title wrapped under itself, then `owner · waits for … · progress · state` on the last row (its own row when it does not fit). */
function stepRows(step: Step, width: number, titles: ReadonlyMap<string, string>): ToolLine[] {
  const style = GLYPH[step.status] ?? GLYPH.pending!;
  const indent = '  '.repeat(Math.min(depth(step.id) - 1, 2));
  const waits = step.after.map(ref => titles.get(ref)).filter((title): title is string => Boolean(title));
  const meta = [ownerName(step.owner), ...(waits.length ? [`after ${waits.map(title => `"${title}"`).join(', ')}`] : []),
    ...(step.progress ? [`${step.progress} done`] : []), ...(style.note && !(step.status === 'pending') ? [style.note] : [])].join(' · ');
  const gutter = indent + '  ';
  const rows = wrapText(step.title, Math.max(12, width - stringWidth(gutter)));
  const struck = step.status === 'abandoned' || step.status === 'removed';
  const out: ToolLine[] = rows.map((row, index): ToolLine => ({segments: index === 0
    ? [{text: indent}, {text: style.glyph + ' ', color: style.color()}, {text: row, color: struck ? faintColor() : palette.fg}]
    : [{text: gutter}, {text: row, color: struck ? faintColor() : palette.fg}]}));
  const tail: SceneSegment = {text: meta, color: palette.muted};
  const lastWidth = stringWidth(gutter + rows.at(-1)!);
  if (meta && lastWidth + 3 + stringWidth(meta) <= width) {
    const final = out.pop()!;
    out.push({segments: [...final.segments!, {text: ' · ', color: faintColor()}, tail]});
  } else if (meta) for (const row of wrapText(meta, Math.max(12, width - stringWidth(gutter)))) out.push({segments: [{text: gutter}, {text: row, color: palette.muted}]});
  for (const item of step.details) for (const row of wrapText(item, Math.max(12, width - stringWidth(gutter) - 2))) out.push({segments: [{text: gutter + '  '}, {text: row, color: faintColor()}]});
  return out;
}

/** The human view of a Plan result; `args` (the call) only supplies what the result text leaves out: what a new step waits for. */
export function planView(result: string, args: Record<string, unknown> = {}): ToolView {
  const {blocks, progress} = planBlocks(result);
  if (!blocks.length) return {body: {lines: [], empty: 'No plan'}};
  const call = afterFromCall(args);
  const resolved = blocks.map((block): Block => {
    if (block.kind !== 'step' || block.step.after.length) return block;
    const refs = call.byId.get(block.step.id) ?? call.byTitle.get(block.step.title);
    return refs ? {kind: 'step', step: {...block.step, after: refs}} : block;
  });
  const titles = new Map<string, string>();
  for (const block of resolved) if (block.kind === 'step') titles.set(block.step.id, block.step.title);
  const lines = (width: number): ToolLine[] => resolved.flatMap((block): ToolLine[] => {
    if (block.kind === 'plan') return [{segments: [{text: block.title, color: palette.fg, bold: true}]}];
    if (block.kind === 'heading') return [{segments: [{text: block.text, color: faintColor()}]}];
    if (block.kind === 'text') return wrapText(block.text, width).map(prose => ({segments: [{text: prose, color: palette.muted}]}));
    return stepRows(block.step, width, titles);
  });
  return {...(progress ? {summary: [summaryPiece(progress, progress.startsWith('all') ? 'success' : 'muted')]} : {}), body: {lines}};
}

export const UI: ToolUI = {
  ...createToolUI(['op', 'title']),
  render(context) {
    const call = context.call ?? messageToolCall(context.message);
    if (!call) return;
    const args = callArgs(call);
    renderToolCard(context, {title: cardTitle(context, call), view: result => planView(result, args)});
  },
};
