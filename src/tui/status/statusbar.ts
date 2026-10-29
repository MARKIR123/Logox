import {readFileSync} from 'node:fs';
import {stripVTControlCharacters} from 'node:util';
import stringWidth from 'string-width';
import {z} from 'zod';
import type {StageStatus} from '../../runtime/stage-status.js';
import {defaultStatusbar, type StatusbarAppearance, type StatusbarId, type StatusbarModule} from '../../config/statusbar-preferences.js';
import {hexColorSchema, themeColorKeys, type ThemeColorKey} from '../../config/theme-palette.js';
import {permissionModes} from '../../runtime/permission-mode.js';
import {palette} from '../appearance/theme.js';

export type StatusbarPart = {text: string; color?: string; backgroundColor?: string};
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

function shorten(value: string, width: number): string {
  if (width < 1) return '';
  if (stringWidth(value) <= width) return value;
  if (width < 2) return '';
  let result = '', used = 0;
  for (const {segment} of graphemes.segment(value)) {
    const size = stringWidth(segment);
    if (used + size > width - 1) break;
    result += segment; used += size;
  }
  return result ? result + '…' : '';
}

const stateLabels: Readonly<Record<string, string>> = {
  '就绪': 'ready', '运行中': 'running', '执行中': 'running', '排队中': 'queued', '排队': 'queued',
  '待回答': 'waiting', '等待回答': 'waiting', '已暂停': 'paused', '已完成': 'completed',
  '失败': 'failed', '已停止': 'cancelled', '已取消': 'cancelled',
};
const effortTokens: Readonly<Record<string, ThemeColorKey>> = {
  off: 'effortOff', low: 'effortLow', medium: 'effortMedium', high: 'effortHigh', max: 'effortMax', auto: 'effortAuto',
};
function usedPercent(status: StageStatus): number | undefined {
  const context = status.context;
  if (!context || !Number.isFinite(context.tokens) || !Number.isFinite(context.window) || context.window <= 0) return;
  return Math.round(Math.max(0, Math.min(100, context.tokens / context.window * 100)));
}
function contextVariants(status: StageStatus): string[] {
  const used = usedPercent(status);
  if (used === undefined) return ['Context N/A', 'Ctx N/A'];
  const filled = Math.round(used / 20), gauge = '■'.repeat(filled) + '□'.repeat(5 - filled);
  const compactFilled = Math.round(used / 100 * 3), compactGauge = '■'.repeat(compactFilled) + '□'.repeat(3 - compactFilled);
  return [`Context [${gauge}] ${used}% USED`, `[${gauge}] ${used}% USED`, `${compactGauge} ${used}% USED`];
}
function namedVariants(value: string, width: number, prefix = ''): string[] {
  const name = clean(value);
  return [prefix + name, name, shorten(name, width)].filter(Boolean);
}
interface Descriptor {
  readonly icon: string;
  readonly token: ThemeColorKey | ((status: StageStatus) => ThemeColorKey);
  readonly variants: (status: StageStatus, width: number) => readonly string[];
}

/** Module IDs, data projection and semantic accents stay together; styles only arrange plans. */
const registry: Readonly<Record<StatusbarId, Descriptor>> = {
  role: {icon: '\uf007', token: 'accent', variants: (status, width) => namedVariants(status.name, width)},
  model: {icon: '\uf4b8', token: 'question', variants: (status, width) => {
    if (!status.model) return ['No model'];
    const provider = clean(status.model.provider), model = clean(status.model.model);
    const providerShort = shorten(provider, Math.min(8, Math.max(2, Math.floor(width / 3))));
    const modelShort = shorten(model, width - stringWidth(providerShort) - 1);
    return [provider + '/' + model, providerShort && modelShort ? providerShort + '/' + modelShort : '', model, shorten(model, width)].filter(Boolean);
  }},
  effort: {icon: '\uf0eb', token: status => effortTokens[status.effort ?? ''] ?? 'muted',
    variants: status => {
      const effort = status.effort === '不支持' ? 'unsupported' : status.effort ?? 'unsupported';
      return ['Thinking ' + effort, effort];
    }},
  permission: {icon: '\uf023', token: status => {
    const mode = status.permission;
    return mode && Object.hasOwn(permissionModes, mode) ? permissionModes[mode as keyof typeof permissionModes].colorToken : 'muted';
  }, variants: status => ['Permission ' + (status.permission ?? 'none'), status.permission ?? 'none']},
  context: {icon: '\uf1c0', token: status => (usedPercent(status) ?? 0) >= 90 ? 'error' : (usedPercent(status) ?? 0) >= 70 ? 'warning' : 'success', variants: contextVariants},
  state: {icon: '\uf04b', token: status => /fail|error/i.test(status.state) ? 'error' : /wait|paus|queue/i.test(status.state) ? 'warning' : 'success',
    variants: status => [stateLabels[status.state] ?? status.state]},
  tokens: {icon: '\uf0ec', token: 'effortMedium', variants: status => {
    const tokens = status.tokens;
    if (tokens === undefined || !Number.isFinite(tokens)) return ['Tokens N/A', 'N/A'];
    return ['Tokens ' + tokens.toLocaleString('en-US'), tokens.toLocaleString('en-US'), new Intl.NumberFormat('en-US', {notation: 'compact', maximumFractionDigits: 1}).format(tokens)];
  }},
  cost: {icon: '\uf155', token: 'warning', variants: status => {
    if (status.cost === undefined || !Number.isFinite(status.cost)) return ['Cost N/A', 'N/A'];
    const cost = (status.costCurrency ? status.costCurrency + ' ' : '') + status.cost.toFixed(4);
    return ['Cost ' + cost, cost];
  }},
  session: {icon: '\uf0e6', token: 'strong', variants: (status, width) => namedVariants(status.session ?? 'unsaved', width, 'Session ')},
  project: {icon: '\uf07b', token: 'success', variants: (status, width) => {
    if (!status.project) return ['Project N/A', 'N/A'];
    const path = clean(status.project), leaf = path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) ?? path;
    return [path, leaf, shorten(leaf, width)].filter(Boolean);
  }},
};

export function statusbarText(status: StageStatus, width: number, modules: readonly StatusbarModule[] = defaultStatusbar, appearance: Partial<StatusbarAppearance> = {}): string {
  return statusbarParts(status, width, modules, appearance).map(part => part.text).join('');
}

/** Every visible cell, including separators, padding and caps, belongs to this plan. */
export function statusbarParts(status: StageStatus, width: number, modules: readonly StatusbarModule[] = defaultStatusbar, appearance: Partial<StatusbarAppearance> = {}): StatusbarPart[] {
  if (!Number.isFinite(width) || width < 1) return [];
  const limit = Math.floor(width), starship = appearance.style === 'starship';
  const scheme = appearance.colorScheme === 'gruvbox' || appearance.colorScheme === 'dracula' ? schemes[appearance.colorScheme] : {};
  const colors = {...palette, ...scheme};
  const segments: {text: string; color: string}[] = [];
  let used = 0;
  for (const module of modules) {
    if (!module.enabled || !Object.hasOwn(registry, module.id)) continue;
    const descriptor = registry[module.id];
    // Reserve full framing now, so no terminal cap can be lost at a narrow width.
    const framing = starship ? (segments.length ? 3 : 4) : (segments.length ? 3 : 0);
    const available = limit - used - framing, icon = descriptor.icon + ' ';
    const variants = descriptor.variants(status, available - stringWidth(icon));
    const value = variants.map(clean).find(text => text && stringWidth(icon + text) <= available);
    if (!value) continue;
    const token = typeof descriptor.token === 'function' ? descriptor.token(status) : descriptor.token;
    // Decorative schemes must not recolor Actor identity or permission-mode semantics.
    const color = module.id === 'role' ? hexColorSchema.safeParse(status.color).data ?? palette.accent
      : module.id === 'permission' ? palette[token] : colors[token];
    const text = icon + value;
    segments.push({text, color}); used += framing + stringWidth(text);
  }
  const parts: StatusbarPart[] = [];
  if (!starship) {
    for (const segment of segments) {
      if (parts.length) parts.push({text: ' | ', color: colors.muted});
      parts.push(segment);
    }
    return parts;
  }
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!, next = segments[index + 1];
    if (index === 0) parts.push({text: '\ue0b6', color: segment.color});
    parts.push({text: ' ' + segment.text + ' ', color: colors.bg, backgroundColor: segment.color});
    parts.push(next ? {text: '\ue0b0', color: segment.color, backgroundColor: next.color} : {text: '\ue0b4', color: segment.color});
  }
  return parts;
}
