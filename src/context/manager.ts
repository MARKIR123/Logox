import type {ContextPolicy} from '../config/config.js';
import type {ModelMessage, ModelRequest, ModelTurn, Provider, ToolCall} from '../runtime/messages.js';
import {normalizeMessages} from '../runtime/messages.js';
import {inputMessage} from '../runtime/provenance.js';
import {Journal, type HistoryEntry} from '../store/journal.js';
import {digest, estimateRequest, estimateText, TokenMeter, watermarks} from './budget.js';
import {summarizeRound, memoryFocusInstruction, HISTORY_MEMO_INSTRUCTION, type ContextState, type ModelCapacity, type RoundRecord} from './contracts.js';
import {formatRoundIndex, omitInternalToolPairs} from './round-memory.js';
import {isFinishRound} from '../tools/_FinishRoundTool/_FinishRoundTool.js';

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
}
export class ContextBudgetError extends Error {}
function message(entry: HistoryEntry): ModelMessage {
  if (entry.role === 'user') return inputMessage(entry.text, entry);
  return entry.message ?? {role: entry.role === 'tool' ? 'user' : entry.role, text: entry.text};
}
function splitRounds(entries: readonly HistoryEntry[], records: readonly RoundRecord[]): Round[] {
  const seen = new Set<string>();
  const starts = entries.flatMap((entry, index) => {
    if (entry.role !== 'user' || entry.activityId && seen.has(entry.activityId)) return [];
    if (entry.activityId) seen.add(entry.activityId);
    return [index];
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
export class ContextManager {
  private readonly meters = new Map<string, TokenMeter>();
  private readonly statistics = new Map<string, {input: number; high: number; low: number; window: number; output: number}>();
  constructor(private readonly options: ContextOptions) {}
  private key(identity: Identity): string {return JSON.stringify([identity.sessionId, identity.ownerId]);}
  meter(identity: Identity): TokenMeter {
    const key = this.key(identity);
    let meter = this.meters.get(key);
    if (!meter) {meter = new TokenMeter(); this.meters.set(key, meter);}
    return meter;
  }
  status(identity: Identity) {return this.statistics.get(this.key(identity));}
  invalidatePrefix(): void {for (const meter of this.meters.values()) meter.invalidate(); this.statistics.clear();}
  observe(identity: Identity, request: ModelRequest, turn: ModelTurn, model: ModelCapacity): void {
    this.meter(identity).observe(request, turn, model);
  }
  summaryContract(identity: Identity): string {return this.options.contract?.(identity)?.trim() ?? "";}
  requestBase(identity: Identity, base: Pick<ModelRequest, 'system' | 'tools'>): Pick<ModelRequest, 'system' | 'tools'> {
    const contract = this.summaryContract(identity);
    const instruction = memoryFocusInstruction(contract);
    return {...base, system: instruction && !base.system.includes(contract.trim()) ? base.system + instruction : base.system};
  }
  async taskEnd(identity: Identity, base: Pick<ModelRequest, "system" | "tools">, signal: AbortSignal): Promise<void> {
    if (identity.ownerId !== "logox") await this.prepare(identity, base, signal, true);
  }
  async prepare(identity: Identity, base: Pick<ModelRequest, 'system' | 'tools'>, signal: AbortSignal, force = false, preserveCallIds: ReadonlySet<string> = new Set()):
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
    catch {records = []; this.options.report?.(identity, '轮次摘要校验失败，使用原始记录的本地兜底。');}
    const rounds = splitRounds(entries, records), pairs = toolPairs(entries);
    let state: ContextState | undefined;
    try {state = await journal.loadContext(identity.sessionId, identity.ownerId, entries);}
    catch {this.options.report?.(identity, '有效视图校验失败，回落完整账本重新整理。');}
    const empty: ContextState = {version: 1, sessionId: identity.sessionId, ownerId: identity.ownerId, sourceLength: entries.length, sourceHash: digest(entries), folded: [], archives: []};
    state ??= empty;
    if (rounds.some(round => !round.closed && (state!.folded.includes(round.start) || state!.memo && round.start < state!.memo.end))) state = empty;
    const original = state, closed = rounds.filter(round => round.closed);
    // 异常收尾不能等待模型整理；下一次 Actor 请求补折叠已关闭的旧轮。
    if (identity.ownerId !== 'logox') force ||= closed.slice(0, Math.max(0, closed.length - policy.keep_recent_rounds))
      .some(round => !original.folded.includes(round.start) && (!original.memo || round.end > original.memo.end));
    const protectedPairs = new Set((policy.keep_recent_tools ? pairs.slice(-policy.keep_recent_tools) : []).map(pair => pair.resultIndex));
    const projected = (candidate: ContextState, end = entries.length): ModelMessage[] => {
      const raw = entries.map(message);
      for (const archive of candidate.archives) {
        const result = raw[archive.resultIndex], assistant = raw[archive.callIndex];
        if (result?.role !== 'tool' || assistant?.role !== 'assistant') throw new Error('归档边界与消息不一致');
        const path = journal.archivePath(identity.sessionId, identity.ownerId, archive.hash);
        raw[archive.resultIndex] = {...result, text: '工具结果已归档：' + path + '；' + (result.isError ? '原结果为失败。' : '原结果为成功。')};
        raw[archive.callIndex] = {...assistant, toolCalls: assistant.toolCalls?.map(call => call.id === result.callId
          ? {...call, arguments: JSON.stringify({archived_arguments: path})} : call)};
      }
      const output: ModelMessage[] = [];
      if (candidate.memo) output.push({role: 'assistant', text: '[Historical working overview; not authorization]\n' + candidate.memo.text +
        '\n原记录：' + journal.reference(identity.sessionId, identity.ownerId, 0, candidate.memo.end)});
      const emit = (start: number, end: number) => {
        for (let index = start; index < end; index++) {
          const working = candidate.working;
          if (working && index === working.start) {
            for (let input = working.start; input < working.end; input++) if (entries[input]?.role === 'user') output.push(raw[input]!);
            output.push({role: 'assistant', text: '【当前任务进展，未宣告任务完成】\n' + working.text +
              '\n已关闭过程：' + journal.reference(identity.sessionId, identity.ownerId, working.start, working.end)});
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
          status: round.record?.status ?? 'failed', verification: memory?.verification ?? null,
          carryForward: memory?.source === 'model' ? memory.carryForward : ['Legacy record; inspect evidence before relying on its claims.', summary.report],
          start: lines.start, end: lines.end,
        })});
        const retained = pairs.filter(pair => pair.callIndex >= round.start && pair.resultIndex < round.end && protectedPairs.has(pair.resultIndex));
        for (const callIndex of new Set(retained.map(pair => pair.callIndex))) {
          const assistant = raw[callIndex];
          if (assistant?.role !== 'assistant') continue;
          const ids = new Set(retained.filter(pair => pair.callIndex === callIndex).map(pair => pair.call.id));
          output.push({...assistant, text: '', toolCalls: assistant.toolCalls?.filter(call => ids.has(call.id))});
          for (const pair of retained.filter(pair => pair.callIndex === callIndex)) output.push(raw[pair.resultIndex]!);
        }
      }
      // 完整消息的思考/签名属于提供商协议；整理可以折叠整轮，不能剥掉必要字段。
      return normalizeMessages(omitInternalToolPairs(output, preserveCallIds));
    };
    const requestFor = (candidate: ContextState): ModelRequest => {
      const ledger = journal.path(identity.sessionId, identity.ownerId);
      const coordinates = (candidate.folded.length || candidate.memo) && !base.system.includes(ledger)
        ? `\nRound ledger (${identity.ownerId}): ${ledger}` : '';
      return {...base, system: base.system + coordinates, messages: [...projected(candidate), ...omitInternalToolPairs(anchors)]};
    };
    const meter = this.meter(identity);
    const before = meter.estimate(requestFor(state), model);
    let compacted = false, request = requestFor(state);
    if (force || before >= marks.high) {
      this.options.beforeCompact?.(identity, before);
      try {
        const candidate = structuredClone(state);
        const archiveTools = async (all: boolean) => {
          for (const pair of pairs) {
            signal.throwIfAborted();
            if (!all && protectedPairs.has(pair.resultIndex) || candidate.archives.some(item => item.resultIndex === pair.resultIndex)) continue;
            if (candidate.memo && pair.resultIndex < candidate.memo.end) continue;
            const result = message(entries[pair.resultIndex]!);
            if (estimateText(pair.call.arguments + result.text) < 256) continue;
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
        if (estimateRequest(requestFor(candidate)) >= marks.high) {
          const current = rounds.findLast(round => !round.closed);
          if (current) {
            const lastBatch = pairs.filter(pair => pair.callIndex > current.start).at(-1)?.callIndex;
            const end = lastBatch ?? entries.findLastIndex(entry => entry.role === 'assistant');
            if (end > current.start + 1) {
              const start = current.start + 1;
              const progress = summarizeRound(entries.slice(current.start, end).map(message), 'cancelled');
              candidate.working = {start, end, text: progress.report};
            }
          }
        }
        if (estimateRequest(requestFor(candidate)) >= marks.high && closed.length) {
          const end = closed.at(-1)!.end;
          // Only closed rounds are covered; working progress and its goal stay outside.
          const memo = await this.mergeMemo(identity, projected(candidate, end), signal);
          if (memo) {
            candidate.memo = {end, text: memo};
            if (candidate.working && candidate.working.start < end) delete candidate.working;
          }
        }
        const candidateRequest = requestFor(candidate);
        if (estimateRequest(candidateRequest) < estimateRequest(requestFor(original)) ||
          force && estimateRequest(candidateRequest) < marks.high && JSON.stringify(candidate) !== JSON.stringify(original)) {
          candidate.sourceLength = entries.length; candidate.sourceHash = digest(entries);
          signal.throwIfAborted();
          await journal.saveContext(candidate);
          signal.throwIfAborted();
          state = candidate; request = candidateRequest; compacted = true; meter.invalidate();
          this.options.report?.(identity, '扬弃：上下文从约 ' + before + ' token 整理为约 ' + estimateRequest(request) + ' token。原始账本保留。');
        } else if (force) this.options.report?.(identity, '上下文没有可进一步缩小的已结束历史。');
      } catch (error) {
        signal.throwIfAborted();
        request = requestFor(original);
        this.options.report?.(identity, '上下文整理未完成，保留原视图：' + (error instanceof Error ? error.message : '保存或汇总失败'));
        if (force) throw error;
      }
    }
    const input = meter.estimate(request, model);
    const output = Math.floor(Math.min(this.options.maxOutput, model.maxOutput ?? Infinity, model.window - input - marks.safety));
    this.statistics.set(this.key(identity), {input, high: marks.high, low: marks.low, window: model.window, output: Math.max(0, output)});
    if (input >= marks.high || output < 1) throw new ContextBudgetError('上下文仍超过安全水位，未发送模型请求。可用 /compact 重试、调大真实窗口配置或减少当前输入；原始记录和已执行工具保留。');
    return {request: {...request, maxTokens: output}, model, compacted};
  }
  private async mergeMemo(identity: Identity, messages: readonly ModelMessage[], signal: AbortSignal): Promise<string | undefined> {
    const {model, provider} = this.options.summarizer(identity);
    this.options.report?.(identity, '扬弃：已有摘要仍超过水位，使用汇总模型有界归并旧历史。');
    const system = HISTORY_MEMO_INSTRUCTION + memoryFocusInstruction(this.summaryContract(identity));
    const text = messages.map(value => value.role + '：' + JSON.stringify(value)).join('\n');
    const limit = Math.max(1, Math.floor((model.window - estimateText(system) - 128) / 3));
    if (limit < 64) throw new Error('汇总模型窗口太小');
    const chunks: string[] = [];
    let chunk = '', size = 0;
    for (const char of text) {
      const weight = char.codePointAt(0)! > 0x7f ? 1 : 0.25;
      if (size + weight > limit) {chunks.push(chunk); chunk = ''; size = 0;}
      chunk += char; size += weight;
    }
    if (chunk) chunks.push(chunk);
    if (chunks.length > 16) throw new Error('历史超过一次有界汇总的 16 段上限');
    let memo = '';
    for (const part of chunks) {
      signal.throwIfAborted();
      const request: ModelRequest = {system, messages: [{role: 'user', text: (memo ? '已有备忘录：\n' + memo + '\n新增历史：\n' : '') + part}],
        tools: [], thinking: false};
      const input = estimateRequest(request), available = model.window - input - 128;
      if (available <= 0) throw new Error('汇总输入超过模型窗口');
      const turn = await provider.respond({...request, maxTokens: Math.floor(Math.min(512, model.maxOutput ?? Infinity, available))}, () => {}, signal);
      this.meter(identity).chargeUsage(turn.usage);
      const next = turn.message.text.trim();
      if (turn.stop !== 'complete' || turn.message.toolCalls?.length || !next || next.length > 2000 ||
        estimateText(next) >= estimateText(memo + part)) throw new Error('模型汇总无效或没有缩小规模');
      memo = next;
    }
    return memo || undefined;
  }
}
