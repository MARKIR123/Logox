import {appendFile, mkdir, readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {z} from 'zod';
import {modelMessageSchema} from '../runtime/messages.js';
import {contextStateSchema, roundSchema, summarizeRound, type ContextState, type RoundRecord, type RoundStatus, type RoundSummary} from '../context/contracts.js';
import {digest} from '../context/budget.js';
import {atomicWrite} from '../tools/snapshots.js';

const entrySchema = z.strictObject({
  version: z.literal(1), sessionId: z.string(), ownerId: z.string(),
  role: z.enum(['user', 'assistant', 'tool']), text: z.string(),
  time: z.number().optional(), message: modelMessageSchema.optional(), activityId: z.string().optional(), source: z.string().optional(),
}).refine(entry => !entry.message || entry.message.role === entry.role && entry.message.text === entry.text, '历史正文或角色不一致');
export type HistoryEntry = z.infer<typeof entrySchema>;
export interface HistoryStore {
  load(sessionId: string, ownerId: string): Promise<readonly HistoryEntry[]>;
  append(entry: HistoryEntry): Promise<void>;
  finish?(sessionId: string, ownerId: string, activityId: string, status: RoundStatus): Promise<RoundSummary>;
}
export class Journal implements HistoryStore {
  constructor(private readonly directory: string) {}
  path(sessionId: string, ownerId: string): string {
    const key = createHash('sha256').update(JSON.stringify([sessionId, ownerId])).digest('hex');
    return join(this.directory, key + '.jsonl');
  }
  reference(sessionId: string, ownerId: string, start: number, end: number): string {
    return this.path(sessionId, ownerId) + '（行 ' + (start + 1) + '–' + end + '）';
  }
  async load(sessionId: string, ownerId: string): Promise<readonly HistoryEntry[]> {
    const text = await this.read(this.path(sessionId, ownerId));
    if (text === undefined) return [];
    if (text && !text.endsWith('\n')) throw new Error('账本末行未完整提交，请检查备份后恢复');
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    if (lines.some(line => !line.trim())) throw new Error('账本含空行，无法保证原文回读行号');
    return lines.map(line => {
      const entry = entrySchema.parse(JSON.parse(line));
      if (entry.sessionId !== sessionId || entry.ownerId !== ownerId) throw new Error('角色账本身份不匹配');
      return Object.freeze(entry);
    });
  }
  async append(raw: HistoryEntry): Promise<void> {
    const entry = entrySchema.parse({...raw, time: raw.time ?? Date.now()});
    await mkdir(this.directory, {recursive: true});
    await appendFile(this.path(entry.sessionId, entry.ownerId), JSON.stringify(entry) + '\n', 'utf8');
  }
  private async read(file: string): Promise<string | undefined> {
    try {return await readFile(file, 'utf8');}
    catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error;}
  }
  async rounds(sessionId: string, ownerId: string, entries: readonly HistoryEntry[]): Promise<RoundRecord[]> {
    const raw = await this.read(this.path(sessionId, ownerId) + '.rounds.json');
    if (raw === undefined) return [];
    const records = z.array(roundSchema).parse(JSON.parse(raw));
    return records.filter(record => record.end <= entries.length && record.start < record.end &&
      entries[record.start]?.activityId === record.activityId && digest(entries.slice(record.start, record.end)) === record.sourceHash);
  }
  async finish(sessionId: string, ownerId: string, activityId: string, status: RoundStatus): Promise<RoundSummary> {
    const entries = await this.load(sessionId, ownerId);
    const start = entries.findLastIndex(entry => entry.activityId === activityId && entry.role === 'user');
    if (start < 0) throw new Error('轮次输入没有落账');
    const messages = entries.slice(start).map(entry => entry.message ?? {role: entry.role === 'tool' ? 'user' as const : entry.role, text: entry.text});
    const summary = summarizeRound(messages, status);
    const records = (await this.rounds(sessionId, ownerId, entries)).filter(record => record.activityId !== activityId);
    records.push({activityId, start, end: entries.length, sourceHash: digest(entries.slice(start)), status, summary});
    await atomicWrite(this.path(sessionId, ownerId) + '.rounds.json', Buffer.from(JSON.stringify(records)));
    return summary;
  }
  async loadContext(sessionId: string, ownerId: string, entries: readonly HistoryEntry[]): Promise<ContextState | undefined> {
    const raw = await this.read(this.path(sessionId, ownerId) + '.context.json');
    if (raw === undefined) return undefined;
    const state = contextStateSchema.parse(JSON.parse(raw));
    if (state.sessionId !== sessionId || state.ownerId !== ownerId || state.sourceLength > entries.length ||
      digest(entries.slice(0, state.sourceLength)) !== state.sourceHash) return undefined;
    const inRange = (index: number) => index >= 0 && index < state.sourceLength;
    if (state.folded.some(index => !inRange(index) || entries[index]?.role !== 'user') ||
      state.memo && (state.memo.end > state.sourceLength || state.memo.end < state.sourceLength && entries[state.memo.end]?.role !== 'user') ||
      state.working && (state.working.start >= state.working.end || state.working.end > state.sourceLength || state.memo && state.working.start < state.memo.end || entries.slice(state.working.start, state.working.end).some(entry => entry.role === 'user'))) return undefined;
    for (const archive of state.archives) {
      const assistant = entries[archive.callIndex]?.message, result = entries[archive.resultIndex]?.message;
      if (!inRange(archive.callIndex) || !inRange(archive.resultIndex) || archive.callIndex >= archive.resultIndex ||
        assistant?.role !== 'assistant' || result?.role !== 'tool' || !assistant.toolCalls?.some(call => call.id === result.callId)) return undefined;
      const content = await this.read(this.archivePath(sessionId, ownerId, archive.hash));
      const call = assistant.toolCalls.find(call => call.id === result.callId);
      if (content !== JSON.stringify({call, result}) || content === undefined || createHash('sha256').update(content).digest('hex') !== archive.hash) return undefined;
    }
    return state;
  }
  async saveContext(state: ContextState): Promise<void> {
    contextStateSchema.parse(state);
    await atomicWrite(this.path(state.sessionId, state.ownerId) + '.context.json', Buffer.from(JSON.stringify(state)));
  }
  archivePath(sessionId: string, ownerId: string, hash: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('工具归档身份无效');
    return join(this.path(sessionId, ownerId) + '.tools', hash + '.json');
  }
  async archive(sessionId: string, ownerId: string, value: unknown): Promise<string> {
    const text = JSON.stringify(value), hash = createHash('sha256').update(text).digest('hex');
    const file = this.archivePath(sessionId, ownerId, hash), existing = await this.read(file);
    if (existing !== undefined && existing !== text) throw new Error('工具归档内容校验失败');
    if (existing === undefined) await atomicWrite(file, Buffer.from(text));
    return hash;
  }
}
