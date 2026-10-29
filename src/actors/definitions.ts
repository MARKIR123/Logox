import {z} from 'zod';
import {parseDocument, stringify} from 'yaml';
import {contextPolicySchema} from '../config/config.js';
import {immutable} from '../runtime/contracts.js';

export const actorIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).refine(id => !['legacy', 'con', 'prn', 'aux', 'nul', ...Array.from({length: 9}, (_, i) => 'com' + (i + 1)), ...Array.from({length: 9}, (_, i) => 'lpt' + (i + 1))].includes(id));
const text = (max: number) => z.string().trim().min(1).max(max).refine(value => !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value));
const inline = (max: number) => text(max).refine(value => !/[\r\n\t]/.test(value));
export const actorModelSchema = z.strictObject({provider: inline(128), model: inline(256)});
const actorContextSchema = z.strictObject({...contextPolicySchema.shape,
  reserve_tokens: contextPolicySchema.shape.reserve_tokens.removeDefault().optional(),
  low_watermark_ratio: contextPolicySchema.shape.low_watermark_ratio.removeDefault().optional(),
}).refine(policy => !policy.max_budget_tokens || !policy.target_budget_tokens || policy.target_budget_tokens < policy.max_budget_tokens,
  'target_budget_tokens 必须小于 max_budget_tokens');
export const actorDefinitionSchema = z.strictObject({
  id: actorIdSchema, name: inline(80), title: inline(160), description: inline(1000),
  color: z.string().regex(/^#[\da-fA-F]{6}$/), symbol: text(8).refine(value => !/\s/.test(value) && [...new Intl.Segmenter().segment(value)].length === 1),
  cardClosed: z.string().regex(/^#[\da-fA-F]{6}$/).optional(),
  cardOpen: z.string().regex(/^#[\da-fA-F]{6}$/).optional(),
  prompt: text(48000), execution: text(24000).optional(), collaboration: text(24000).optional(),
  compression: text(4000), context: actorContextSchema,
  defaultModel: actorModelSchema.optional(), skills: z.array(actorIdSchema).max(256).default([]),
  thinkingAnimation: z.array(z.string().min(1)).min(1).max(32).optional(),
});
export type ActorDefinition = Readonly<z.infer<typeof actorDefinitionSchema>>;
export type ActorModel = z.infer<typeof actorModelSchema>;

export function mergeActorPromptLayer(base: ActorDefinition, next: ActorDefinition): ActorDefinition {
  if (base.id !== next.id) throw new Error('Cannot merge different actor identities.');
  const append = (previous: string | undefined, current: string | undefined) => {
    if (!current) return previous;
    if (!previous || previous === current || current.includes(previous)) return current;
    return previous + '\n\n' + current;
  };
  const execution = append(base.execution, next.execution);
  const collaboration = append(base.collaboration, next.collaboration);
  return immutable(actorDefinitionSchema.parse({...next, prompt: append(base.prompt, next.prompt),
    ...(execution ? {execution} : {}), ...(collaboration ? {collaboration} : {})}));
}

export function deriveActorCardColors(color: string, closed?: string, open?: string): {closed: string; open: string; highlight: string} {
  const highlight = color;
  if (closed && open) return {closed, open, highlight};
  const clean = color.replace('#', '');
  const r = Number.parseInt(clean.slice(0, 2), 16);
  const g = Number.parseInt(clean.slice(2, 4), 16);
  const b = Number.parseInt(clean.slice(4, 6), 16);
  const toHex = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  const autoClosed = closed ?? ('#' + toHex(r * 0.38) + toHex(g * 0.38) + toHex(b * 0.38));
  const autoOpen = open ?? ('#' + toHex(r * 0.48) + toHex(g * 0.48) + toHex(b * 0.48));
  return {closed: autoClosed, open: autoOpen, highlight};
}

export function parseActor(text: string): ActorDefinition {
  if (Buffer.byteLength(text) > 64 * 1024) throw new Error('角色定义超过 64 KiB');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error('角色需要 YAML Frontmatter 和 prompt 正文');
  const doc = parseDocument(match[1]!, {uniqueKeys: true});
  if (doc.errors.length) throw new Error(doc.errors.map(error => error.message).join('；'));
  const fields: unknown = doc.toJS({maxAliasCount: 0});
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('Frontmatter 必须是对象');
  const raw = fields as Record<string, unknown>;
  if (Object.hasOwn(raw, 'card_closed')) {
    if (!Object.hasOwn(raw, 'cardClosed')) raw.cardClosed = raw.card_closed;
    delete raw.card_closed;
  }
  if (Object.hasOwn(raw, 'card_open')) {
    if (!Object.hasOwn(raw, 'cardOpen')) raw.cardOpen = raw.card_open;
    delete raw.card_open;
  }
  if (Object.hasOwn(raw, 'thinking_animation')) {
    if (!Object.hasOwn(raw, 'thinkingAnimation')) raw.thinkingAnimation = raw.thinking_animation;
    delete raw.thinking_animation;
  }
  if (Object.hasOwn(raw, 'prompt')) throw new Error('prompt 必须放在 Markdown 正文');
  if (raw.context && typeof raw.context === 'object') {
    for (const field of Object.keys(raw.context)) if (!Object.hasOwn(contextPolicySchema.shape, field)) throw new Error('未知 context 字段：' + field);
  }
  const context = raw.context && typeof raw.context === 'object' && !Array.isArray(raw.context)
    ? {keep_recent_rounds: raw.id === 'logox' ? 2 : 0, keep_recent_tools: raw.id === 'kalon' ? 0 : 2, ...raw.context}
    : raw.context === undefined ? {keep_recent_rounds: raw.id === 'logox' ? 2 : 0, keep_recent_tools: raw.id === 'kalon' ? 0 : 2} : raw.context;
  return immutable(actorDefinitionSchema.parse({...raw, context, prompt: match[2]!.trim()}));
}
export function serializeActor(definition: ActorDefinition): string {
  const {prompt, ...fields} = actorDefinitionSchema.parse(definition);
  return '---\n' + stringify(fields, {aliasDuplicateObjects: false}) + '---\n' + prompt + '\n';
}

export interface ActorProfileFiles {
  readonly config: string;
  readonly persona: string;
  readonly compression?: string | undefined;
  readonly execution?: string | undefined;
  readonly collaboration?: string | undefined;
}

export function parseActorProfile(files: ActorProfileFiles): ActorDefinition {
  if (Buffer.byteLength(files.config) > 64 * 1024) throw new Error('角色配置文件超过 64 KiB');
  if (Buffer.byteLength(files.persona) > 64 * 1024) throw new Error('角色人设文件超过 64 KiB');
  if (files.compression && Buffer.byteLength(files.compression) > 64 * 1024) throw new Error('角色压缩文件超过 64 KiB');
  for (const name of ['execution', 'collaboration'] as const) {
    if (files[name] && Buffer.byteLength(files[name]) > 64 * 1024) throw new Error(name + '.md exceeds 64 KiB.');
  }
  const doc = parseDocument(files.config, {uniqueKeys: true});
  if (doc.errors.length) throw new Error(doc.errors.map(error => error.message).join('；'));
  const fields: unknown = doc.toJS({maxAliasCount: 0});
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('配置文件必须是对象');
  const raw = fields as Record<string, unknown>;
  if (Object.hasOwn(raw, 'card_closed')) {
    if (!Object.hasOwn(raw, 'cardClosed')) raw.cardClosed = raw.card_closed;
    delete raw.card_closed;
  }
  if (Object.hasOwn(raw, 'card_open')) {
    if (!Object.hasOwn(raw, 'cardOpen')) raw.cardOpen = raw.card_open;
    delete raw.card_open;
  }
  if (Object.hasOwn(raw, 'thinking_animation')) {
    if (!Object.hasOwn(raw, 'thinkingAnimation')) raw.thinkingAnimation = raw.thinking_animation;
    delete raw.thinking_animation;
  }
  if (Object.hasOwn(raw, 'prompt')) throw new Error('prompt 必须放在 persona.md');
  if (raw.context && typeof raw.context === 'object') {
    for (const field of Object.keys(raw.context)) if (!Object.hasOwn(contextPolicySchema.shape, field)) throw new Error('未知 context 字段：' + field);
  }
  const context = raw.context && typeof raw.context === 'object' && !Array.isArray(raw.context)
    ? {keep_recent_rounds: raw.id === 'logox' ? 2 : 0, keep_recent_tools: raw.id === 'kalon' ? 0 : 2, ...raw.context}
    : raw.context === undefined ? {keep_recent_rounds: raw.id === 'logox' ? 2 : 0, keep_recent_tools: raw.id === 'kalon' ? 0 : 2} : raw.context;
  const compression = (files.compression?.trim() || (typeof raw.compression === 'string' ? raw.compression.trim() : ''));
  const prompt = files.persona.trim();
  const execution = files.execution?.trim() || raw.execution;
  const collaboration = files.collaboration?.trim() || raw.collaboration;
  return immutable(actorDefinitionSchema.parse({...raw, context, prompt, compression,
    ...(execution ? {execution} : {}), ...(collaboration ? {collaboration} : {})}));
}
