import type {ContextPolicy} from '../config/config.js';
import type {ModelMessage, ModelRequest, ModelTurn, Provider, ToolCall, TurnUsage} from '../runtime/messages.js';
import {createRuntimeContextMessage} from '../runtime/context-updates.js';
import {normalizeMessages} from '../runtime/messages.js';
import {inputMessage} from '../runtime/provenance.js';
import {Journal, storedMessage, type HistoryEntry} from '../store/journal.js';
import {COMPACT_ACCEPT_RATIO, digest, estimateRequest, estimateText, TASK_END_FLOOR_RATIO, TokenMeter, watermarks} from './budget.js';
import {summarizeRound, memoryFocusInstruction, HISTORY_MEMO_INSTRUCTION, type ContextState, type ModelCapacity, type RoundRecord} from './contracts.js';
import {historyForkInstruction, PROGRESS_FORK_INSTRUCTION} from '../prompts/compaction.js';
import {ROUND_MARKERS, formatRoundIndex, omitInternalToolPairs} from './round-memory.js';
import {isFinishRound} from '../tools/protocol/_FinishRoundTool/_FinishRoundTool.js';
import {canonicalToolName} from '../tools/types.js';
import {retainDiscoveryPairs, extractDiscoveredToolNames} from '../tools/discovery.js';
import {contextSnapshot, retainRuntimeContext} from './continuity.js';
import {turnUsageOf, type costOf} from './cost.js';
import {allocateContext, categoryWeights, type ContextBreakdown} from './breakdown.js';
import {imageCount, imageReference, imagesAsText} from './images.js';

type Identity = {sessionId: string; ownerId: string; activityId?: string};
interface Round {start: number; end: number; closed: boolean; record?: RoundRecord}
interface Pair {callIndex: number; resultIndex: number; call: ToolCall}
export interface ContextOptions {
  journal: Journal;
  policy: ContextPolicy | ((identity: Identity) => ContextPolicy);
  maxOutput: number;
  model(identity: Identity): ModelCapacity;
  summarizer(identity: Identity): {model: ModelCapacity; provider: Provider};
  contract?(identity: Identity): string | undefined;
  anchors?(identity: Identity): Promise<readonly ModelMessage[]>;
  report?(identity: Identity, text: string): void;
  beforeCompact?(identity: Identity, tokens: number): void;
  /** Brackets a running compaction so the UI can show `Compacting context` for that owner. */
  compacting?(identity: Identity, active: boolean): void;
  /** Source of list prices for the cost stored with each turn's usage (see `cost.ts:costOf`). */
  pricing?: Parameters<typeof costOf>[1];
}
export class ContextBudgetError extends Error {}
/** Upper bound for a model-written overview or progress summary. */
const SUMMARY_TOKENS = 4000;
interface Fork {readonly base: Pick<ModelRequest, 'system' | 'tools' | 'toolDiscovery'>; readonly prefix: readonly ModelMessage[]; readonly model: ModelCapacity; readonly safety: number}
function withoutThinking(value: ModelMessage): ModelMessage {
  if (value.role !== 'assistant' || !value.reasoning && !value.signature) return value;
  const {reasoning: _reasoning, signature: _signature, ...rest} = value;
  return rest;
}
function message(entry: HistoryEntry): ModelMessage {
  if (entry.role === 'user') return inputMessage(entry.text, entry);
  return storedMessage(entry);
}
function splitRounds(entries: readonly HistoryEntry[], records: readonly RoundRecord[]): Round[] {
  const seen = new Set<string>();
  // An activity that continues or joins a round (`roundId`) belongs to the group that round opened.
  const starts = entries.flatMap((entry, index) => {
    if (entry.role !== 'user') return [];
    const joins = !!entry.roundId && seen.has(entry.roundId);
    if (entry.activityId) {
      const known = seen.has(entry.activityId);
      seen.add(entry.activityId);
      if (known) return [];
    }
    return joins ? [] : [index];
  });
  return starts.map((start, index) => {
    const end = starts[index + 1] ?? entries.length;
    const record = records.find(item => item.start >= start && item.start < end && item.end <= end &&
      (item.start === start || !!entries[start]?.activityId && item.activityId === entries[start]!.activityId &&
        entries.slice(start, item.start).every(entry => entry.activityId === item.activityId)) &&
      entries.slice(item.end, end).every(entry => entry.role === 'tool'));
    return {start, end, closed: !!record || index < starts.length - 1, ...(record ? {record} : {})};
  });
}
function toolPairs(entries: readonly HistoryEntry[]): Pair[] {
  const pairs: Pair[] = [];
  const pending = new Map<string, {callIndex: number; call: ToolCall}>();
  entries.forEach((entry, index) => {
    const value = message(entry);
    if (value.role === 'assistant' && !value.contextExcluded && !value.toolsExcluded) for (const call of value.toolCalls ?? []) {
      if (!isFinishRound(call.name)) pending.set(call.id, {callIndex: index, call});
    }
    if (value.role === 'tool' && !isFinishRound(value.name)) {
      const pair = pending.get(value.callId);
      if (pair) {pairs.push({...pair, resultIndex: index}); pending.delete(value.callId);}
    }
  });
  return pairs;
}
/** `estimated` is false only when `input` is anchored on provider-reported usage of the latest response. */
export interface ContextReading {input: number; high: number; low: number; window: number; output: number; estimated: boolean; categories?: ContextBreakdown}
export class ContextManager {
  private readonly meters = new Map<string, TokenMeter>();
  private readonly statistics = new Map<string, ContextReading>();
  private readonly imageForced = new Set<string>();
  constructor(private readonly options: ContextOptions) {}
  private key(identity: Identity): string {return JSON.stringify([identity.sessionId, identity.ownerId]);}
  meter(identity: Identity): TokenMeter {
    const key = this.key(identity);
    let meter = this.meters.get(key);
    if (!meter) {meter = new TokenMeter(); this.meters.set(key, meter);}
    return meter;
  }
  status(identity: Identity) {return this.statistics.get(this.key(identity));}
  /** Every meter of one session, keyed by owner (Automa usage is charged to its dispatcher's meter). */
  sessionMeters(sessionId: string): ReadonlyMap<string, TokenMeter> {
    const result = new Map<string, TokenMeter>();
    for (const [key, meter] of this.meters) {
      const [session, owner] = JSON.parse(key) as [string, string];
      if (session === sessionId) result.set(owner, meter);
    }
    return result;
  }
  /** After a provider rejected a request for too many images: the next `prepare` turns the older half of the images into text. */
  downgradeImages(identity: Identity): void {this.imageForced.add(this.key(identity));}
  /** Drops provider anchors; existing readings stay visible but are marked as estimates until the next response. */
  invalidatePrefix(): void {
    for (const meter of this.meters.values()) meter.invalidate();
    for (const [key, reading] of this.statistics) this.statistics.set(key, {...reading, estimated: true});
  }
  /** The ledger form of one turn's provider-reported usage, priced when a price is known. */
  turnUsage(turn: ModelTurn, model: ModelCapacity): TurnUsage | undefined {
    return turn.usage ? turnUsageOf(turn.usage, model.identity, this.options.pricing) : undefined;
  }
  observe(identity: Identity, request: ModelRequest, turn: ModelTurn, model: ModelCapacity): void {
    this.meter(identity).observe(request, turn, model);
    // Record the context the provider actually reported for this response, not only the pre-request estimate.
    const usage = turn.usage;
    if (!usage || !['complete', 'tools'].includes(turn.stop) || !Number.isFinite(usage.input + usage.output) || usage.input <= 0) return;
    const key = this.key(identity), previous = this.statistics.get(key);
    const policy = typeof this.options.policy === 'function' ? this.options.policy(identity) : this.options.policy;
    const marks = watermarks(model, policy);
    const total = usage.input + usage.output, categories = allocateContext(total, categoryWeights(request, [turn.message]));
    this.statistics.set(key, {high: marks.high, low: marks.low, window: model.window, output: previous?.output ?? 0, input: total, estimated: false, ...(categories ? {categories} : {})});
  }
  /** Rebuilds a reading for an owner that has stored history but has not run in this process (session resume); always an estimate. */
  async restoreReading(identity: Identity): Promise<void> {
    const key = this.key(identity);
    if (this.statistics.has(key)) return;
    try {
      const entries = await this.options.journal.load(identity.sessionId, identity.ownerId);
      if (!entries.length) return;
      const model = this.options.model(identity);
      const policy = typeof this.options.policy === 'function' ? this.options.policy(identity) : this.options.policy;
      const marks = watermarks(model, policy);
      const input = estimateRequest({system: '', tools: [], messages: normalizeMessages(entries.map(message))});
      const restored = normalizeMessages(entries.map(message)), categories = allocateContext(input, categoryWeights({system: '', tools: [], messages: restored}));
      if (!this.statistics.has(key)) this.statistics.set(key, {input, high: marks.high, low: marks.low, window: model.window, estimated: true, ...(categories ? {categories} : {}),
        output: Math.max(0, Math.floor(Math.min(this.options.maxOutput, model.maxOutput ?? Infinity, model.window - input - marks.safety)))});
    } catch {}
  }
  summaryContract(identity: Identity): string {return this.options.contract?.(identity)?.trim() ?? "";}
  requestBase(_identity: Identity, base: Pick<ModelRequest, 'system' | 'tools' | 'toolDiscovery'>): Pick<ModelRequest, 'system' | 'tools' | 'toolDiscovery'> {
    return base;
  }
  async taskEnd(identity: Identity, base: Pick<ModelRequest, "system" | "tools">, signal: AbortSignal): Promise<void> {
    // Called only when a real task (Director assignment or human request) ends; the floor and benefit gate live in prepare().
    if (identity.ownerId !== "logox") await this.prepare(identity, base, signal, true, true);
  }
  async prepare(identity: Identity, base: Pick<ModelRequest, 'system' | 'tools' | 'toolDiscovery'>, signal: AbortSignal, force = false, taskEnd = false):
    Promise<{request: ModelRequest; model: ModelCapacity; compacted: boolean}> {
    signal.throwIfAborted();
    base = this.requestBase(identity, base);
    const model = this.options.model(identity), {journal} = this.options;
    const policy = typeof this.options.policy === 'function' ? this.options.policy(identity) : this.options.policy;
    const marks = watermarks(model, policy);
    const entries = await journal.load(identity.sessionId, identity.ownerId);
    const originalEntries = await journal.loadRaw(identity.sessionId, identity.ownerId);
    const activityIds = [...new Set(originalEntries.filter(entry => entry.role === 'user' && entry.activityId).map(entry => entry.activityId!))];
    const anchors = await this.options.anchors?.(identity) ?? [];
    let records: RoundRecord[];
    try {records = await journal.rounds(identity.sessionId, identity.ownerId, entries);}
    catch {records = []; this.options.report?.(identity, '[Context] Invalid round memory; falling back to raw history.');}
    const rounds = splitRounds(entries, records), pairs = toolPairs(entries);
    const sourceMessages = entries.map(message);
    const discoveryIds = new Set(retainDiscoveryPairs(sourceMessages, extractDiscoveredToolNames(sourceMessages))
      .flatMap(value => value.role === 'tool' ? [value.callId] : []));
    let state: ContextState | undefined;
    try {state = await journal.loadContext(identity.sessionId, identity.ownerId, entries);}
    catch {this.options.report?.(identity, '[Context] Invalid saved view; rebuilding from the raw ledger.');}
    const empty: ContextState = {version: 1, sessionId: identity.sessionId, ownerId: identity.ownerId, sourceLength: entries.length, sourceHash: digest(entries), folded: [], archives: []};
    state ??= empty;
    if (rounds.some(round => !round.closed && (state!.folded.includes(round.start) || state!.memo && round.start < state!.memo.end))) state = empty;
    let original = state;
    const closed = rounds.filter(round => round.closed);
    const protectedPairs = new Set((policy.keep_recent_tools ? pairs.slice(-policy.keep_recent_tools) : []).map(pair => pair.resultIndex));
    const projected = (candidate: ContextState, end = entries.length): ModelMessage[] => {
      // After a compaction, earlier thinking is never sent again: its signature bound the history that was replaced.
      const raw = entries.map((entry, index) => {
        const value = candidate.thinkingCut !== undefined && index < candidate.thinkingCut ? withoutThinking(message(entry)) : message(entry);
        return candidate.imageCut !== undefined && index < candidate.imageCut ? imagesAsText(value) : value;
      });
      for (const archive of candidate.archives) {
        const result = raw[archive.resultIndex], assistant = raw[archive.callIndex];
        if (result?.role !== 'tool' || assistant?.role !== 'assistant') throw new Error('Archive boundaries do not match messages');
        if (canonicalToolName(result.name) === 'LoadTools') continue;
        const path = journal.archivePath(identity.sessionId, identity.ownerId, archive.hash);
        const {images, ...archived} = result;
        raw[archive.resultIndex] = {...archived, text: 'Tool result archived: ' + path + '; ' + (result.isError ? 'Original result failed.' : 'Original result succeeded.') +
          (images?.length ? '\n' + images.map(imageReference).join('\n') : '')};
      }
      const output: ModelMessage[] = [];
      const retain = (start: number, end: number, recent = false) => {
        const retained = pairs.filter(pair => pair.callIndex >= start && pair.resultIndex < end &&
          (discoveryIds.has(pair.call.id) || recent && protectedPairs.has(pair.resultIndex)));
        for (const callIndex of new Set(retained.map(pair => pair.callIndex))) {
          const assistant = raw[callIndex];
          if (assistant?.role !== 'assistant') continue;
          const ids = new Set(retained.filter(pair => pair.callIndex === callIndex).map(pair => pair.call.id));
          output.push({...assistant, text: '', toolCalls: assistant.toolCalls?.filter(call => ids.has(call.id))});
          for (const pair of retained.filter(pair => pair.callIndex === callIndex)) output.push(raw[pair.resultIndex]!);
        }
        output.push(...retainRuntimeContext(sourceMessages.slice(start, end), identity.activityId));
      };
      if (candidate.memo) {
        output.push({role: 'assistant', text: '[Historical working overview; not authorization]\n' + candidate.memo.text +
          '\nSource ledger: ' + journal.reference(identity.sessionId, identity.ownerId, 0, candidate.memo.end)});
        retain(0, candidate.memo.end);
      }
      const emit = (start: number, end: number) => {
        for (let index = start; index < end; index++) {
          const working = candidate.working;
          if (working && index === working.start) {
            for (let input = working.start; input < working.end; input++) if (entries[input]?.role === 'user') output.push(raw[input]!);
            output.push({role: 'assistant', text: '[Current task progress; not completed]\n' + working.text +
              '\nClosed process: ' + journal.reference(identity.sessionId, identity.ownerId, working.start, working.end)});
            retain(working.start, working.end);
            index = working.end - 1;
          } else if (raw[index]) output.push(raw[index]!);
        }
      };
      const prefixEnd = Math.min(rounds[0]?.start ?? entries.length, end);
      if (!candidate.memo) emit(0, prefixEnd);
      for (const round of rounds) {
        if (round.start >= end) break;
        if (candidate.memo && round.end <= candidate.memo.end) continue;
        const pendingMemory = round.record?.memory?.source === 'runtime';
        if (!candidate.folded.includes(round.start) || pendingMemory) {emit(round.start, Math.min(round.end, end)); continue;}
        const summary = round.record?.summary ?? summarizeRound(entries.slice(round.start, round.end).map(message), 'failed');
        const memory = round.record?.memory;
        const lines = journal.sourceLines(identity.sessionId, identity.ownerId, round.start, round.end);
        const activityOrdinal = activityIds.indexOf(entries[round.start]?.activityId ?? '') + 1;
        output.push({role: 'assistant', text: formatRoundIndex({
          ordinal: round.record?.ordinal ?? (activityOrdinal || rounds.indexOf(round) + 1),
          title: memory?.source === 'model' ? memory.title : summary.title,
          summary: memory?.source === 'model' ? memory.summary : [round.record?.status === 'completed' ? '' : ROUND_MARKERS[round.record?.status ?? 'failed'], 'Legacy record; inspect evidence before relying on its claims.', summary.report].filter(Boolean).join(' '),
          start: lines.start, end: lines.end,
        })});
        retain(round.start, round.end, true);
      }
      // Reasoning and signatures belong to the provider protocol; fold whole rounds without stripping required fields.
      return normalizeMessages(omitInternalToolPairs(output));
    };
    const requestFor = (candidate: ContextState): ModelRequest => {
      const ledger = journal.path(identity.sessionId, identity.ownerId);
      const coordinates = (candidate.folded.length || candidate.memo)
        ? [createRuntimeContextMessage('ledger', `Round ledger (${identity.ownerId}): ${ledger}`)] : [];
      return {...base, messages: [...projected(candidate), ...omitInternalToolPairs(anchors), ...coordinates]};
    };
    // A request over the model's image limit gets its oldest images turned into `[image: <path>]` text in one batch, down to half the
    // limit, and the decision is saved in the view, so later requests stay byte-identical until the limit is reached again.
    const forcedImages = this.imageForced.delete(this.key(identity));
    if (forcedImages || model.maxImages) {
      const owners = new Map<string, number>();
      entries.forEach((entry, index) => {const value = message(entry); if (value.role === 'tool') owners.set(value.callId, index);});
      const sent = projected(state).flatMap(value => value.role === 'tool' && imageCount(value) && owners.has(value.callId) ? [{index: owners.get(value.callId)!, count: imageCount(value)}] : [])
        .sort((a, b) => a.index - b.index);
      const total = sent.reduce((sum, item) => sum + item.count, 0), limit = forcedImages ? total : model.maxImages!;
      if (total > limit || forcedImages && total > 0) {
        let remaining = total, cut = 0;
        for (const item of sent) {
          if (remaining <= Math.floor(limit / 2)) break;
          remaining -= item.count; cut = item.index + 1;
        }
        if (cut > (state.imageCut ?? 0)) {
          const next: ContextState = {...structuredClone(state), imageCut: cut, sourceLength: entries.length, sourceHash: digest(entries)};
          try {
            await journal.saveContext(next);
            state = next; original = next;
            this.options.report?.(identity, '[Context] Replaced the oldest images with their file paths (' + (total - remaining) + ' of ' + total + '; ' + (forcedImages ? 'rejected by the provider' : 'limit ' + limit) + ').');
          } catch {}
        }
      }
    }
    const meter = this.meter(identity);
    const before = meter.estimate(requestFor(state), model);
    let compacted = false, request = requestFor(state);
    // A task end below the floor keeps the cached view; above the high watermark the normal watermark rules apply.
    const floored = taskEnd && before < marks.high * (policy.task_end_floor_ratio ?? TASK_END_FLOOR_RATIO);
    const gated = taskEnd && before < marks.high;
    if (force && !floored || before >= marks.high) {
      this.options.beforeCompact?.(identity, before);
      this.options.compacting?.(identity, true);
      try {
        // A compacted view never sends thinking from before this point, including in the request built right now.
        const candidate: ContextState = {...structuredClone(state), ...contextSnapshot(sourceMessages), thinkingCut: entries.length};
        const archiveTools = async (all: boolean) => {
          for (const pair of pairs) {
            signal.throwIfAborted();
            if (canonicalToolName(pair.call.name) === 'LoadTools') continue;
            if (!all && protectedPairs.has(pair.resultIndex) || candidate.archives.some(item => item.resultIndex === pair.resultIndex)) continue;
            if (candidate.memo && pair.resultIndex < candidate.memo.end) continue;
            const result = message(entries[pair.resultIndex]!);
            if (!imageCount(result) && estimateText(pair.call.arguments + result.text) < 256) continue;
            const hash = await journal.archive(identity.sessionId, identity.ownerId, {call: pair.call, result});
            candidate.archives.push({callIndex: pair.callIndex, resultIndex: pair.resultIndex, hash});
          }
        };
        await archiveTools(false);
        for (const round of closed.slice(0, Math.max(0, closed.length - policy.keep_recent_rounds))) {
          if (!candidate.folded.includes(round.start)) candidate.folded.push(round.start);
        }
        if (estimateRequest(requestFor(candidate)) > marks.low) {
          for (const round of closed) if (!candidate.folded.includes(round.start)) candidate.folded.push(round.start);
          await archiveTools(true);
        }
        // Summaries are asked at the end of the real conversation so they reuse its cached prefix.
        const fork: Fork = {base, prefix: requestFor(original).messages, model, safety: marks.safety};
        const folded = estimateRequest(requestFor(candidate));
        // The newest folded rounds stay as index lines with their ledger ranges; only older history becomes an overview,
        // unless the lines themselves are what keeps the request over the high watermark.
        const keepLines = closed.length > (policy.keep_index_lines ?? 20) ? policy.keep_index_lines ?? 20 : folded >= marks.high ? 0 : undefined;
        if (folded > marks.low && keepLines !== undefined && closed.length > keepLines) {
          const last = closed.at(-(keepLines + 1))!;
          if (!candidate.memo || last.end > candidate.memo.end) {
            const ordinal = last.record?.ordinal ?? rounds.indexOf(last) + 1;
            const memo = await this.mergeMemo(identity, projected(candidate, last.end), signal, {...fork, instruction: historyForkInstruction(ordinal)});
            if (memo) {
              candidate.memo = {end: last.end, text: memo};
              if (candidate.working && candidate.working.start < last.end) delete candidate.working;
            }
          }
        }
        if (estimateRequest(requestFor(candidate)) >= marks.high) {
          const current = rounds.findLast(round => !round.closed);
          if (current) {
            const lastBatch = pairs.filter(pair => pair.callIndex > current.start).at(-1)?.callIndex;
            const end = lastBatch ?? entries.findLastIndex(entry => entry.role === 'assistant');
            if (end > current.start + 1) {
              const start = current.start + 1;
              const written = await this.forkSummary(identity, {...fork, instruction: PROGRESS_FORK_INSTRUCTION}, signal);
              candidate.working = {start, end, text: written ?? summarizeRound(entries.slice(current.start, end).map(message), 'cancelled').report};
            }
          }
        }
        const candidateRequest = requestFor(candidate);
        const after = estimateRequest(candidateRequest), previous = estimateRequest(requestFor(original));
        if (gated ? after <= previous * (policy.compact_accept_ratio ?? COMPACT_ACCEPT_RATIO) : after < previous ||
          force && estimateRequest(candidateRequest) < marks.high && JSON.stringify({...candidate, thinkingCut: undefined}) !== JSON.stringify({...original, ...contextSnapshot(sourceMessages), thinkingCut: undefined})) {
          candidate.sourceLength = entries.length; candidate.sourceHash = digest(entries);
          signal.throwIfAborted();
          await journal.saveContext(candidate);
          signal.throwIfAborted();
          state = candidate; request = candidateRequest; compacted = true; meter.invalidate();
          const trigger = force ? 'history cleanup' : 'automatic';
          this.options.report?.(identity, `[Context] Compacted ~${before} to ~${estimateRequest(request)} tokens (${trigger}; high watermark ${marks.high}; window ${model.window}). Raw ledger retained.`);
        } else if (force && !gated) this.options.report?.(identity, '[Context] No reducible closed history; retaining the current view.');
      } catch (error) {
        signal.throwIfAborted();
        request = requestFor(original);
        this.options.report?.(identity, '[Context] Compaction failed; retaining the previous view: ' + (error instanceof Error ? error.message : 'Could not save or summarize history'));
        if (force) throw error;
      } finally {
        this.options.compacting?.(identity, false);
      }
    }
    const input = meter.estimate(request, model);
    const output = Math.floor(Math.min(this.options.maxOutput, model.maxOutput ?? Infinity, model.window - input - marks.safety));
    // Rebuilt from the request actually sent, so a compaction resets the split together with the total.
    const categories = allocateContext(input, categoryWeights(request));
    this.statistics.set(this.key(identity), {input, high: marks.high, low: marks.low, window: model.window, output: Math.max(0, output), estimated: !meter.anchored(request, model), ...(categories ? {categories} : {})});
    if (input >= marks.high || output < 1) throw new ContextBudgetError('[Context] Input still exceeds the safe budget; no request sent. Retry /compact, configure the actual model window, or reduce input. Raw history and completed effects are retained.');
    return {request: {...request, maxTokens: output}, model, compacted};
  }
  /** Asks the task's own model to summarize at the end of the real conversation; undefined when that cannot be done safely. */
  private async forkSummary(identity: Identity, fork: Fork & {instruction: string}, signal: AbortSignal): Promise<string | undefined> {
    const {model, provider} = this.options.summarizer(identity);
    if (model.identity !== fork.model.identity) return undefined; // another model has no cached prefix to reuse
    const request: ModelRequest = {...fork.base, messages: [...fork.prefix, {role: 'user', text: fork.instruction}]};
    const room = Math.floor(Math.min(SUMMARY_TOKENS + 512, model.maxOutput ?? Infinity, model.window - estimateRequest(request) - fork.safety));
    if (room < 1024) return undefined;
    try {
      const turn = await provider.respond({...request, maxTokens: room}, () => {}, signal);
      this.meter(identity).chargeUsage(turn.usage);
      const text = turn.message.text.trim();
      if (turn.stop !== 'complete' || turn.message.toolCalls?.length || !text || estimateText(text) > SUMMARY_TOKENS) return undefined;
      return text;
    } catch (error) {
      signal.throwIfAborted();
      this.options.report?.(identity, '[Context] Summary from the conversation failed; using the fallback: ' + (error instanceof Error ? error.message : String(error)));
      return undefined;
    }
  }
  private async mergeMemo(identity: Identity, messages: readonly ModelMessage[], signal: AbortSignal, fork?: Fork & {instruction: string}): Promise<string | undefined> {
    this.options.report?.(identity, '[Context] Summarizing older closed history into an overview.');
    const forked = fork ? await this.forkSummary(identity, fork, signal) : undefined;
    if (forked) return forked;
    const {model, provider} = this.options.summarizer(identity);
    const system = HISTORY_MEMO_INSTRUCTION + memoryFocusInstruction(this.summaryContract(identity));
    const text = messages.map(value => value.role + ': ' + JSON.stringify(value)).join('\n');
    const limit = Math.max(1, Math.floor((model.window - estimateText(system) - 128) / 3));
    if (limit < 64) throw new Error('Summary model window is too small');
    const chunks: string[] = [];
    let chunk = '', size = 0;
    for (const char of text) {
      const weight = char.codePointAt(0)! > 0x7f ? 1 : 0.25;
      if (size + weight > limit) {chunks.push(chunk); chunk = ''; size = 0;}
      chunk += char; size += weight;
    }
    if (chunk) chunks.push(chunk);
    if (chunks.length > 16) throw new Error('History exceeds the 16-chunk summary limit');
    let memo = '';
    for (const part of chunks) {
      signal.throwIfAborted();
      const request: ModelRequest = {system, messages: [{role: 'user', text: (memo ? 'Existing memo: \n' + memo + '\nAdditional history: \n' : '') + part}],
        tools: [], thinking: false};
      const input = estimateRequest(request), available = model.window - input - 128;
      if (available <= 0) throw new Error('Summary input exceeds the model window');
      const turn = await provider.respond({...request, maxTokens: Math.floor(Math.min(SUMMARY_TOKENS + 512, model.maxOutput ?? Infinity, available))}, () => {}, signal);
      this.meter(identity).chargeUsage(turn.usage);
      const next = turn.message.text.trim();
      if (turn.stop !== 'complete' || turn.message.toolCalls?.length || !next || estimateText(next) > SUMMARY_TOKENS ||
        estimateText(next) >= estimateText(memo + part)) throw new Error('Model summary is invalid or does not reduce history');
      memo = next;
    }
    return memo || undefined;
  }
}
