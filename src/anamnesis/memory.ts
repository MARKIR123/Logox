import {mkdir, readFile, readdir, rm, writeFile, rename} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {parse as parseYaml, stringify as stringifyYaml} from 'yaml';
import {z} from 'zod';

export const memoryTypeSchema = z.enum(['user', 'feedback', 'project', 'reference']);
export type MemoryType = z.infer<typeof memoryTypeSchema>;

export const memoryRecordSchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9_-]{1,64}$/),
  description: z.string().trim().min(1).max(200),
  type: memoryTypeSchema,
  content: z.string().trim(),
  scope: z.enum(['project', 'user']).default('project'),
  filePath: z.string().optional(),
});

export type MemoryRecord = z.infer<typeof memoryRecordSchema>;

const frontmatterSchema = z.object({
  name: z.string(),
  description: z.string(),
  metadata: z.object({
    type: memoryTypeSchema,
  }).optional(),
  type: memoryTypeSchema.optional(),
});

export function serializeMemoryFile(record: Omit<MemoryRecord, 'filePath' | 'scope'>): string {
  const frontmatter = {
    name: record.name,
    description: record.description,
    metadata: {
      type: record.type,
    },
  };
  return `---\n${stringifyYaml(frontmatter).trim()}\n---\n\n${record.content.trim()}\n`;
}

export function parseMemoryFile(raw: string, filePath?: string): Omit<MemoryRecord, 'scope'> | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw.trim());
  if (!match) return undefined;

  try {
    const yamlData = parseYaml(match[1]!);
    const parsed = frontmatterSchema.parse(yamlData);
    const type = parsed.metadata?.type ?? parsed.type ?? 'project';
    return {
      name: parsed.name,
      description: parsed.description,
      type,
      content: match[2]?.trim() ?? '',
      ...(filePath ? {filePath} : {}),
    };
  } catch {
    return undefined;
  }
}

export class MemoryStore {
  readonly projectDir: string;
  readonly userDir: string;

  constructor(
    projectDir: string = process.cwd(),
    userDir: string = homedir()
  ) {
    this.projectDir = projectDir;
    this.userDir = userDir;
  }

  dirFor(scope: 'project' | 'user'): string {
    return scope === 'project'
      ? join(this.projectDir, '.logox', 'memory')
      : join(this.userDir, '.logox', 'memory');
  }

  indexPathFor(scope: 'project' | 'user'): string {
    return join(this.dirFor(scope), 'MEMORY.md');
  }

  async list(scope?: 'project' | 'user'): Promise<readonly MemoryRecord[]> {
    const scopes: ('project' | 'user')[] = scope ? [scope] : ['project', 'user'];
    const results: MemoryRecord[] = [];
    const seenDirs = new Set<string>();

    for (const s of scopes) {
      const dir = this.dirFor(s);
      if (seenDirs.has(dir)) continue;
      seenDirs.add(dir);
      try {
        const files = await readdir(dir);
        for (const file of files) {
          if (!file.endsWith('.md') || file === 'MEMORY.md') continue;
          const fullPath = join(dir, file);
          try {
            const raw = await readFile(fullPath, 'utf8');
            const parsed = parseMemoryFile(raw, fullPath);
            if (parsed) {
              results.push({...parsed, scope: s});
            }
          } catch {}
        }
      } catch {}
    }

    return results;
  }

  async save(
    record: Omit<MemoryRecord, 'filePath' | 'scope'>,
    scope: 'project' | 'user' = 'project'
  ): Promise<string> {
    const dir = this.dirFor(scope);
    await mkdir(dir, {recursive: true});

    const targetFile = join(dir, `${record.name}.md`);
    const content = serializeMemoryFile(record);

    await this.atomicWrite(targetFile, content);
    await this.rebuildIndex(scope);
    return targetFile;
  }

  async delete(name: string, scope: 'project' | 'user' = 'project'): Promise<boolean> {
    const targetFile = join(this.dirFor(scope), `${name}.md`);
    try {
      await rm(targetFile, {force: true});
      await this.rebuildIndex(scope);
      return true;
    } catch {
      return false;
    }
  }

  async rebuildIndex(scope: 'project' | 'user'): Promise<void> {
    const list = await this.list(scope);
    const lines = list.map(m => `- [${m.name}](${m.name}.md) — ${m.description}`);
    const indexContent = lines.length > 0 ? `${lines.join('\n')}\n` : '';
    const indexPath = this.indexPathFor(scope);
    await this.atomicWrite(indexPath, indexContent);
  }

  async formatPromptBlock(maxItems = 30): Promise<string> {
    const all = await this.list();
    if (all.length === 0) return '';

    const lines = all.slice(0, maxItems).map(m => `- [${m.name}] (${m.type}): ${m.description}`);
    return `<project-memory>\n${lines.join('\n')}\n</project-memory>`;
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
