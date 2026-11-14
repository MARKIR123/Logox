import {DIRECTOR_ID, isDirector} from '../runtime/director-id.js';
import type {ContextPolicy} from '../config/config.js';
import type {ModelMessage, ModelRequest, ModelTurn, Provider, ToolCall, TurnUsage} from '../runtime/messages.js';
import {createRuntimeContextMessage} from '../runtime/context-updates.js';
import {normalizeMessages} from '../runtime/messages.js';
import {inputMessage} from '../runtime/provenance.js';
import {Journal, storedMessage, type HistoryEntry, type TaskCheckpoint} from '../store/journal.js';
import {digest, estimateMessage, estimateRequest, estimateText, TokenMeter, watermarks} from './budget.js';
import {supersededReads} from './supersession.js';
import {summarizeRound, memoryFocusInstruction, HISTORY_MEMO_INSTRUCTION, type ContextState, type ModelCapacity, type RoundRecord} from './contracts.js';
import {PROGRESS_FORK_INSTRUCTION, supersededReadText} from '../prompts/compaction.js';
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
  /** Prompt cache lifetime of the owner's current model in milliseconds (`providers/cache.ts:cacheLifetimeMs`); undefined when unknown, which counts as never expired. */
  cacheLifetimeMs?(identity: Identity): number | undefined | Promise<number | undefined>;
  /** Clock for the cache-expiry check; tests inject it. */
  now?(): number;
  /** Working directory that relative `Read` paths resolve against when deciding which reads a later read supersedes; defaults to the process directory. */
  cwd?: string;
  /** Source of list prices for the cost stored with each turn's usage (see `cost.ts:costOf`). */
  pricing?: Parameters<typeof costOf>[1];
}
export class ContextBudgetError extends Error {}
/** What a routine fold at the start of a round may do: `keepLast` leaves the latest closed round in full (the new task continues its root task). */
export interface RoundStartFold {keepLast: boolean}
/** Upper bound for a model-written overview or progress summary. */
const SUMMARY_TOKENS = 4000;
/** A superseded read may be tombstoned while the cache is warm only when at most this many estimated tokens follow it in the request. */
export const SUPERSEDE_SUFFIX_TOKENS = 8000;
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
  /**
   * Called when an activity that opens a round (or a Director activity that continues one) starts, before its first model request. It runs
   * the routine fold of `prepare()`: a companion folds every closed round at the end of the history unless the new task continues the root
   * task of its latest round; Logox folds down to its recent rounds when its cache has expired or the request is at half the high watermark.
   */
  async roundStart(identity: Identity, base: Pick<ModelRequest, 'system' | 'tools' | 'toolDiscovery'>, signal: AbortSignal, fold: RoundStartFold, appendOnly = false): Promise<void> {
    await this.prepare(identity, base, signal, false, fold, appendOnly);
  }
  /**
   * Stopped or failed rounds the routine folds leave alone, by start index. A round unpins once it was resumed and the resumption completed,
   * or its root task ended: for a companion the Director round that dispatched it is closed; for Logox, or a task nobody dispatched, a later
   * round completed normally. Any lookup failure keeps the round pinned.
   */
  private async pinnedStarts(identity: Identity, rounds: readonly Round[]): Promise<Set<number>> {
    const stopped = rounds.filter(round => round.closed && round.record && round.record.status !== 'completed');
    const pinned = new Set<number>();
    if (!stopped.length) return pinned;
    const {journal} = this.options;
    let tasks: TaskCheckpoint[];
    try {tasks = await journal.activeTasks(identity.sessionId);}
    catch {for (const round of stopped) pinned.add(round.start); return pinned;}
    const completed = (activityId: string) => rounds.some(round => round.record?.activityId === activityId && round.record.status === 'completed');
    for (const round of stopped) {
      const record = round.record!;
      try {
        if (tasks.some(task => task.ownerId === identity.ownerId && task.resumeTaskId === record.activityId && completed(task.activityId))) continue;
        const root = isDirector(identity.ownerId) ? undefined : tasks.find(task => task.activityId === record.activityId)?.rootActivityId;
        let ended: boolean | undefined;
        if (root && root !== record.activityId) {
          const director = await journal.load(identity.sessionId, DIRECTOR_ID);
          const at = director.findIndex(entry => entry.role === 'user' && entry.activityId === root);
          if (at >= 0) ended = (await journal.rounds(identity.sessionId, DIRECTOR_ID, director)).some(item => item.start <= at && at < item.end);
          else {const status = tasks.find(task => task.activityId === root)?.status; ended = status === undefined ? undefined : ['completed', 'failed', 'cancelled'].includes(status);}
        }
        ended ??= rounds.some(other => other.record?.status === 'completed' && other.start > round.start);
        if (!ended) pinned.add(round.start);
      } catch {pinned.add(round.start);}
    }
    return pinned;
  }
  /** `appendOnly` (the provider binds replayed thinking to every earlier message) forbids rewriting any sent message, so superseded reads stay in full. */
  async prepare(identity: Identity, base: Pick<ModelRequest, 'system' | 'tools' | 'toolDiscovery'>, signal: AbortSignal, force = false, routine?: RoundStartFold, appendOnly = false):
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
    const pairByCall = new Map(pairs.map(pair => [pair.call.id, pair]));
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
      // A superseded read keeps its place and its call; only the result shrinks to one line. An archived result stays archived.
      for (const [callId, range] of Object.entries(candidate.superseded ?? {})) {
        const pair = pairByCall.get(callId), result = pair ? raw[pair.resultIndex] : undefined;
        if (!pair || result?.role !== 'tool' || candidate.archives.some(archive => archive.resultIndex === pair.resultIndex)) continue;
        const {images: _images, ...bare} = result;
        raw[pair.resultIndex] = {...bare, text: supersededReadText(range)};
      }
      const output: ModelMessage[] = [];
      const retain =(start: number, end: number, recent = false) => {
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
        if (!candidate.folded.includes(round.start)) {emit(round.start, Math.min(round.end, end)); continue;}
        const summary = round.record?.summary ?? summarizeRound(entries.slice(round.start, round.end).map(message), 'failed');
        const memory = round.record?.memory;
        const lines = journal.sourceLines(identity.sessionId, identity.ownerId, round.start, round.end);
        const activityOrdinal = activityIds.indexOf(entries[round.start]?.activityId ?? '') + 1;
        output.push({role: 'assistant', text: formatRoundIndex({
          ordinal: round.record?.ordinal ?? (activityOrdinal || rounds.indexOf(round) + 1),
          title: memory && memory.source !== 'legacy' ? memory.title : summary.title,
          summary: memory && memory.source !== 'legacy' ? memory.summary : [round.record?.status === 'completed' ? '' : ROUND_MARKERS[round.record?.status ?? 'failed'], 'Legacy record; inspect evidence before relying on its claims.', summary.report].filter(Boolean).join(' '),
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
    let before = meter.estimate(requestFor(state), model);
    // Pinned rounds (stopped or failed, root task still open) are folded by no rule except the last resort below the watermark.
    let pinnedStarts: Set<number> | undefined;
    const pinned = async () => pinnedStarts ??= await this.pinnedStarts(identity, rounds);
    const snapshot = (value: ContextState): ContextState => ({...structuredClone(value), ...contextSnapshot(sourceMessages), thinkingCut: entries.length, sourceLength: entries.length, sourceHash: digest(entries)});
    // The routine fold is mechanical: it only lists closed rounds as folded and never calls the model. A companion's replacement point is the
    // end of its history (a new task is starting), so it costs no cache; Logox pays only when its cache has expired anyway or the request is at half the high watermark.
    // The cache counts as expired only when its lifetime is known and the last assistant entry is at least that old; unknown means never.
    const cacheCold = async (): Promise<boolean> => {
      let lifetime: number | undefined;
      try {lifetime = await this.options.cacheLifetimeMs?.(identity);} catch {lifetime = undefined;}
      const lastReply = entries.findLast(entry => entry.role === 'assistant')?.time;
      return lifetime !== undefined && lastReply !== undefined && (this.options.now?.() ?? Date.now()) - lastReply >= lifetime;
    };
    // Reads a later read covers and this view does not yet show as tombstones. Never on an append-only protocol.
    const cwd = this.options.cwd ?? process.cwd();
    const unseen = (value: ContextState): Record<string, string> => appendOnly ? {} :
      Object.fromEntries([...supersededReads(sourceMessages, cwd)].filter(([id]) => !value.superseded?.[id]));
    if (routine && !force) {
      let due = !isDirector(identity.ownerId);
      if (!due) due = await cacheCold() || before >= marks.high / 2;
      const targets = isDirector(identity.ownerId) ? closed.slice(0, Math.max(0, closed.length - policy.keep_recent_rounds)) : routine.keepLast ? [] : closed;
      const already = new Set(state.folded), fresh = due ? targets.filter(round => !already.has(round.start)) : [];
      if (fresh.length) {
        const held = await pinned();
        const starts = fresh.filter(round => !held.has(round.start)).map(round => round.start);
        if (starts.length) {
          // The fold already changes the request bytes after its first replaced round, so every covered read is tombstoned in the same save.
          const covered = {...state.superseded, ...unseen(state)};
          const next = snapshot({...state, folded: [...state.folded, ...starts], ...(Object.keys(covered).length ? {superseded: covered} : {})});
          try {
            await journal.saveContext(next);
            signal.throwIfAborted();
            state = next; original = next; meter.invalidate();
            const after = meter.estimate(requestFor(state), model);
            if (isDirector(identity.ownerId)) this.options.report?.(identity, `[Context] Folded ${starts.length} closed round${starts.length === 1 ? '' : 's'} into index lines (~${before} to ~${after} tokens).`);
            before = after;
          } catch (error) {signal.throwIfAborted();}
        }
      }
    }
    // A tombstone changes every byte after it, so a covered read is shrunk only when the cache is cold anyway or little follows it; the
    // decision is saved in the view and never taken back. Folds and compactions tombstone all of them in their own save.
    const fresh = force ? {} : unseen(state);
    if (Object.keys(fresh).length) {
      const sent = requestFor(state).messages, cold = await cacheCold();
      const costs = sent.map(estimateMessage);
      let after = 0;
      const tail = new Array<number>(sent.length);
      for (let index = sent.length - 1; index >= 0; index--) {tail[index] = after; after += costs[index]!;}
      const chosen = Object.fromEntries(Object.entries(fresh).filter(([id]) => {
        const at = sent.findIndex(value => value.role === 'tool' && value.callId === id);
        return at >= 0 && (cold || tail[at]! <= SUPERSEDE_SUFFIX_TOKENS);
      }));
      if (Object.keys(chosen).length) {
        const next: ContextState = {...structuredClone(state), superseded: {...state.superseded, ...chosen}, sourceLength: entries.length, sourceHash: digest(entries)};
        try {
          await journal.saveContext(next);
          signal.throwIfAborted();
          state = next; original = next; meter.invalidate();
          before = meter.estimate(requestFor(state), model);
        } catch {signal.throwIfAborted();}
      }
    }
    let compacted = false, request = requestFor(state);
    if (force || before >= marks.high) {
      this.options.beforeCompact?.(identity, before);
      this.options.compacting?.(identity, true);
      try {
        // A compacted view never sends thinking from before this point, including in the request built right now.
        const candidate: ContextState = {...structuredClone(state), ...contextSnapshot(sourceMessages), thinkingCut: entries.length};
        const covered = unseen(state);
        if (Object.keys(covered).length) candidate.superseded = {...candidate.superseded, ...covered};
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
        const fold = (list: readonly Round[]) => {for (const round of list) if (!candidate.folded.includes(round.start)) candidate.folded.push(round.start);};
        const held = await pinned(), foldable = closed.filter(round => !held.has(round.start));
        await archiveTools(false);
        // The recent rounds stay unless that is not enough; `/compact` takes the same ladder.
        fold(closed.slice(0, Math.max(0, closed.length - policy.keep_recent_rounds)).filter(round => !held.has(round.start)));
        if (estimateRequest(requestFor(candidate)) > marks.low) {
          fold(foldable);
          await archiveTools(true);
        }
        // Last resort before any model call: stopped or failed rounds fold too.
        if (estimateRequest(requestFor(candidate)) >= marks.high) fold(closed);
        // Summaries are asked at the end of the real conversation so they reuse its cached prefix.
        const fork: Fork = {base, prefix: requestFor(original).messages, model, safety: marks.safety};
        // The one model-written merge: the index lines themselves keep the request over the high watermark, so the oldest lines
        // (and any earlier overview) become one overview, as many as it takes to get below the low watermark. Its input is only those lines.
        const lines = closed.filter(round => !candidate.memo || round.end > candidate.memo.end);
        if (lines.length && estimateRequest(requestFor(candidate)) >= marks.high) {
          const reserved = 'x'.repeat(Math.min(SUMMARY_TOKENS, Math.floor(marks.low / 4)) * 4);
          const merged = (end: number) => estimateRequest(requestFor({...candidate, memo: {end, text: reserved}}));
          if (merged(lines.at(-1)!.end) < marks.high) {
            const last = lines.find(round => merged(round.end) <= marks.low) ?? lines.at(-1)!;
            const memo = await this.mergeMemo(identity, projected(candidate, last.end), signal);
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
        if (after < previous ||
          force && after < marks.high && JSON.stringify({...candidate, thinkingCut: undefined}) !== JSON.stringify({...original, ...contextSnapshot(sourceMessages), thinkingCut: undefined})) {
          candidate.sourceLength = entries.length; candidate.sourceHash = digest(entries);
          signal.throwIfAborted();
          await journal.saveContext(candidate);
          signal.throwIfAborted();
          state = candidate; request = candidateRequest; compacted = true; meter.invalidate();
          const trigger = force ? 'history cleanup' : 'automatic';
          this.options.report?.(identity, `[Context] Compacted ~${before} to ~${estimateRequest(request)} tokens (${trigger}; high watermark ${marks.high}; window ${model.window}). Raw ledger retained.`);
        } else if (force) this.options.report?.(identity, '[Context] No reducible closed history; retaining the current view.');
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
  private async mergeMemo(identity: Identity, messages: readonly ModelMessage[], signal: AbortSignal): Promise<string | undefined> {
    this.options.report?.(identity, '[Context] Merging the oldest index lines into an overview.');
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
