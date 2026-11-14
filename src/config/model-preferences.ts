import {readFile, rm, writeFile} from 'node:fs/promises';
import {replaceFile} from '../store/replace-file.js';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {withFileLock} from '../store/file-lock.js';

export const effortSchema = z.enum(['auto', 'off', 'low', 'medium', 'high', 'max']);
export type ThinkingEffort = z.infer<typeof effortSchema>;

/**
 * The thinking level a model id names itself (`<family>-low|medium|high|max`, `-extra-low` counts as low, `-xhigh` is the family's top level and counts as max).
 * Such a model is one fixed level of its family, so that level is its effort: a separately chosen effort (the session's, inherited by every actor) must not contradict the name.
 */
export function effortInName(model: string): ThinkingEffort | undefined {
  const tier = /-(extra-low|low|medium|high|xhigh|max)$/.exec(model.toLowerCase())?.[1];
  return tier === undefined ? undefined : tier === 'extra-low' ? 'low' : tier === 'xhigh' ? 'max' : tier as ThinkingEffort;
}
/** How a model and its thinking level are shown: `<model> · <level>`. A model id that names its level shows its family once (`claude-x-medium` -> `claude-x · medium`), never the level twice. */
export function modelLabel(model: string, effort?: string): string {
  const named = /^(.+)-(extra-low|low|medium|high|xhigh|max)$/i.exec(model);
  if (named) return named[1] + ' · ' + named[2]!.toLowerCase();
  return effort && effort !== 'none' ? model + ' · ' + effort : model;
}

export function isOpenAiReasoningModel(id: string): boolean {
  const clean = id.toLowerCase();
  if (clean.includes('chat-latest') && !clean.includes('gpt-5.2')) return false;
  if (/^o[1-9](?:-|$)/.test(clean)) return true;
  if (/^gpt-[5-9]/.test(clean)) return true;
  if (/(?:sol|luna|astra|terra|codex|daybreak|realtime)/.test(clean)) return true;
  return false;
}

export const preferenceSchema = z.strictObject({version: z.literal(1),
  provider: z.string().min(1).max(256), model: z.string().max(1024), effort: effortSchema});
export type ModelPreference = z.infer<typeof preferenceSchema>;
/** Standalone state file; re-read under lock and never overwritten when corrupted. */
export class StateFile<T> {
  constructor(readonly path: string, private readonly schema: z.ZodType<T>) {}
  async read(): Promise<T | undefined> {
    let content: string;
    try {content = await readFile(this.path, 'utf8');}
    catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new Error('Cannot read state file: ' + this.path);}
    try {return this.schema.parse(JSON.parse(content));}
    catch {throw new Error('State file format is invalid; original file preserved: ' + this.path);}
  }
  async save(value: T): Promise<void> {
    await this.update(() => value);
  }
  async update(transform: (current: T | undefined) => T): Promise<void> {
    await withFileLock(this.path, async () => {
      const temporary = this.path + '.' + randomUUID() + '.tmp';
      try {
        const parsed = this.schema.parse(transform(await this.read()));
        await writeFile(temporary, JSON.stringify(parsed) + '\n', {flag: 'wx', mode: 0o600});
        await replaceFile(temporary, this.path);
      } catch (error) {
        throw new Error('Failed to save state; current selection and original file preserved: ' + this.path, {cause: error});
      } finally {await rm(temporary, {force: true}).catch(() => {}); }
    });
  }
}
