/**
 * What a dream may do to memory: parse the model's answer tolerantly, validate every operation, and apply them through `MemoryStore`.
 * The answer is data, not authority: invalid operations, secrets and deletions of records that do not exist are dropped.
 */
import {z} from 'zod';
import {memoryNameSchema, memoryRecordSchema, memoryScopeSchema, memoryTypeSchema, type MemoryScope, type MemoryStore, type MemoryType} from './memory.js';

export const MAX_DREAM_OPERATIONS = 6;
const saveSchema = z.object({
  op: z.literal('save'), scope: memoryScopeSchema.optional(), type: memoryTypeSchema,
  name: memoryNameSchema, description: memoryRecordSchema.shape.description, content: memoryRecordSchema.shape.content,
});
const deleteSchema = z.object({op: z.literal('delete'), scope: memoryScopeSchema.optional(), name: memoryNameSchema});
const operationSchema = z.discriminatedUnion('op', [saveSchema, deleteSchema]);
export type DreamOperation = z.infer<typeof operationSchema>;
export interface SavedRecord {scope: MemoryScope; name: string; type: MemoryType; description: string}
export interface DreamResult {saved: readonly SavedRecord[]; deleted: readonly {scope: MemoryScope; name: string}[]}

/** Strips a code fence and takes the outermost JSON object; the operations list is what the object holds, or nothing was asked. */
export function parseDreamAnswer(text: string): unknown[] | undefined {
  const unfenced = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const start = unfenced.indexOf('{'), end = unfenced.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const value: unknown = JSON.parse(unfenced.slice(start, end + 1));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const operations = (value as {operations?: unknown}).operations;
    return Array.isArray(operations) ? operations : operations === undefined ? [] : undefined;
  } catch {
    return undefined;
  }
}

const SECRETS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bghp_[A-Za-z0-9]{16,}/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:api[_-]?key|password)\s*=\s*\S+/i,
  /\b(?:api[_-]?key|password)["']?\s*:\s*["'][^"'\s]{4,}["']/i,
];
/** True when the text carries an obvious credential. */
export function looksSecret(text: string): boolean {
  return SECRETS.some(pattern => pattern.test(text));
}

/** The operations that survive validation, at most six, in the order the model gave them. */
export function validOperations(raw: readonly unknown[]): DreamOperation[] {
  const result: DreamOperation[] = [];
  for (const item of raw) {
    const parsed = operationSchema.safeParse(item);
    if (!parsed.success) continue;
    const operation = parsed.data;
    if (operation.op === 'save' && looksSecret([operation.name, operation.description, operation.content].join('\n'))) continue;
    result.push(operation);
  }
  return result.slice(0, MAX_DREAM_OPERATIONS);
}

/** Applies the valid operations and reports what actually changed. A `user` record always goes to the user folder; the other types go where the model said (default project). */
export async function applyOperations(store: MemoryStore, raw: readonly unknown[], signal?: AbortSignal): Promise<DreamResult> {
  const operations = validOperations(raw);
  const saved: SavedRecord[] = [], deleted: {scope: MemoryScope; name: string}[] = [];
  for (const operation of operations) {
    signal?.throwIfAborted();
    if (operation.op === 'save') {
      const scope: MemoryScope = operation.type === 'user' ? 'user' : operation.scope ?? 'project';
      try {await store.save({name: operation.name, description: operation.description, type: operation.type, content: operation.content}, scope);}
      catch {continue;}
      saved.push({scope, name: operation.name, type: operation.type, description: operation.description});
    } else {
      const scope = operation.scope ?? 'project';
      if (!(await store.list(scope)).some(record => record.name === operation.name)) continue;
      if (await store.delete(operation.name, scope)) deleted.push({scope, name: operation.name});
    }
  }
  return {saved, deleted};
}

const plural = (count: number) => count + ' memory record' + (count === 1 ? '' : 's');
/** The card title of a finished dream. */
export function dreamStage(result: DreamResult): string {
  const saved = result.saved.length, removed = result.deleted.length;
  if (saved && removed) return 'Saved ' + plural(saved) + ', removed ' + removed;
  if (saved) return 'Saved ' + plural(saved);
  if (removed) return 'Removed ' + plural(removed);
  return 'Nothing new to remember';
}
/** The card body of a finished dream: one line per operation. */
export function dreamDetail(result: DreamResult): string {
  return [...result.saved.map(item => '+ ' + item.scope + '/' + item.name + ' (' + item.type + '): ' + item.description),
    ...result.deleted.map(item => '- ' + item.scope + '/' + item.name)].join('\n');
}
