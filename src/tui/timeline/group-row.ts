import stringWidth from 'string-width';
import {palette} from '../appearance/theme.js';
import type {ActivityVerbs} from '../appearance/actor-style.js';
import {clipLine} from '../terminal/text.js';
import type {Message, Step} from '../../runtime/contracts.js';
import type {ToolGroup, ToolGroupCategory} from './tool-groups.js';
import {insetFrame, type createBuilder, type FrameWrap, type SceneRow, type SceneSegment} from './scene.js';

/** A running tool row stays on screen at least this long so fast calls do not flicker. */
export const ROW_MIN_MS = 700;
const SEP = ' · ';

export type VerbCategory = 'search' | 'read' | 'list' | 'browse' | 'run';

/** Generic pool for crafted actors and installed profiles that predate `activity_verbs`. */
export const defaultActivityVerbs: Readonly<Record<VerbCategory, readonly string[]>> = {
  search: ['Searching/Searched', 'Scanning/Scanned', 'Looking up/Looked up'],
  read: ['Reading/Read', 'Reviewing/Reviewed', 'Opening/Opened'],
  list: ['Listing/Listed', 'Mapping/Mapped'],
  browse: ['Browsing/Browsed', 'Viewing/Viewed'],
  run: ['Running/Ran', 'Executing/Executed'],
};
const nouns: Readonly<Record<VerbCategory, readonly [string, string]>> = {
  search: ['pattern', 'patterns'], read: ['file', 'files'], list: ['directory', 'directories'],
  browse: ['page action', 'page actions'], run: ['command', 'commands'],
};
const order: readonly VerbCategory[] = ['search', 'read', 'list', 'browse', 'run'];
/** Categories shed first when the header is too wide; search, read and run survive longest. */
const dropOrder: readonly VerbCategory[] = ['list', 'browse', 'run', 'read', 'search'];
const verbCategory = (category: ToolGroupCategory): VerbCategory => category === 'command' ? 'run' : category;

/** FNV-1a: the same group and category always pick the same word, on every frame and re-render. */
function stableIndex(key: string, size: number): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index++) hash = Math.imul(hash ^ key.charCodeAt(index), 0x01000193) >>> 0;
  return hash % size;
}
/** Pools are `Gerund/Past` entries; categories missing from the actor's own pool use the defaults. */
export function groupVerb(groupId: string, category: VerbCategory, running: boolean, verbs?: ActivityVerbs | undefined): string {
  const pool = verbs?.[category]?.length ? verbs[category]! : defaultActivityVerbs[category];
  const entry = pool[stableIndex(groupId + category, pool.length)]!;
  const slash = entry.indexOf('/');
  return (running ? entry.slice(0, slash) : entry.slice(slash + 1)).trim();
}

export function seconds(ms: number): string {
  const s = ms / 1000;
  return s < 60 ? s.toFixed(1) + 's' : Math.floor(s / 60) + 'm' + String(Math.floor(s % 60)).padStart(2, '0') + 's';
}
function fit(text: string, width: number): string {
  if (width <= 0) return '';
  if (stringWidth(text) <= width) return text;
  return clipLine(text, Math.max(0, width - 1)).trimEnd() + '…';
}

/** Tool calls shown as `└` rows under a collapsed running group: running ones, each kept at least ROW_MIN_MS. */
const seen = new Map<string, Map<string, number>>();
export function visibleRunningCalls(group: ToolGroup, now = Date.now()): readonly Message[] {
  if (!group.running) { seen.delete(group.id); return []; }
  const since = seen.get(group.id) ?? new Map<string, number>();
  seen.set(group.id, since);
  const shown: Message[] = [];
  for (const message of group.messages) {
    if (message.kind !== 'tool') continue;
    if (message.step?.state === 'running') {
      if (!since.has(message.id)) since.set(message.id, now);
      shown.push(message);
    } else if (since.has(message.id)) {
      if (now - since.get(message.id)! < ROW_MIN_MS) shown.push(message); else since.delete(message.id);
    }
  }
  return shown;
}

/** Live clock for a running group: finished calls plus the running calls' own clock. */
function runningStep(group: ToolGroup, title: string): Step {
  let elapsedMs = 0;
  let runningSince = Infinity;
  for (const message of group.messages) {
    const step = message.step;
    if (!step) continue;
    elapsedMs += step.elapsedMs;
    if (step.state === 'running') runningSince = Math.min(runningSince, step.runningSince ?? Infinity);
  }
  return {state: 'running', title, elapsedMs, ...(Number.isFinite(runningSince) ? {runningSince} : {})} as Step;
}

export interface ToolGroupRow {
  readonly titleSegments: readonly SceneSegment[];
  readonly status: string;
  readonly step?: Step;
}

/**
 * Header: `▸ Scouting 2 patterns · Examining 3 files · 2.4s` (gerunds while running, past forms after).
 * The elapsed time always survives; when the row is too wide whole categories drop (list, browse, then run, read, search) and one `…` closes it.
 * `width` is the room inside the card (after its own inset).
 */
export function toolGroupRow(group: ToolGroup, opts: {id: string; open: boolean; width: number; verbs?: ActivityVerbs | undefined}): ToolGroupRow {
  const running = group.running;
  const lead = opts.open ? '▾ ' : '▸ ';
  const status = running ? '' : group.elapsedMs > 0 ? seconds(group.elapsedMs) : '';
  const reserve = running ? SEP.length + 7 : status ? SEP.length + status.length : 0;
  const parts = order.flatMap(category => {
    const count = group.counts[category === 'run' ? 'command' : category] ?? 0;
    if (!count) return [];
    return [{category, text: `${groupVerb(group.id, category, running, opts.verbs)} ${count} ${nouns[category][count === 1 ? 0 : 1]}`}];
  });
  const room = Math.max(1, opts.width - reserve - lead.length);
  const kept = new Set(parts.map(part => part.category));
  const joined = () => parts.filter(part => kept.has(part.category)).map(part => part.text).join(SEP) + (kept.size < parts.length ? SEP + '…' : '');
  for (const category of dropOrder) {
    if (kept.size <= 1 || stringWidth(joined()) <= room) break;
    kept.delete(category);
  }
  const body = fit(joined(), room);
  // Running groups read white (palette.fg) and finished ones muted; the whole title row is italic and shimmers as one.
  const tone = running ? palette.fg : palette.muted;
  const titleSegments: SceneSegment[] = [{text: lead + body, color: tone, italic: true, selectionKey: opts.id + ':title', selectionOffset: 0}];
  return {titleSegments, status, ...(running ? {step: runningStep(group, lead + body)} : {})};
}

/** Turns the first row of a rendered tool card into `└ ▮ ...` by swapping its left inset for the connector. */
export function connect(rows: SceneRow[], index: number, insetIndex: number): void {
  const row = rows[index];
  const segment = row?.segments?.[insetIndex];
  if (!row?.segments || !segment || !/^ +$/.test(segment.text)) return;
  const segments = row.segments.map((item, at) => at === insetIndex ? {...item, text: '└' + ' '.repeat(segment.text.length - 1), color: palette.muted} : item);
  rows[index] = {...row, segments, displayText: segments.map(item => item.text).join('')};
}

/** Renders a tool group as one expandable card; the caller supplies how tool calls render. */
export function pushToolGroupCard(builder: ReturnType<typeof createBuilder>, group: ToolGroup, opts: {
  ownerId: string; open: boolean; railColor: string; parentFrame?: FrameWrap | undefined; verbs?: ActivityVerbs | undefined;
  renderChild(message: ToolGroup['messages'][number], frame: FrameWrap): void; now?: number;
}): void {
  const parentWidth = opts.parentFrame?.innerWidth ?? builder.contentWidth;
  const row = toolGroupRow(group, {id: group.id, open: opts.open, width: Math.max(1, parentWidth - 4), verbs: opts.verbs});
  builder.pushOrdinaryCard({
    id: group.id, ownerId: opts.ownerId, kind: 'Tool', title: row.titleSegments[0]!.text, titleSegments: row.titleSegments,
    status: row.status, bodyLines: [], open: opts.open, railColor: opts.railColor, expandable: true,
    ...(row.step ? {step: row.step} : {}),
    ...(opts.parentFrame ? {parentFrame: opts.parentFrame} : {}),
    renderBody(inner) { for (const message of group.messages) opts.renderChild(message, inner); },
    renderAfterHeader(frame) {
      // Collapsed only: each running call shows as its real tool row behind a `└`; expanded groups list them as children.
      const calls = visibleRunningCalls(group, opts.now);
      if (!calls.length) return;
      const indented = insetFrame(frame, frame.bg);
      for (const call of calls) {
        const from = builder.rows.length;
        opts.renderChild(call, indented);
        if (builder.rows.length > from) connect(builder.rows, from, indented.leftSegments.length - 1);
      }
    },
  });
}

/** Stage line above the group a `⏵` narration opened; the model's `⏵` marker never reaches the screen, the role symbol leads instead. */
export function pushGroupStage(builder: ReturnType<typeof createBuilder>, group: ToolGroup, railColor: string, accent: string, symbol: string, frame?: FrameWrap): void {
  if (!group.stage) return;
  const f: FrameWrap = frame ?? {leftSegments: [], rightSegments: [], leftCols: 0, rightCols: 0, innerWidth: builder.contentWidth};
  builder.pushFramedLine(group.id + '-stage', railColor, [
    {text: symbol + ' ', color: accent, bold: true, selectionKey: group.id + ':stage_symbol'},
    {text: fit(group.stage, Math.max(1, f.innerWidth - stringWidth(symbol) - 1)), color: palette.fg, selectionKey: group.id + ':stage_text'},
  ], f);
}
