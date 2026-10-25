import {appendFile, mkdir, readFile} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {z} from 'zod';
import {modelMessageSchema, type ModelMessage} from '../runtime/messages.js';
import {taskOriginSchema, stepSchema, taskProgressSchema, type TaskProgressSnapshot} from '../runtime/contracts.js';
import {inputKindSchema} from '../runtime/provenance.js';
import {deliverySchema, type Delivery} from '../runtime/delivery.js';
import {systemEventSchema, type SystemEvent} from '../runtime/system-events.js';
import {contextStateSchema, roundSchema, summarizeRound, type ContextState, type RoundRecord, type RoundStatus, type RoundSummary} from '../context/contracts.js';
import {digest} from '../context/budget.js';
import {extractRoundMemory, type RoundMemory} from '../context/round-memory.js';
import {isFinishRound} from '../tools/protocol/_FinishRoundTool/_FinishRoundTool.js';
import {atomicWrite} from '../tools/snapshots.js';

const entrySchema = z.strictObject({
  version: z.literal(1), sessionId: z.string(), ownerId: z.string(),
  role: z.enum(['user', 'assistant', 'tool']), text: z.string(),
  time: z.number().optional(), message: modelMessageSchema.optional(), activityId: z.string().optional(), source: z.string().optional(),
  inputKind: inputKindSchema.optional(), step: stepSchema.optional(), deliveryIds: z.array(z.string()).optional(),
}).refine(entry => !entry.message || entry.message.role === entry.role && entry.message.text === entry.text, '历史正文或角色不一致');
export type HistoryEntry = z.infer<typeof entrySchema>;
const branchSchema = z.strictObject({version: z.literal(1), id: z.string().regex(/^(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})?$/), sessionId: z.string(),
  hidden: z.record(z.string(), z.array(z.number().int().nonnegative())), excludedTasks: z.array(z.string()).default([])});
const taskSchema = z.strictObject({activityId: z.string(), ownerId: z.string(), prompt: z.string(), source: z.string(),
  status: z.enum(['queued', 'running', 'waiting_input', 'paused', 'completed', 'failed', 'cancelled']), time: z.number(),
  ...taskOriginSchema.shape,
  progress: taskProgressSchema.optional(),
  handoff: deliverySchema.optional(),
  error: z.string().max(2048).optional()});
export const collaborationSchema = z.strictObject({
  id: z.string().uuid(), sessionId: z.string(), activityId: z.string(), requester: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  target: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), reason: z.string().min(1).max(2000),
  relatedActivities: z.array(z.string()).optional(),
  status: z.enum(['pending', 'approved', 'rejected', 'closed', 'interrupted']),
  messages: z.array(z.strictObject({from: z.string(), text: z.string().min(1).max(2000), activityId: z.string()})).max(6),
});
export type CollaborationRecord = z.infer<typeof collaborationSchema>;
export type TaskCheckpoint = z.infer<typeof taskSchema>;
const pendingSchema = z.strictObject({sessionId: z.string(), target: z.string(), activities: z.array(z.string())})
  .refine(value => value.activities.includes(value.target), '回退区间不包含目标');
export interface HistoryStore {
  load(sessionId: string, ownerId: string): Promise<readonly HistoryEntry[]>;
  append(entry: HistoryEntry): Promise<void>;
  finish?(sessionId: string, ownerId: string, activityId: string, status: RoundStatus): Promise<RoundSummary>;
  finishRecord?(sessionId: string, ownerId: string, activityId: string, status: RoundStatus, finalizerCallId?: string | null): Promise<RoundRecord>;
  checkpoint?(sessionId: string, task: TaskCheckpoint): Promise<void>;
  progress?(sessionId: string, ownerId: string, activityId: string): Promise<TaskProgressSnapshot | undefined>;
  activeTasks?(sessionId: string): Promise<TaskCheckpoint[]>;
  loadDeliveries?(sessionId: string): Promise<readonly Delivery[]>;
  saveDeliveries?(sessionId: string, deliveries: readonly Delivery[]): Promise<void>;
}
export class Journal implements HistoryStore {
  private readonly lineMaps = new Map<string, number[]>();
  private checkpointTail: Promise<void> = Promise.resolve();
  private systemTail: Promise<void> = Promise.resolve();
  constructor(private readonly directory: string) {}
  path(sessionId: string, ownerId: string): string {
    const key = createHash('sha256').update(JSON.stringify([sessionId, ownerId])).digest('hex');
    return join(this.directory, key + '.jsonl');
  }
  reference(sessionId: string, ownerId: string, start: number, end: number): string {
    const indices = this.lineMaps.get(this.path(sessionId, ownerId));
    const lines = indices?.slice(start, end) ?? Array.from({length: end - start}, (_, index) => start + index);
    const ranges: Array<{start: number; end: number}> = [];
    for (const index of lines) {
      const last = ranges.at(-1);
      if (last && last.end + 1 === index) last.end = index;
      else ranges.push({start: index, end: index});
    }
    return this.path(sessionId, ownerId) + '（原始行 ' + ranges.map(range => range.start === range.end ? String(range.start + 1) : (range.start + 1) + '–' + (range.end + 1)).join('、') + '；只读取这些有效行）';
  }
  sourceLines(sessionId: string, ownerId: string, start: number, end: number): {start: number; end: number} {
    const indices = this.lineMaps.get(this.path(sessionId, ownerId));
    const first = indices?.[start] ?? start, last = indices?.[end - 1] ?? end - 1;
    if (start < 0 || end <= start || first > last) throw new Error('Invalid round source range.');
    return {start: first + 1, end: last + 1};
  }
  async inspect(sessionId: string, ownerId: string): Promise<{entries: readonly HistoryEntry[]; issue?: string}> {
    const text = await this.read(this.path(sessionId, ownerId));
    if (text === undefined) return {entries: []};
    const entries: HistoryEntry[] = [], lines = text.split('\n');
    let issue: string | undefined;
    for (let index = 0; index < lines.length - 1; index++) {
      try {
        const entry = entrySchema.parse(JSON.parse(lines[index]!));
        if (entry.sessionId !== sessionId || entry.ownerId !== ownerId) throw new Error('身份不匹配');
        entries.push(entry);
      } catch {issue = '第 ' + (index + 1) + ' 行损坏，只可恢复此前完整前缀'; break;}
    }
    if (!issue && lines.at(-1) !== '') issue = '末行未完整提交，只可恢复此前完整前缀';
    const branch = await this.branch(sessionId), hidden = new Set(branch.hidden[ownerId] ?? []);
    return {entries: entries.filter((_, index) => !hidden.has(index)), ...(issue ? {issue} : {})};
  }
  async loadRaw(sessionId: string, ownerId: string): Promise<readonly HistoryEntry[]> {
    const text = await this.read(this.path(sessionId, ownerId));
    if (text === undefined) return [];
    if (text && !text.endsWith('\n')) throw new Error('账本末行未完整提交，请检查备份后恢复');
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    if (lines.some(line => !line.trim())) throw new Error('账本含空行，无法保证原文回读行号');
    return lines.map((line, index) => {
      try {
        const entry = entrySchema.parse(JSON.parse(line));
        if (entry.sessionId !== sessionId || entry.ownerId !== ownerId) throw new Error('角色账本身份不匹配');
        return Object.freeze(entry);
      } catch {throw new Error('账本记录损坏：' + this.path(sessionId, ownerId) + '，第 ' + (index + 1) + ' 行；原文未修改');}
    });
  }
  private branchPath(sessionId: string): string {return this.path(sessionId, '$session') + '.branch.json';}
  private async branch(sessionId: string) {
    const raw = await this.read(this.branchPath(sessionId));
    const branch = raw === undefined ? {version: 1 as const, id: '', sessionId, hidden: {} as Record<string, number[]>, excludedTasks: [] as string[]} : branchSchema.parse(JSON.parse(raw));
    if (branch.sessionId !== sessionId) throw new Error('分支身份不匹配');
    return branch;
  }
  async load(sessionId: string, ownerId: string): Promise<readonly HistoryEntry[]> {
    const entries = await this.loadRaw(sessionId, ownerId), branch = await this.branch(sessionId);
    const hidden = new Set(branch.hidden[ownerId] ?? []);
    if ([...hidden].some(index => index >= entries.length)) throw new Error('分支行号超过原始账本');
    const indices = entries.flatMap((_, index) => hidden.has(index) ? [] : [index]);
    this.lineMaps.set(this.path(sessionId, ownerId), indices);
    return indices.map(index => entries[index]!);
  }
  private async statePath(sessionId: string, ownerId: string, kind: string): Promise<string> {
    const branch = await this.branch(sessionId);
    return this.path(sessionId, ownerId) + (branch.id ? '.' + branch.id : '') + '.' + kind + '.json';
  }
  async fork(sessionId: string, owners: readonly string[], activities?: readonly string[]): Promise<void> {
    const previous = await this.branch(sessionId), id = randomUUID();
    const hidden = structuredClone(previous.hidden);
    const retained: Array<{owner: string; rounds: RoundRecord[]; context: ContextState | undefined}> = [];
    for (const owner of owners) {
      const raw = await this.loadRaw(sessionId, owner), before = await this.load(sessionId, owner);
      const removed = new Set(hidden[owner] ?? []);
      raw.forEach((entry, index) => {if (!activities || entry.activityId && activities.includes(entry.activityId)) removed.add(index);});
      hidden[owner] = [...removed].sort((a, b) => a - b);
      const after = raw.filter((_, index) => !removed.has(index));
      let rounds: RoundRecord[] = [], context: ContextState | undefined;
      try {rounds = (await this.rounds(sessionId, owner, before)).filter(round => round.end <= after.length && digest(after.slice(round.start, round.end)) === round.sourceHash);} catch {}
      try {
        const state = await this.loadContext(sessionId, owner, before);
        if (state && state.sourceLength <= after.length && digest(after.slice(0, state.sourceLength)) === state.sourceHash) context = state;
      } catch {}
      retained.push({owner, rounds, context});
    }
    const collaborations = activities ? (await this.collaborations(sessionId)).filter(record => !activities.includes(record.activityId) && !record.messages.some(message => activities.includes(message.activityId)) && !record.relatedActivities?.some(activity => activities.includes(activity))) : [];
    const deliveries = activities ? (await this.loadDeliveries(sessionId)).filter(item =>
      ![item.sourceActivityId, item.rootActivityId, item.targetActivityId, item.recipientActivityId].some(activity => activity && activities.includes(activity))) : [];
    await atomicWrite(this.path(sessionId, '$deliveries') + '.' + id + '.queue.json', Buffer.from(JSON.stringify(deliveries)));
    await atomicWrite(this.path(sessionId, '$collaboration') + '.' + id + '.records.json', Buffer.from(JSON.stringify(collaborations)));
    // 候选侧文件先落盘；最终一次替换才改变所有角色的有效分支。
    for (const {owner, rounds, context} of retained) {
      const prefix = this.path(sessionId, owner) + '.' + id;
      await atomicWrite(prefix + '.rounds.json', Buffer.from(JSON.stringify(rounds)));
      if (context) await atomicWrite(prefix + '.context.json', Buffer.from(JSON.stringify(context)));
    }
    const excludedTasks = [...new Set([...previous.excludedTasks, ...activities ?? (await this.tasks(sessionId)).map(task => task.activityId)])];
    await atomicWrite(this.branchPath(sessionId), Buffer.from(JSON.stringify({version: 1, id, sessionId, hidden, excludedTasks})));
  }
  async pending(sessionId: string): Promise<z.infer<typeof pendingSchema> | undefined> {
    const raw = await this.read(this.path(sessionId, '$session') + '.pending.json');
    if (raw === undefined) return undefined;
    const value = pendingSchema.nullable().parse(JSON.parse(raw));
    if (value && value.sessionId !== sessionId) throw new Error('回退操作身份不匹配');
    return value ?? undefined;
  }
  async savePending(sessionId: string, value: {target: string; activities: readonly string[]} | null): Promise<void> {
    await atomicWrite(this.path(sessionId, '$session') + '.pending.json', Buffer.from(JSON.stringify(value ? {sessionId, ...value} : null)));
  }
  checkpoint(sessionId: string, task: TaskCheckpoint): Promise<void> {
    const operation = this.checkpointTail.then(async () => {
      const tasks = await this.tasks(sessionId), parsed = taskSchema.parse(task);
      const existing = tasks.find(item => item.activityId === task.activityId);
      const next = existing ? tasks.map(item => item.activityId === task.activityId
        ? {...parsed, ...(parsed.handoff ?? existing.handoff ? {handoff: parsed.handoff ?? existing.handoff} : {}), time: existing.time} : item)
        : [...tasks, {...parsed, time: Math.max(parsed.time, ...tasks.map(item => item.time + 1))}];
      await atomicWrite(this.path(sessionId, '$session') + '.tasks.json', Buffer.from(JSON.stringify(next)));
      try {
        const treeDir = join(this.directory, sessionId);
        await mkdir(treeDir, {recursive: true});
        await atomicWrite(join(treeDir, 'tasks.json'), Buffer.from(JSON.stringify(next, null, 2)));
        const readme = `# Session: ${sessionId}\n\n- **Director Log**: \`director.jsonl\` (Logox main conversation)\n- **Tasks Ledger**: \`tasks.json\` (All dispatched subagent tasks)\n- **System Events**: \`events.json\` (Environment updates and notices)\n- **Delivery Queue**: \`deliveries.json\` (Pending messages and consumption receipts)\n- **Subagents**: \`subagents/<actor>.jsonl\` (Techne, Kalon, Aletheia)\n`;
        await atomicWrite(join(treeDir, 'README.md'), Buffer.from(readme));
      } catch {}
    });
    this.checkpointTail = operation.catch(() => {});
    return operation;
  }
  async stageHandoff(sessionId: string, activityId: string, handoff: Delivery): Promise<void> {
    if (handoff.sessionId !== sessionId || handoff.sourceActivityId !== activityId) throw new Error('Handoff producer identity does not match.');
    const task = (await this.activeTasks(sessionId)).find(item => item.activityId === activityId);
    if (task) await this.checkpoint(sessionId, {...task, handoff});
  }
  async flush(): Promise<void> {await Promise.all([this.checkpointTail, this.systemTail]);}
  appendSystem(event: SystemEvent): Promise<void> {
    const parsed = systemEventSchema.parse(event);
    const pending = this.systemTail.then(async () => {
      const file = this.path(parsed.sessionId, '$system') + '.events.json';
      const raw = await this.read(file);
      const events = raw === undefined ? [] : z.array(systemEventSchema).parse(JSON.parse(raw));
      if (events.some(item => item.sessionId !== parsed.sessionId)) throw new Error('系统记录会话身份不匹配');
      if (events.some(item => item.id === parsed.id)) return;
      await atomicWrite(file, Buffer.from(JSON.stringify([...events, parsed])));
      try {
        const treeDir = join(this.directory, parsed.sessionId);
        await mkdir(treeDir, {recursive: true});
        await atomicWrite(join(treeDir, 'events.json'), Buffer.from(JSON.stringify([...events, parsed], null, 2)));
      } catch {}
    });
    this.systemTail = pending.catch(() => {});
    return pending;
  }
  async systemEvents(sessionId: string): Promise<readonly SystemEvent[]> {
    await this.systemTail;
    const raw = await this.read(this.path(sessionId, '$system') + '.events.json');
    const events = raw === undefined ? [] : z.array(systemEventSchema).parse(JSON.parse(raw));
    if (events.some(event => event.sessionId !== sessionId)) throw new Error('系统记录会话身份不匹配');
    const branch = await this.branch(sessionId), excluded = new Set(branch.excludedTasks);
    return events.filter(event => !event.activityId || !excluded.has(event.activityId));
  }
  async tasks(sessionId: string): Promise<TaskCheckpoint[]> {
    const raw = await this.read(this.path(sessionId, '$session') + '.tasks.json');
    return raw === undefined ? [] : z.array(taskSchema).parse(JSON.parse(raw));
  }
  async activeTasks(sessionId: string): Promise<TaskCheckpoint[]> {
    const branch = await this.branch(sessionId);
    return (await this.tasks(sessionId)).filter(task => !branch.excludedTasks.includes(task.activityId));
  }
  async progress(sessionId: string, ownerId: string, activityId: string): Promise<TaskProgressSnapshot | undefined> {
    return (await this.activeTasks(sessionId)).find(task => task.ownerId === ownerId && task.activityId === activityId)?.progress;
  }
  async loadDeliveries(sessionId: string): Promise<readonly Delivery[]> {
    const raw = await this.read(await this.statePath(sessionId, '$deliveries', 'queue'));
    const records = raw === undefined ? [] : z.array(deliverySchema).parse(JSON.parse(raw));
    if (records.some(item => item.sessionId !== sessionId)) throw new Error('Delivery queue session identity does not match.');
    const excluded = new Set((await this.branch(sessionId)).excludedTasks);
    return records.filter(item => ![item.sourceActivityId, item.rootActivityId, item.targetActivityId, item.recipientActivityId].some(activity => activity && excluded.has(activity)));
  }
  async saveDeliveries(sessionId: string, deliveries: readonly Delivery[]): Promise<void> {
    const parsed = z.array(deliverySchema).parse(deliveries);
    if (parsed.some(item => item.sessionId !== sessionId)) throw new Error('Delivery queue session identity does not match.');
    await atomicWrite(await this.statePath(sessionId, '$deliveries', 'queue'), Buffer.from(JSON.stringify(parsed)));
    try {
      const treeDir = join(this.directory, sessionId);
      await mkdir(treeDir, {recursive: true});
      await atomicWrite(join(treeDir, 'deliveries.json'), Buffer.from(JSON.stringify(parsed, null, 2)));
    } catch {}
  }
  async collaborations(sessionId: string): Promise<CollaborationRecord[]> {
    const raw = await this.read(await this.statePath(sessionId, '$collaboration', 'records'));
    if (raw === undefined) return [];
    const records = z.array(collaborationSchema).parse(JSON.parse(raw)), branch = await this.branch(sessionId);
    if (records.some(record => record.sessionId !== sessionId || record.requester === record.target ||
      record.messages.some(message => ![record.requester, record.target].includes(message.from)))) throw new Error('协作记录身份无效');
    return records.filter(record => !branch.excludedTasks.includes(record.activityId) && !record.messages.some(message => branch.excludedTasks.includes(message.activityId)) && !record.relatedActivities?.some(activity => branch.excludedTasks.includes(activity)));
  }
  async saveCollaborations(sessionId: string, records: readonly CollaborationRecord[]): Promise<void> {
    const parsed = z.array(collaborationSchema).parse(records);
    if (parsed.some(record => record.sessionId !== sessionId)) throw new Error('协作会话身份无效');
    await atomicWrite(await this.statePath(sessionId, '$collaboration', 'records'), Buffer.from(JSON.stringify(parsed)));
  }
  async append(raw: HistoryEntry): Promise<void> {
    const entry = entrySchema.parse({...raw, time: raw.time ?? Date.now()});
    await mkdir(this.directory, {recursive: true});
    await this.loadRaw(entry.sessionId, entry.ownerId);
    await appendFile(this.path(entry.sessionId, entry.ownerId), JSON.stringify(entry) + '\n', 'utf8');
    try {
      const isDirector = entry.ownerId === 'logox';
      const treeDir = isDirector
        ? join(this.directory, entry.sessionId)
        : join(this.directory, entry.sessionId, 'subagents');
      await mkdir(treeDir, {recursive: true});
      const treeFile = isDirector
        ? join(treeDir, 'director.jsonl')
        : join(treeDir, `${entry.ownerId}.jsonl`);
      await appendFile(treeFile, JSON.stringify(entry) + '\n', 'utf8');
    } catch {}
  }
  private async read(file: string): Promise<string | undefined> {
    try {return await readFile(file, 'utf8');}
    catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error;}
  }
  async rounds(sessionId: string, ownerId: string, entries: readonly HistoryEntry[]): Promise<RoundRecord[]> {
    const raw = await this.read(await this.statePath(sessionId, ownerId, 'rounds'));
    if (raw === undefined) return [];
    const records = z.array(roundSchema).parse(JSON.parse(raw));
    return records.filter(record => record.end <= entries.length && record.start < record.end &&
      entries[record.start]?.activityId === record.activityId && digest(entries.slice(record.start, record.end)) === record.sourceHash);
  }
  async finish(sessionId: string, ownerId: string, activityId: string, status: RoundStatus): Promise<RoundSummary> {
    return (await this.finishRecord(sessionId, ownerId, activityId, status)).summary;
  }
  async finishRecord(sessionId: string, ownerId: string, activityId: string, status: RoundStatus, finalizerCallId?: string | null): Promise<RoundRecord> {
    const entries = await this.load(sessionId, ownerId);
    const start = entries.findIndex(entry => entry.activityId === activityId && entry.role === 'user');
    if (start < 0) throw new Error('Round input was not recorded.');
    const last = entries.findLastIndex(entry => entry.activityId === activityId);
    const end = last + 1;
    const messages: ModelMessage[] = entries.slice(start, end).map(entry => entry.message ?? {role: entry.role === 'tool' ? 'user' as const : entry.role, text: entry.text});
    const legacy = summarizeRound(messages, status);
    const accepted = status === 'completed' ? extractRoundMemory(messages, finalizerCallId) : undefined;
    const modernClosure = finalizerCallId !== undefined || messages.some(message => message.role === 'assistant' &&
      (message.memoryOnly || message.toolCalls?.some(call => isFinishRound(call.name))));
    const memory: RoundMemory = accepted ?? {
      title: legacy.source === 'model' ? legacy.title : status === 'completed' ? 'Round completed without structured memory' : status === 'cancelled' ? 'Execution cancelled' : 'Execution failed',
      verification: null,
      carryForward: [legacy.source === 'model' ? 'Legacy summary; inspect the record for verification and remaining work.' : 'Round metadata unavailable; inspect recorded work before continuing.'],
      source: modernClosure ? 'runtime' : 'legacy',
    };
    const final = messages.findLast(message => message.role === 'assistant' && !message.contextExcluded && !message.memoryOnly && message.text.trim())?.text ?? '';
    const summary: RoundSummary = accepted ? {title: legacy.title, report: final.slice(0, 2000) || 'Round completed.', source: 'model'} : legacy;
    const raw = await this.loadRaw(sessionId, ownerId);
    const activities = [...new Set(raw.filter(entry => entry.role === 'user' && entry.activityId).map(entry => entry.activityId!))];
    const ordinal = activities.indexOf(activityId) + 1;
    const sourceLines = this.sourceLines(sessionId, ownerId, start, end);
    const delivery = ownerId !== 'logox' && entries[start]?.inputKind === 'director' && final.trim()
      ? {title: summary.title, text: final} : undefined;
    const record: RoundRecord = {activityId, start, end, sourceHash: digest(entries.slice(start, end)), status, summary,
      ordinal, memory, sourceLines, ...(delivery ? {delivery} : {})};
    roundSchema.parse(record);
    const records = (await this.rounds(sessionId, ownerId, entries)).filter(record => record.activityId !== activityId);
    records.push(record);
    records.sort((a, b) => a.start - b.start);
    await atomicWrite(await this.statePath(sessionId, ownerId, 'rounds'), Buffer.from(JSON.stringify(records)));
    try {
      const isDirector = ownerId === 'logox';
      const treeDir = isDirector
        ? join(this.directory, sessionId)
        : join(this.directory, sessionId, 'subagents');
      await mkdir(treeDir, {recursive: true});
      const roundsFile = isDirector
        ? join(treeDir, 'director.rounds.json')
        : join(treeDir, `${ownerId}.rounds.json`);
      await atomicWrite(roundsFile, Buffer.from(JSON.stringify(records, null, 2)));
    } catch {}
    return record;
  }
  async loadContext(sessionId: string, ownerId: string, entries: readonly HistoryEntry[]): Promise<ContextState | undefined> {
    const raw = await this.read(await this.statePath(sessionId, ownerId, 'context'));
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
    await atomicWrite(await this.statePath(state.sessionId, state.ownerId, 'context'), Buffer.from(JSON.stringify(state)));
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
