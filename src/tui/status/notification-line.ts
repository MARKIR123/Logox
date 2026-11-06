import stringWidth from 'string-width';
import {contextCategories, type ContextCategory} from '../../context/breakdown.js';
import type {StatusbarId} from '../../config/statusbar-preferences.js';
import type {StageStatus} from '../../runtime/stage-status.js';
import {permissionModes} from '../../runtime/permission-mode.js';
import {palette} from '../appearance/theme.js';
import {mixHex} from '../appearance/colors.js';
import {cacheHitRate, contextOver, contextRamp, contextTone} from './statusbar.js';

/** One styled run of the notification line (row 2 of the footer). */
export interface NoteSegment {readonly text: string; readonly color?: string; readonly bold?: boolean; readonly italic?: boolean}
export type NoticeTone = 'success' | 'warning' | 'error' | 'info';
export interface Notice {readonly text: string; readonly tone: NoticeTone}

const faint = () => mixHex(palette.muted, palette.bg, 0.6);
const dim = (text: string): NoteSegment => ({text, color: palette.muted});
const value = (text: string, color: string = palette.fg): NoteSegment => ({text, color, bold: true});
const dot: () => NoteSegment = () => ({text: ' · ', color: faint()});
const click = (verb: string): NoteSegment => ({text: verb, color: palette.muted, italic: true});

/** `9.2k`, `121k`, `1.4M`: compact token counts for detail text. */
export function formatTokens(count: number, fixed = false): string {
  if (!Number.isFinite(count)) return '?';
  const n = Math.max(0, Math.round(count));
  const trim = (text: string) => fixed ? text : text.replace(/[.]0+(?=[kM]$)/u, '');
  if (n < 1000) return String(n);
  if (n < 1_000_000) return trim((n / 1000).toFixed(n < 100_000 ? 1 : 0) + 'k');
  return trim((n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1) + 'M');
}
/** Per-million price: `$5`, `$0.5`, `EUR 2.5`. */
function formatRate(rate: number, currency: string | undefined): string {
  const amount = String(+rate.toFixed(4));
  return !currency || currency === 'USD' ? '$' + amount : currency + ' ' + amount;
}
function join(groups: readonly (readonly NoteSegment[])[]): NoteSegment[] {
  const out: NoteSegment[] = [];
  groups.filter(group => group.length).forEach((group, index) => {if (index) out.push(dot()); out.push(...group);});
  return out;
}

const categoryAbbreviation: Readonly<Record<ContextCategory, string>> = {system: 'sys', prompt: 'pr', assistant: 'ast', thinking: 'th', tools: 'tl'};
const share = (amount: number, window: number): string => {
  const percent = window > 0 ? amount / window * 100 : 0;
  return (amount > 0 && percent < 1 ? '<1' : String(Math.round(percent))) + '%';
};
const flatWidth = (segments: readonly NoteSegment[]): number => segments.reduce((sum, segment) => sum + stringWidth(segment.text), 0);
/** Context gauge detail in percentages of the window; variants from longest to shortest, the first that fits `width` wins (never clipped with an ellipsis). */
function contextDetail(status: StageStatus, actor: string, width?: number): NoteSegment[] {
  const context = status.context;
  if (!context) return [dim('ctx '), value('not measured yet')];
  const ramp = contextRamp(actor), window = context.window, tilde = context.estimated ? '~' : '';
  const percent = share(context.tokens, window);
  const ratio = context.high ? Math.round(context.high / window * 100) + '%' : '';
  const tone = palette[contextOver(status) ? 'error' : contextTone(status) === 'muted' ? 'fg' : contextTone(status)];
  const compacts = (full: boolean): NoteSegment[] => context.high ? [dim(full ? 'compacts at ' : 'compacts '), value(ratio, tone)] : [];
  const categories = (full: boolean): NoteSegment[][] => {
    const out: NoteSegment[][] = [];
    if (context.categories) for (const category of contextCategories) {
      const amount = context.categories[category];
      if (amount > 0) out.push([{text: '▌', color: ramp[category]}, dim((full ? category : categoryAbbreviation[category]) + ' '), value(share(amount, window))]);
    }
    return out;
  };
  const free: NoteSegment[] = [{text: '▌', color: mixHex(palette.muted, palette.bg, 0.22)}, dim('free '), value(share(Math.max(0, window - context.tokens), window))];
  const head = [dim('ctx '), value(tilde + formatTokens(context.tokens)), dim('/' + formatTokens(window) + ' '), value(percent)];
  const variants: NoteSegment[][] = [];
  if (categories(true).length) {
    variants.push(join([head, ...categories(true), free, compacts(true)]));
    variants.push(join([head, ...categories(false), free, compacts(false)]));
    variants.push(join([head, ...categories(false), compacts(false)]));
  }
  variants.push(join([head, compacts(false)]));
  variants.push(join([[dim('ctx '), value(tilde + percent)], compacts(false)]));
  return (width === undefined ? variants[0] : variants.find(variant => flatWidth(variant) <= width) ?? variants[variants.length - 1])!;
}
function modelDetail(status: StageStatus): NoteSegment[] {
  if (!status.model) return [dim('No model selected'), dot(), click('click to change')];
  const info = status.modelInfo;
  const groups: NoteSegment[][] = [[value(status.model.model)], [dim(status.model.provider)]];
  if (info?.window) groups.push([dim('window '), value(formatTokens(info.window))]);
  if (info?.maxOutput) groups.push([dim('max out '), value(formatTokens(info.maxOutput))]);
  if (info && (info.input !== undefined || info.output !== undefined)) {
    const rates = [info.input, info.output].filter((rate): rate is number => rate !== undefined).map(rate => formatRate(rate, info.currency));
    groups.push([dim(rates.join(' / ') + ' per M' + (info.subscription ? ' (API-equivalent)' : ''))]);
  }
  if (info?.cacheRead !== undefined) groups.push([dim('cache read ' + formatRate(info.cacheRead, info.currency))]);
  groups.push([click('click to change')]);
  return join(groups);
}
function tokensDetail(status: StageStatus): NoteSegment[] {
  const session = status.usage?.session, window = status.usage?.window;
  if (!session) return [dim('session tokens '), value(status.tokens === undefined ? 'N/A' : status.tokens.toLocaleString('en-US'))];
  const split = (totals: {input: number; output: number; cached: number}) => [dim('in '), value(formatTokens(totals.input)), dim(' out '), value(formatTokens(totals.output)), dim(' cached '), value(formatTokens(totals.cached))];
  const groups: NoteSegment[][] = [[dim('session '), ...split(session)]];
  if (window) groups.push([dim('this window '), ...split(window)]);
  return join(groups);
}
function costDetail(status: StageStatus): NoteSegment[] {
  if (status.cost === undefined) return [dim('No price known for the models used')];
  const amount = (status.costPartial ? '~' : '') + (status.costCurrency ? status.costCurrency + ' ' : '') + status.cost.toFixed(4);
  const groups: NoteSegment[][] = [[dim('session cost '), value(amount)]];
  if (status.modelInfo?.subscription) groups.push([dim('API-equivalent, not billed on a subscription')]);
  if (status.costPartial) groups.push([dim('partial: some usage is unpriced or billed at the input rate')]);
  return join(groups);
}
function gitDetail(status: StageStatus): NoteSegment[] {
  const git = status.git;
  if (!git) return [dim('Not a git repository')];
  const groups: NoteSegment[][] = [[dim('branch '), value(git.branch)], [git.dirty ? value(String(git.dirty), palette.warning) : dim('clean'), ...(git.dirty ? [dim(' changed')] : [])]];
  if (git.ahead) groups.push([value('↑' + git.ahead, palette.success), dim(' ahead')]);
  if (git.behind) groups.push([value('↓' + git.behind, palette.warning), dim(' behind')]);
  return join(groups);
}

/** Row-2 detail of the hovered status widget. Click actions are named here and executed by `widgetCommand`. */
export function widgetDetail(id: StatusbarId, status: StageStatus, actor: string = status.color ?? palette.accent, width?: number): NoteSegment[] {
  switch (id) {
    case 'context': return contextDetail(status, actor, width);
    case 'model': return modelDetail(status);
    case 'permission': {
      const mode = status.permission, known = mode && Object.hasOwn(permissionModes, mode) ? permissionModes[mode as keyof typeof permissionModes] : undefined;
      return join([[value(mode ?? 'none', known ? palette[known.colorToken] : palette.fg), ...(known ? [dim(' — ' + known.description)] : [])], [click('click to change')]]);
    }
    case 'effort': return join([[dim('thinking effort '), value(status.effort ?? 'unsupported')], [click('click to change')]]);
    case 'cache': {
      const usage = status.usage?.window, rate = cacheHitRate(status);
      return !usage || rate === undefined ? [dim('No cache data yet')]
        : join([[dim('cache hit '), value(rate + '%')], [dim(formatTokens(usage.cached) + ' cached of ' + formatTokens(usage.input + usage.cached) + ' input tokens in this window')]]);
    }
    case 'tokens': return tokensDetail(status);
    case 'cost': return costDetail(status);
    case 'git': return gitDetail(status);
    case 'role': return join([[value(status.name, status.color ?? palette.accent)], [dim(status.state)]]);
    case 'state': return join([[dim('run state '), value(status.state)]]);
    case 'session': return join([[dim('session '), value(status.session ?? 'unsaved')]]);
    case 'project': return join([[dim('project '), value(status.project ?? 'N/A')]]);
  }
}
/** Slash command a click on the widget runs for the window, or undefined when the widget is read-only. */
export function widgetCommand(id: StatusbarId): string | undefined {
  return id === 'model' ? '/model' : id === 'permission' ? '/permissions' : id === 'effort' ? '/effort' : undefined;
}

export interface PillDetailInput {
  readonly symbol: string; readonly name: string; readonly color?: string | undefined; readonly title?: string | undefined;
  readonly stage: string; readonly elapsedMs?: number | undefined; readonly contextPercent?: number | undefined;
}
function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? seconds + 's' : Math.floor(seconds / 60) + 'm ' + String(seconds % 60).padStart(2, '0') + 's';
}
/** `<symbol> Name · <task title> · <stage or wait state> · <elapsed> · ctx NN%` · `click to open`. */
export function pillDetail(input: PillDetailInput): NoteSegment[] {
  const groups: NoteSegment[][] = [[value(input.symbol + ' ' + input.name, input.color ?? palette.accent)]];
  if (input.title) groups.push([value(input.title)]);
  groups.push([{text: input.stage, color: palette.strong}]);
  if (input.elapsedMs !== undefined) groups.push([dim(elapsed(input.elapsedMs))]);
  if (input.contextPercent !== undefined) groups.push([dim('ctx ' + input.contextPercent + '%')]);
  groups.push([click('click to open')]);
  return join(groups);
}

/** Context-aware key hints: the quiet default of row 2. */
export function footerHints(input: {readonly own: boolean; readonly queued: number; readonly menu: boolean; readonly closing: boolean; readonly width: number}): string {
  if (input.closing) return 'Closing…';
  if (input.menu) return input.width < 45 ? 'Arrows select · Tab complete · Esc close' : 'Arrows select · Tab complete · Enter confirm · Esc close';
  const back = input.own ? 'Esc back to Logox · ' : '';
  if (input.queued > 0) return back + 'Enter send · Ctrl+T send queued now · / commands';
  if (input.width < 40) return input.own ? 'Esc back · Enter send' : 'Enter send · / commands';
  return back + (input.own ? 'Enter send · / commands' : 'Enter send · Shift+Enter newline · @role dispatch · / commands');
}

const toneGlyph: Readonly<Record<NoticeTone, string>> = {success: '✓ ', warning: '▲ ', error: '✗ ', info: ''};
/** Row 2 shows exactly one thing: an active notice, else the hovered widget's detail, else the faint key hints. */
export function notificationSegments(input: {readonly notice?: Notice | undefined; readonly detail?: readonly NoteSegment[] | undefined; readonly hints: string}, width: number): NoteSegment[] {
  let segments: NoteSegment[];
  if (input.notice?.text) {
    const tone = input.notice.tone, color = tone === 'info' ? palette.fg : palette[tone];
    segments = [...(toneGlyph[tone] ? [{text: toneGlyph[tone], color, bold: true}] : []), {text: input.notice.text, color: palette.fg, bold: true}];
  } else if (input.detail?.length) segments = [...input.detail];
  else segments = [{text: input.hints, color: faint(), italic: true}];
  return fitSegments(segments, width);
}
/** Clips the run list to `width` cells with a trailing ellipsis; the notification line is prose, so a cut is fine here. */
export function fitSegments(segments: readonly NoteSegment[], width: number): NoteSegment[] {
  const out: NoteSegment[] = [];
  let used = 0;
  for (const segment of segments) {
    const size = stringWidth(segment.text);
    if (used + size <= width) {out.push(segment); used += size; continue;}
    let text = '';
    for (const char of segment.text) {
      if (used + stringWidth(text + char) > width - 1) break;
      text += char;
    }
    if (width - used >= 1) out.push({...segment, text: text + '…'});
    break;
  }
  return out;
}
