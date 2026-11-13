import {createHash, randomUUID} from 'node:crypto';
import {appendFile, mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {estimateText, IMAGE_TOKENS} from '../context/budget.js';
import {runtimeContextText} from '../runtime/context-updates.js';
import type {ModelMessage, ModelTurn, RequestFingerprintTarget} from '../runtime/messages.js';

/**
 * Always-on request fingerprint: one small JSON line per model request, appended to `<session state>/requests/<actor>.fingerprints.jsonl`.
 * It records what the prefix of the request was made of (short hashes and labels of tools, system blocks and every message block, in send order),
 * how big each category was, and the request fields that matter to a provider cache, so a cache miss can be explained afterwards.
 * A second `result` line with the same `id` carries the provider usage. Never message text, keys or headers.
 * Writing is asynchronous, ordered per file and swallows every error; nothing here can fail or delay a request.
 */
export const FINGERPRINT_VERSION = 1;
/** Tool names kept in the per-tool size breakdown of one request; the rest is summed under `other`. */
export const TOP_TOOL_SIZES = 8;
const LABEL_LIMIT = 40;

export const shortHash = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 10);

/** Estimated tokens of one message block, split into the categories the fingerprint reports. Images are counted separately from text. */
export interface BlockSizes {
  user: number; assistantText: number; thinking: number; toolArgs: number; context: number;
  toolName?: string; toolResult: number; images: number;
}
export interface Block {hash: string; label: string; tokens: number; sizes: BlockSizes}

/** Compact, space-free label from the typed message: role, host-message kind (and slot), tool name, tool-call count, image count. */
export function messageLabel(message: ModelMessage): string {
  if (message.role === 'context') {
    const slot = message.data?.slot;
    return 'context:' + message.kind + (typeof slot === 'string' && slot ? '/' + slot.replace(/\s+/g, '_').slice(0, LABEL_LIMIT) : '');
  }
  const images = 'images' in message && message.images?.length ? '+img' + message.images.length : '';
  if (message.role === 'user') return 'user' + images;
  if (message.role === 'tool') return 'tool:' + message.name.replace(/\s+/g, '_').slice(0, LABEL_LIMIT) + images;
  return 'assistant' + (message.toolCalls?.length ? '+calls' + message.toolCalls.length : '');
}

export function blockSizes(message: ModelMessage, replaysThinking: boolean): BlockSizes {
  const sizes: BlockSizes = {user: 0, assistantText: 0, thinking: 0, toolArgs: 0, context: 0, toolResult: 0, images: 0};
  if (message.role === 'context') {
    if (!(message.kind === 'environment-baseline' || message.kind === 'capability-change' && message.data?.baseline === true)) sizes.context = estimateText(runtimeContextText(message));
    return sizes;
  }
  sizes.images = 'images' in message ? message.images?.length ?? 0 : 0;
  if (message.role === 'user') sizes.user = estimateText(message.text);
  else if (message.role === 'tool') {sizes.toolName = message.name; sizes.toolResult = estimateText(message.text);}
  else {
    sizes.assistantText = estimateText(message.text);
    if (replaysThinking && message.reasoning) sizes.thinking = estimateText(message.reasoning);
    for (const call of message.toolCalls ?? []) sizes.toolArgs += estimateText(call.name + call.arguments);
  }
  return sizes;
}
const blockTokens = (sizes: BlockSizes): number =>
  sizes.user + sizes.assistantText + sizes.thinking + sizes.toolArgs + sizes.context + sizes.toolResult + sizes.images * IMAGE_TOKENS;

/**
 * One block per Logox message in send order. The hash covers that message's own wire encoding (`encode`, the same encoder the request uses, run on that
 * message alone), without the moving `cache_control` marker; the label comes from the typed message itself, so nothing is guessed from serialized text.
 * Results are memoized per message object and encoding `key` (protocol, vision, replay flags and tool-list hash), so a long history is hashed once.
 */
const memo = new WeakMap<object, Map<string, Block>>();
export function fingerprintBlocks(messages: readonly ModelMessage[], key: string, encode: (message: ModelMessage) => unknown,
  replaysThinking: (message: ModelMessage) => boolean): Block[] {
  return messages.map(message => {
    let byKey = memo.get(message);
    if (!byKey) memo.set(message, byKey = new Map());
    let block = byKey.get(key);
    if (!block) {
      const sizes = blockSizes(message, replaysThinking(message));
      block = {hash: shortHash(JSON.stringify(encode(message))), label: messageLabel(message), tokens: blockTokens(sizes), sizes};
      byKey.set(key, block);
    }
    return block;
  });
}

export interface FingerprintFields {
  maxTokens: number;
  /** Protocol and effective level, including the budget a budget-thinking request derives from `max_tokens`. */
  thinking: string;
  /** Anthropic `short` / `long`, or the OpenAI retention value, or `none`. */
  retention: string;
  /** Lifetime LOGOX believes the provider keeps the entry for; null when unknown. */
  ttlMs: number | null;
  cacheKey: boolean;
  stream: boolean;
  discovery: string;
}
export interface FingerprintInput {
  id: string; time: number; target: RequestFingerprintTarget; purpose: string;
  model: string; host: string; protocol: 'anthropic' | 'chat' | 'responses';
  /** The tool list exactly as serialized in the body. */
  toolsJson: string;
  /** The system prompt as serialized in the body, one entry per block (a single entry unless the protocol sends several). */
  systemBlocks: readonly string[];
  systemText: string;
  blocks: readonly Block[];
  fields: FingerprintFields;
}
export interface FingerprintRecord {
  v: number; kind: 'request'; id: string; time: number; ownerId: string; activityId?: string; purpose: string;
  model: string; host: string; protocol: FingerprintInput['protocol'];
  tools: string; system: string[];
  /** `[hash, estimated tokens, label]` per message block, in send order. */
  messages: [string, number, string][];
  sizes: {tools: number; system: number; user: number; assistantText: number; thinking: number; toolArgs: number;
    toolResults: Record<string, number>; images: {count: number; tokens: number}; context: number; total: number};
  fields: FingerprintFields;
}
export function buildFingerprint(input: FingerprintInput): FingerprintRecord {
  const byTool = new Map<string, number>();
  const sum = {user: 0, assistantText: 0, thinking: 0, toolArgs: 0, context: 0, images: 0};
  for (const {sizes} of input.blocks) {
    sum.user += sizes.user; sum.assistantText += sizes.assistantText; sum.thinking += sizes.thinking;
    sum.toolArgs += sizes.toolArgs; sum.context += sizes.context; sum.images += sizes.images;
    if (sizes.toolName !== undefined) byTool.set(sizes.toolName, (byTool.get(sizes.toolName) ?? 0) + sizes.toolResult);
  }
  const ranked = [...byTool].sort((a, b) => b[1] - a[1]);
  const toolResults: Record<string, number> = Object.fromEntries(ranked.slice(0, TOP_TOOL_SIZES));
  const rest = ranked.slice(TOP_TOOL_SIZES).reduce((total, [, tokens]) => total + tokens, 0);
  if (rest) toolResults.other = rest;
  const tools = estimateText(input.toolsJson), system = estimateText(input.systemText);
  const imageTokens = sum.images * IMAGE_TOKENS;
  const total = tools + system + sum.user + sum.assistantText + sum.thinking + sum.toolArgs + sum.context + imageTokens +
    ranked.reduce((value, [, tokens]) => value + tokens, 0);
  return {v: FINGERPRINT_VERSION, kind: 'request', id: input.id, time: input.time, ownerId: input.target.ownerId,
    ...(input.target.activityId ? {activityId: input.target.activityId} : {}), purpose: input.purpose,
    model: input.model, host: input.host, protocol: input.protocol,
    tools: shortHash(input.toolsJson), system: input.systemBlocks.map(shortHash),
    messages: input.blocks.map(block => [block.hash, block.tokens, block.label]),
    sizes: {tools, system, user: sum.user, assistantText: sum.assistantText, thinking: sum.thinking, toolArgs: sum.toolArgs,
      toolResults, images: {count: sum.images, tokens: imageTokens}, context: sum.context, total}, fields: input.fields};
}

const chains = new Map<string, Promise<void>>();
const madeDirs = new Set<string>();
/** Appends one line to `file`, in order with earlier lines of the same file. The line is produced lazily, after the request is on its way; all errors are swallowed. */
export function appendFingerprint(file: string, produce: () => string | undefined): void {
  const run = async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
    try {
      const line = produce();
      if (!line) return;
      const dir = dirname(file);
      if (!madeDirs.has(dir)) {await mkdir(dir, {recursive: true}); madeDirs.add(dir);}
      await appendFile(file, line + '\n');
    } catch {}
  };
  const next = (chains.get(file) ?? Promise.resolve()).then(run);
  chains.set(file, next);
  void next.then(() => {if (chains.get(file) === next) chains.delete(file);});
}
/** Resolves when every queued fingerprint line has been written (tests and shutdown; a request never waits for it). */
export async function flushFingerprints(): Promise<void> {
  while (chains.size) await Promise.all([...chains.values()]);
}

export type FingerprintOutcome = {usage?: ModelTurn['usage']} | {error: string};
/**
 * Queues the `request` line (built lazily by `build`, which must not throw into the caller) and returns the settler for its `result` line.
 * `settle` is idempotent: the first outcome wins.
 */
export function beginFingerprint(target: RequestFingerprintTarget, build: (id: string, time: number) => FingerprintInput): {settle(outcome: FingerprintOutcome): void} {
  const id = randomUUID().slice(0, 8), time = Date.now();
  let settled = false;
  appendFingerprint(target.file, () => JSON.stringify(buildFingerprint(build(id, time))));
  return {settle(outcome) {
    if (settled) return;
    settled = true;
    appendFingerprint(target.file, () => {
      const usage = 'usage' in outcome ? outcome.usage : undefined;
      return JSON.stringify({v: FINGERPRINT_VERSION, kind: 'result', id, time: Date.now(), ms: Date.now() - time,
        ...('error' in outcome ? {error: outcome.error} : {}),
        ...(usage ? {usage: {input: usage.input, output: usage.output, ...(usage.cacheRead !== undefined ? {cacheRead: usage.cacheRead} : {}),
          ...(usage.cacheWrite !== undefined ? {cacheWrite: usage.cacheWrite} : {})}} : {})});
    });
  }};
}
