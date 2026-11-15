import {mkdir, readFile, readdir, rm, stat, writeFile, rename} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {parse as parseYaml, stringify as stringifyYaml} from 'yaml';
import {z} from 'zod';

export const memoryTypeSchema = z.enum(['user', 'feedback', 'project', 'reference']);
export type MemoryType = z.infer<typeof memoryTypeSchema>;
export const memoryScopeSchema = z.enum(['project', 'user']);
export type MemoryScope = z.infer<typeof memoryScopeSchema>;
/** A record name is its file name without `.md`: a short slug, so it can never leave the folder. */
export const memoryNameSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const oneLine = (max: number) => z.string().trim().min(1).max(max).refine(value => !/[\r\n]/.test(value), 'One line only');

export const memoryRecordSchema = z.strictObject({
  name: memoryNameSchema,
  description: oneLine(200),
  type: memoryTypeSchema,
  content: z.string().trim().min(1).max(8000),
  scope: memoryScopeSchema.default('project'),
  filePath: z.string().optional(),
});

export type MemoryRecord = z.infer<typeof memoryRecordSchema>;
/** What a caller supplies to `save`: the scope is a separate argument and the path is the store's business. */
export type MemoryDraft = Pick<MemoryRecord, 'name' | 'description' | 'type' | 'content'>;

const frontmatterSchema = z.object({
  name: z.string().optional(),
  description: z.string(),
  metadata: z.object({type: memoryTypeSchema}).optional(),
  type: memoryTypeSchema.optional(),
});

export function serializeMemoryFile(record: MemoryDraft): string {
  const frontmatter = {name: record.name, description: record.description, metadata: {type: record.type}};
  return `---\n${stringifyYaml(frontmatter).trim()}\n---\n\n${record.content.trim()}\n`;
}

/** The frontmatter and body of one file, or undefined when it is not a record. The caller supplies the name (the file's own). */
export function parseMemoryFile(raw: string): Omit<MemoryDraft, 'name'> | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw.replace(/^﻿/, '').trim());
  if (!match) return undefined;
  try {
    const parsed = frontmatterSchema.parse(parseYaml(match[1]!));
    // A record written by hand may carry a long or wrapped description; it is clipped, never refused.
    const description = parsed.description.replace(/\s+/g, ' ').trim().slice(0, 200);
    return {description, type: parsed.metadata?.type ?? parsed.type ?? 'project', content: match[2]?.trim() ?? ''};
  } catch {
    return undefined;
  }
}

const bySlot = (a: MemoryRecord, b: MemoryRecord) => (a.scope === b.scope ? 0 : a.scope === 'project' ? -1 : 1) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

export class MemoryStore {
  readonly projectDir: string;
  readonly userDir: string;

  constructor(projectDir: string = process.cwd(), userDir: string = homedir()) {
    this.projectDir = projectDir;
    this.userDir = userDir;
  }

  dirFor(scope: MemoryScope): string {
    return scope === 'project' ? join(this.projectDir, '.logox', 'memory') : join(this.userDir, '.logox', 'memory');
  }

  indexPathFor(scope: MemoryScope): string {
    return join(this.dirFor(scope), 'MEMORY.md');
  }

  /** Records sorted by scope (project first) and name, so the order never depends on the file system. A file that is not a valid record is skipped. */
  async list(scope?: MemoryScope): Promise<readonly MemoryRecord[]> {
    const scopes: MemoryScope[] = scope ? [scope] : ['project', 'user'];
    const results: MemoryRecord[] = [];
    const seenDirs = new Set<string>();
    for (const s of scopes) {
      const dir = this.dirFor(s);
      if (seenDirs.has(dir)) continue;
      seenDirs.add(dir);
      let files: string[];
      try {files = await readdir(dir);} catch {continue;}
      for (const file of files) {
        if (!file.endsWith('.md') || file === 'MEMORY.md') continue;
        const fullPath = join(dir, file);
        try {
          const parsed = parseMemoryFile(await readFile(fullPath, 'utf8'));
          if (!parsed) continue;
          const record = memoryRecordSchema.safeParse({...parsed, name: file.slice(0, -3), scope: s, filePath: fullPath});
          if (record.success) results.push(record.data);
        } catch {}
      }
    }
    return results.sort(bySlot);
  }

  /** Validates the record, then writes its file and the derived index. Throws on an invalid record. */
  async save(record: MemoryDraft, scope: MemoryScope = 'project'): Promise<string> {
    const valid = memoryRecordSchema.parse({name: record.name, description: record.description, type: record.type, content: record.content, scope});
    const dir = this.dirFor(valid.scope);
    await mkdir(dir, {recursive: true});
    const targetFile = join(dir, `${valid.name}.md`);
    await this.atomicWrite(targetFile, serializeMemoryFile(valid));
    await this.rebuildIndex(valid.scope);
    return targetFile;
  }

  /** True when the record existed and was removed. */
  async delete(name: string, scope: MemoryScope = 'project'): Promise<boolean> {
    if (!memoryNameSchema.safeParse(name).success) return false;
    const targetFile = join(this.dirFor(scope), `${name}.md`);
    try {
      if (!(await stat(targetFile)).isFile()) return false;
      await rm(targetFile, {force: true});
    } catch {
      return false;
    }
    await this.rebuildIndex(scope).catch(() => {});
    return true;
  }

  async rebuildIndex(scope: MemoryScope): Promise<void> {
    const list = await this.list(scope);
    const lines = list.map(m => `- [${m.name}](${m.name}.md) — ${m.description}`);
    await this.atomicWrite(this.indexPathFor(scope), lines.length > 0 ? `${lines.join('\n')}\n` : '');
  }

  private async atomicWrite(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), {recursive: true});
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, content, 'utf8');
      await rename(temp, path);
    } finally {
      await rm(temp, {force: true}).catch(() => {});
    }
  }
}
