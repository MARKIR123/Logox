import {readFileSync} from 'node:fs';
import {stripVTControlCharacters} from 'node:util';
import stringWidth from 'string-width';
import {z} from 'zod';
import type {StageStatus} from '../../runtime/stage-status.js';
import {allocateContext, contextCategories, type ContextCategory} from '../../context/breakdown.js';
import {defaultGaugeCells, defaultStatusbar, type StatusbarAppearance, type StatusbarId, type StatusbarModule} from '../../config/statusbar-preferences.js';
import {hexColorSchema, themeColorKeys, type ThemeColorKey} from '../../config/theme-palette.js';
import {permissionModes} from '../../runtime/permission-mode.js';
import {palette} from '../appearance/theme.js';
import {mixHex} from '../appearance/colors.js';

/** `widget` tags every cell that belongs to one module (hover and click target); `gauge` marks gauge cells for scheme remapping. */
export type StatusbarPart = {text: string; color?: string; backgroundColor?: string; bold?: boolean; widget?: StatusbarId; gauge?: 'used' | 'track' | 'tick'};
/** Half-open display-cell range one widget occupies on the status line; derived from the same plan that renders it. */
export interface WidgetRegion {readonly id: StatusbarId; readonly startX: number; readonly endX: number}
export interface StatusbarLayout {readonly parts: StatusbarPart[]; readonly regions: WidgetRegion[]; readonly width: number}
const schemeSchema = z.partialRecord(z.enum(themeColorKeys), hexColorSchema);
// Load shipped data once, never perform I/O while planning a status line.
const schemes = z.strictObject({gruvbox: schemeSchema, dracula: schemeSchema})
  .parse(JSON.parse(readFileSync(new URL('../../config/statusbar-palettes.json', import.meta.url), 'utf8')));
const graphemes = new Intl.Segmenter('en', {granularity: 'grapheme'});

function safeText(value: string): string {
  return stripVTControlCharacters(value).replace(/[\p{Cc}\u2028\u2029]|(?![\u200c\u200d])\p{Cf}/gu, '');
}
function clean(value: string): string {return safeText(value).replace(/\s+/gu, ' ').trim();}

/** Half-open display-cell range. A partially selected wide grapheme is omitted, never split. */
export function extractStatusBarSlice(text: string, colA: number, colB: number): string {
  if (!Number.isFinite(colA) || !Number.isFinite(colB)) return '';
  const start = Math.max(0, Math.floor(Math.min(colA, colB)));
  const end = Math.max(0, Math.floor(Math.max(colA, colB)));
  let column = 0, result = '';
  for (const {segment} of graphemes.segment(safeText(text))) {
    const next = column + stringWidth(segment);
    if (column >= start && next <= end) result += segment;
    column = next;
    if (column >= end) break;
  }
  return result.trim();
}

const stateLabels: Readonly<Record<string, string>> = {
  'Ready': 'ready', 'Running': 'running', 'Queued': 'queued',
  'Awaiting answer': 'waiting', 'Awaiting permission': 'approval', 'Paused': 'paused', 'Completed': 'completed',
  'Failed': 'failed', 'Stopped': 'cancelled', 'Interrupted': 'cancelled',
};
const effortTokens: Readonly<Record<string, ThemeColorKey>> = {
  off: 'effortOff', low: 'effortLow', medium: 'effortMedium', high: 'effortHigh', max: 'effortMax', auto: 'effortAuto',
};
/** Whole percent of the window; never rounds up to 100 (99.6 reads 99) and is capped there (see `contextOver`). */
export function usedPercent(status: StageStatus): number | undefined {
  const context = status.context;
  if (!context || !Number.isFinite(context.tokens) || !Number.isFinite(context.window) || context.window <= 0) return;
  const raw = Math.max(0, context.tokens / context.window * 100);
  return raw >= 100 ? 100 : Math.min(99, Math.round(raw));
}
export function contextOver(status: StageStatus): boolean {
  const context = status.context;
  return !!context && (context.over === true || context.window > 0 && context.tokens > context.window);
}
/** Five-step ramp of the window actor's colour, system (darkest) to tools (brightest). */
const RAMP_SHARES = [0.4, 0.55, 0.7, 0.85, 1] as const;
export function contextRamp(actor: string): Record<ContextCategory, string> {
  return Object.fromEntries(contextCategories.map((category, index) => [category, mixHex(actor, palette.bg, RAMP_SHARES[index]!)])) as Record<ContextCategory, string>;
}
export const gaugeTrack = (): string => mixHex(palette.muted, palette.bg, 0.22);
/** Percent text colour: muted until 10 points before the compaction watermark, warning below it, error at or above it. */
export function contextTone(status: StageStatus): 'muted' | 'warning' | 'error' {
  const context = status.context, used = usedPercent(status);
  if (!context || used === undefined) return 'muted';
  const high = context.high && context.window > 0 ? context.high / context.window * 100 : 80;
  return contextOver(status) || used >= high ? 'error' : used >= high - 10 ? 'warning' : 'muted';
}
type GaugeCell = ContextCategory | 'unknown' | 'free';
/** Cell plan of the gauge: the used span split by category (largest remainder), then free cells; `tick` is the watermark cell. */
export function gaugeCells(status: StageStatus, cells: number): {cells: GaugeCell[]; tick: number | undefined} | undefined {
  const context = status.context;
  if (!context || !(context.window > 0) || !Number.isFinite(context.tokens)) return;
  const used = context.tokens <= 0 ? 0 : Math.max(1, Math.min(cells, Math.round(context.tokens / context.window * cells)));
  const split = context.categories ? allocateContext(used, context.categories) : undefined;
  const list: GaugeCell[] = [];
  if (split) for (const category of contextCategories) for (let i = 0; i < split[category]; i++) list.push(category);
  while (list.length < used) list.push('unknown');
  while (list.length < cells) list.push('free');
  const tick = context.high && context.high > 0 ? Math.max(0, Math.min(cells - 1, Math.floor(context.high / context.window * cells))) : undefined;
  return {cells: list, tick};
}
function gaugeVariant(status: StageStatus, cells: number, actor: string): StatusbarPart[] {
  const plan = gaugeCells(status, cells)!, ramp = contextRamp(actor), track = gaugeTrack();
  const colorOf = (cell: GaugeCell) => cell === 'free' ? track : cell === 'unknown' ? ramp.tools : ramp[cell];
  const parts: StatusbarPart[] = [];
  plan.cells.forEach((cell, index) => {
    const color = colorOf(cell), kind = cell === 'free' ? 'track' : 'used';
    if (index === plan.tick) {parts.push({text: '┊', color: mixHex(palette.strong, palette.bg, 0.75), backgroundColor: color, gauge: 'tick'}); return;}
    const last = parts.at(-1);
    if (last && last.color === color && last.gauge === kind) last.text += '█'; else parts.push({text: '█', color, gauge: kind});
  });
  const used = usedPercent(status)!;
  parts.push({text: ' ' + (contextOver(status) ? '>' : status.context?.estimated ? '~' : '') + used + '%', color: palette[contextTone(status)]});
  return parts;
}
function contextVariants(status: StageStatus, env: Env): Variant[] {
  if (!gaugeCells(status, env.cells)) return [[{text: 'ctx N/A'}]];
  const sizes = env.cells > 8 ? [env.cells, 8] : [env.cells];
  return sizes.map(size => gaugeVariant(status, size, env.actor));
}
function gitVariants(status: StageStatus): Variant[] {
  const git = status.git;
  if (!git) return [];
  const branch = clean(git.branch);
  const marks = (git.dirty ? ' ●' + git.dirty : '') + (git.ahead ? ' ↑' + git.ahead : '') + (git.behind ? ' ↓' + git.behind : '');
  return unique([branch + marks, branch + (git.dirty ? ' ●' : ''), branch]).map(plain);
}
/** Whole-percent cache hit rate of the window actor: cache reads over all input tokens. */
export function cacheHitRate(status: StageStatus): number | undefined {
  const usage = status.usage?.window;
  if (!usage) return;
  const total = usage.input + usage.cached;
  return total > 0 ? Math.round(usage.cached / total * 100) : undefined;
}
function compactCount(value: number): string {return new Intl.NumberFormat('en-US', {notation: 'compact', maximumFractionDigits: 1}).format(value);}
function unique(values: readonly string[]): string[] {return [...new Set(values.map(clean).filter(Boolean))];}
/** Trailing date or channel suffixes carry little at a glance (`claude-sonnet-4-5-20250929` reads `claude-sonnet-4-5`). */
function shortModel(model: string): string {return model.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2}|latest|preview)$/u, '');}
type Variant = readonly StatusbarPart[];
const plain = (text: string): Variant => [{text}];
interface Env {readonly cells: number; readonly actor: string}
interface Descriptor {
  readonly icon: string;
  readonly token: ThemeColorKey | ((status: StageStatus) => ThemeColorKey);
  /** Variants from longest to shortest; each is whole (never truncated mid-word). An empty list hides the widget. */
  readonly build: (status: StageStatus, env: Env) => readonly Variant[];
}
const named = (value: string, prefix = ''): Variant[] => unique([prefix + clean(value), value]).map(plain);

/** Module IDs, data projection and semantic accents stay together; styles only arrange plans. */
const registry: Readonly<Record<StatusbarId, Descriptor>> = {
  role: {icon: '', token: 'accent', build: status => named(status.name)},
  model: {icon: '', token: 'question', build: status => {
    if (!status.model) return [plain('No model')];
    const model = clean(status.model.model);
    return unique([model, shortModel(model)]).map(plain);
  }},
  effort: {icon: '', token: status => effortTokens[status.effort ?? ''] ?? 'muted',
    build: status => {
      const effort = status.effort === 'Unsupported' ? 'unsupported' : status.effort === 'Unavailable' ? 'unavailable' : status.effort ?? 'unsupported';
      return [plain('Thinking ' + effort), plain(effort)];
    }},
  permission: {icon: '', token: status => {
    const mode = status.permission;
    return mode && Object.hasOwn(permissionModes, mode) ? permissionModes[mode as keyof typeof permissionModes].colorToken : 'muted';
  }, build: status => [plain('Permission ' + (status.permission ?? 'none')), plain(status.permission ?? 'none')]},
  context: {icon: '', token: 'muted', build: contextVariants},
  cache: {icon: '', token: 'muted', build: status => {
    const rate = cacheHitRate(status);
    return rate === undefined ? [] : [[{text: 'cache '}, {text: rate + '%', color: palette.fg}]];
  }},
  state: {icon: '', token: status => /fail|error/i.test(status.state) ? 'error' : /wait|paus|queue/i.test(status.state) ? 'warning' : 'success',
    build: status => [plain(stateLabels[status.state] ?? status.state)]},
  tokens: {icon: '', token: 'effortMedium', build: status => {
    const tokens = status.tokens;
    // Session total across every window: fresh input plus output, cache reads excluded.
    if (tokens === undefined || !Number.isFinite(tokens)) return [plain('Session tokens N/A'), plain('N/A')];
    return unique(['Session tokens ' + tokens.toLocaleString('en-US'), 'Tokens ' + tokens.toLocaleString('en-US'), tokens.toLocaleString('en-US'), compactCount(tokens)]).map(plain);
  }},
  // Hidden when nothing could be priced; `~` marks a partial figure (unpriced usage or a cache rate billed as input).
  cost: {icon: '', token: 'warning', build: status => {
    if (status.cost === undefined || !Number.isFinite(status.cost)) return [];
    const cost = (status.costPartial ? '~' : '') + (status.costCurrency ? status.costCurrency + ' ' : '') + status.cost.toFixed(4);
    return ['Session cost ' + cost, 'Cost ' + cost, cost].map(plain);
  }},
  session: {icon: '', token: 'strong', build: status => named(status.session ?? 'unsaved', 'Session ')},
  project: {icon: '', token: 'success', build: status => {
    if (!status.project) return [plain('Project N/A'), plain('N/A')];
    const path = clean(status.project), leaf = path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) ?? path;
    return unique([path, leaf]).map(plain);
  }},
  git: {icon: '', token: 'success', build: gitVariants},
};
/** Narrow-width priority: role first, then permission, the gauge, model, effort, cache, state, git, session, project and finally tokens and cost. */
export const statusbarPriority: readonly StatusbarId[] = ['role', 'permission', 'context', 'model', 'effort', 'cache', 'state', 'git', 'session', 'project', 'tokens', 'cost'];

export function statusbarText(status: StageStatus, width: number, modules: readonly StatusbarModule[] = defaultStatusbar, appearance: Partial<StatusbarAppearance> = {}): string {
  return statusbarParts(status, width, modules, appearance).map(part => part.text).join('');
}
export function statusbarParts(status: StageStatus, width: number, modules: readonly StatusbarModule[] = defaultStatusbar, appearance: Partial<StatusbarAppearance> = {}): StatusbarPart[] {
  return statusbarLayout(status, width, modules, appearance).parts;
}

/**
 * Every visible cell, including separators, padding and caps, belongs to this plan, and `regions` come from the same plan.
 * Widgets are admitted by priority at their shortest variant (whole widgets only, never fragments), then widened in
 * priority order while room remains, and finally drawn in the user's module order.
 */
export function statusbarLayout(status: StageStatus, width: number, modules: readonly StatusbarModule[] = defaultStatusbar,
  appearance: Partial<StatusbarAppearance> = {}, options: {readonly hovered?: StatusbarId | null} = {}): StatusbarLayout {
  if (!Number.isFinite(width) || width < 1) return {parts: [], regions: [], width: 0};
  const limit = Math.floor(width), starship = appearance.style === 'starship';
  const decorative = appearance.colorScheme === 'gruvbox' || appearance.colorScheme === 'dracula';
  const scheme = decorative ? schemes[appearance.colorScheme as 'gruvbox' | 'dracula'] : {};
  const colors = {...palette, ...scheme};
  const actor = hexColorSchema.safeParse(status.color).data ?? palette.accent;
  const env: Env = {cells: Math.max(8, Math.min(40, Math.floor(appearance.gaugeCells ?? defaultGaugeCells))), actor};
  const enabled = modules.filter((module, index) => module.enabled && Object.hasOwn(registry, module.id) && modules.findIndex(other => other.id === module.id) === index);
  const candidates = new Map<StatusbarId, {variants: Variant[]; icon: string; chosen: number}>();
  const widthOf = (id: StatusbarId, index: number): number => {
    const item = candidates.get(id)!;
    return stringWidth(item.icon) + item.variants[index]!.reduce((sum, part) => sum + stringWidth(part.text), 0);
  };
  for (const {id} of enabled) {
    const descriptor = registry[id], icon = descriptor.icon ? descriptor.icon + ' ' : '';
    const variants = descriptor.build(status, env).map(variant => variant.map(part => ({...part, text: safeText(part.text).replace(/\s+/gu, ' ')})))
      .filter(variant => variant.some(part => part.text.trim()));
    if (variants.length) candidates.set(id, {variants, icon, chosen: variants.length - 1});
  }
  // Admission: priority order, shortest variant first; a widget that does not fit whole is dropped.
  const admitted: StatusbarId[] = [];
  const framing = (count: number) => count === 0 ? 0 : starship ? count * 3 + 1 : (count - 1) * 3;
  const total = (ids: readonly StatusbarId[]) => ids.reduce((sum, id) => sum + widthOf(id, candidates.get(id)!.chosen), 0) + framing(ids.length);
  for (const id of statusbarPriority) {
    if (!candidates.has(id)) continue;
    // Strict priority: once a widget does not fit whole, nothing less important is shown either.
    if (total([...admitted, id]) > limit) break;
    admitted.push(id);
  }
  // Widening: longest variant that still fits, most important widget first.
  for (const id of statusbarPriority) {
    const item = candidates.get(id);
    if (!item || !admitted.includes(id)) continue;
    const shortest = item.chosen;
    for (let index = 0; index < shortest; index++) {
      item.chosen = index;
      if (total(admitted) <= limit) break;
      item.chosen = shortest;
    }
  }
  const ordered = enabled.map(module => module.id).filter(id => admitted.includes(id));
  const faint = mixHex(palette.muted, palette.bg, 0.55);
  const hoverBg = mixHex(actor, palette.bg, starship ? 0.32 : 0.16);
  const tokenOf = (id: StatusbarId): ThemeColorKey => {
    const token = registry[id].token;
    return typeof token === 'function' ? token(status) : token;
  };
  // Decorative schemes must not recolor Actor identity or permission-mode semantics.
  const colorOf = (id: StatusbarId) => id === 'role' ? actor : id === 'permission' ? palette[tokenOf(id)] : colors[tokenOf(id)];
  const parts: StatusbarPart[] = [], regions: WidgetRegion[] = [];
  let x = 0;
  const push = (part: StatusbarPart) => {parts.push(part); x += stringWidth(part.text);};
  const slateSteps = [0.12, 0.15, 0.18, 0.12];
  let slate = 0;
  const looks = ordered.map(id => {
    const hovered = options.hovered === id;
    if (decorative) return {bg: hovered ? hoverBg : colorOf(id), fg: colors.bg};
    if (id === 'role') return {bg: hovered ? hoverBg : mixHex(actor, palette.bg, 0.3), fg: mixHex(actor, palette.strong, 0.9)};
    const step = slateSteps[slate++ % slateSteps.length]!;
    return {bg: hovered ? hoverBg : mixHex(palette.muted, palette.bg, step), fg: id === 'permission' ? colorOf(id) : mixHex(palette.fg, palette.muted, 0.7)};
  });
  ordered.forEach((id, index) => {
    const item = candidates.get(id)!, variant = item.variants[item.chosen]!, look = looks[index]!;
    const hovered = options.hovered === id;
    const start = x;
    if (starship) {
      if (index === 0) push({text: '', color: look.bg, widget: id});
      push({text: ' ', color: look.fg, backgroundColor: look.bg, widget: id});
    } else if (index > 0) push({text: decorative ? ' | ' : ' │ ', color: decorative ? colors.muted : faint});
    const base = starship ? look.fg : id === 'role' ? actor : id === 'permission' ? colorOf(id) : decorative ? colorOf(id) : palette.muted;
    const bg = starship ? look.bg : hovered ? hoverBg : undefined;
    const emit = (part: StatusbarPart) => {
      let color = part.color ?? base;
      if (starship && decorative && part.gauge === 'used') color = look.fg;
      else if (starship && decorative && part.gauge === 'track') color = mixHex(look.fg, look.bg, 0.45);
      push({text: part.text, color, widget: id, ...(part.backgroundColor ? {backgroundColor: part.backgroundColor} : bg ? {backgroundColor: bg} : {}),
        ...(part.bold || id === 'role' ? {bold: true} : {}), ...(part.gauge ? {gauge: part.gauge} : {})});
    };
    // The icon shares the first run so a widget starts with one coloured part.
    variant.forEach((part, at) => emit(at === 0 && item.icon ? {...part, text: item.icon + part.text} : part));
    if (starship) {
      push({text: ' ', color: look.fg, backgroundColor: look.bg, widget: id});
      const next = looks[index + 1];
      push(next ? {text: '', color: look.bg, backgroundColor: next.bg, widget: id} : {text: '', color: look.bg, widget: id});
    }
    regions.push({id, startX: start, endX: x});
  });
  return {parts, regions, width: x};
}
