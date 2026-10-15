import {z} from 'zod';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {StateFile} from '../config/model-preferences.js';
import type {Config} from '../config/config.js';
import {usageRecordSchema, type UsageRecord} from './budget.js';

const ledgerSchema = z.array(usageRecordSchema);
export class UsageLedger {
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly root: string, private readonly report: (message: string) => void) {}
  private file(sessionId: string, ownerId: string) {
    return new StateFile(join(this.root, createHash('sha256').update(JSON.stringify([sessionId, ownerId])).digest('hex') + '.json'), ledgerSchema);
  }
  async read(sessionId: string, ownerId: string): Promise<UsageRecord[]> {
    try {return await this.file(sessionId, ownerId).read() ?? [];}
    catch {this.report('用量记录无法读取，原文件保留；本进程从零记录。'); return [];}
  }
  record(sessionId: string, ownerId: string, record: UsageRecord): void {
    this.pending = this.pending.then(() => this.file(sessionId, ownerId).update(current => {
      const records = current ?? [];
      return records.some(item => item.id === record.id) ? records : [...records, record];
    })).catch(() => {this.report('用量保存失败；本进程统计仍可查看，原文件保留。');});
  }
  async flush(): Promise<void> {await this.pending;}
}
function modelKey(identity: string): string {
  try {const parts: unknown = JSON.parse(identity); if (Array.isArray(parts) && typeof parts[0] === 'string' && typeof parts[1] === 'string') return parts[0] + '/' + parts[1];} catch {}
  return identity;
}
export function usageLines(records: readonly UsageRecord[], config: Config): string[] {
  const totalInput = records.reduce((sum, record) => sum + record.input, 0), totalOutput = records.reduce((sum, record) => sum + record.output, 0);
  const lines = ['实际响应用量；输入包含缓存，费用按静态配置计算。',
    '合计输入 / 输出：' + totalInput + ' / ' + totalOutput + ' token'];
  const groups = new Map<string, {input: number; output: number; cacheRead: number; cacheWrite: number}>();
  for (const record of records) {
    const key = JSON.stringify([modelKey(record.model), record.category]);
    const total = groups.get(key) ?? {input: 0, output: 0, cacheRead: 0, cacheWrite: 0};
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) total[field] += record[field];
    groups.set(key, total);
  }
  if (!groups.size) return [...lines, '尚无已记录的响应用量。'];
  for (const [key, total] of groups) {
    const [model, category] = z.tuple([z.string(), z.string()]).parse(JSON.parse(key));
    const price = config.models[model]?.prices;
    const buckets = [[total.input - total.cacheRead - total.cacheWrite, price?.input], [total.output, price?.output],
      [total.cacheRead, price?.cache_read], [total.cacheWrite, price?.cache_write]] as const;
    const known = !!price && buckets.every(([tokens, rate]) => tokens === 0 || rate !== undefined);
    const cost = known ? buckets.reduce((sum, [tokens, rate]) => sum + tokens * (rate ?? 0) / 1e6, 0) : undefined;
    lines.push('', model + ' · ' + (category === 'task' ? '任务' : category === 'approval' ? '审批' : '汇总'),
      '输入 / 输出：' + total.input + ' / ' + total.output + ' token',
      '缓存读取 / 写入：' + total.cacheRead + ' / ' + total.cacheWrite + ' token',
      '预估费用：' + (cost === undefined ? '未知（缺少价格）' : cost.toFixed(6) + ' ' + price!.currency));
  }
  return lines;
}
