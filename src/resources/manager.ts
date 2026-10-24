import {lstat, open, readdir, realpath, mkdir, readFile, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {previousBrowserSkills} from './skill-defaults.js';
import {homedir} from 'node:os';
import {basename, dirname, join, resolve, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {commandCatalog} from '../commands.js';
import {parseDocument} from 'yaml';
import {actorIdSchema} from '../actors/definitions.js';

export type ResourceKind = 'guidelines' | 'skills' | 'commands';
export interface ResourceIssue {readonly kind: ResourceKind; readonly path: string; readonly reason: string}
export interface TextResource {readonly path: string; readonly text: string}
export interface SkillResource {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly actors?: readonly string[];
  readonly level?: 'core' | 'domain';
  readonly category?: string;
}
export interface DomainCategorySignpost {
  readonly actor: string;
  readonly category: string;
  readonly description: string;
}
export interface CommandResource extends SkillResource {readonly template: string}
export interface ResourceSnapshot {
  readonly guidelines: readonly TextResource[];
  readonly skills: readonly SkillResource[];
  readonly categories: readonly DomainCategorySignpost[];
  readonly commands: readonly CommandResource[];
  readonly issues: readonly ResourceIssue[];
}
export interface ResourceOptions {home?: string; boundary?: string}
export interface SkillVisibility {readonly actorId: string; readonly skills?: readonly string[]; readonly borrowed?: readonly string[]}
const maxBytes = 64 * 1024;
const key = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
const forbidden = (path: string) => path.split(/[\\/]/).some(part => part.toLowerCase() === 'legacy');

async function collectSkillFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  try {
    const entries = await readdir(dir, {withFileTypes: true});
    for (const entry of entries) {
      if (entry.name.startsWith('.') || forbidden(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...await collectSkillFiles(full));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(full);
      }
    }
  } catch {}
  return files;
}
export async function ensureUserSkillsSeeded(userSkillsDir: string, builtinSkillsDir: string, seedMissing = true): Promise<void> {
  try {
    if (!existsSync(builtinSkillsDir)) return;
    const files = await collectSkillFiles(builtinSkillsDir);
    for (const file of files) {
      const rel = relative(builtinSkillsDir, file);
      const target = join(userSkillsDir, rel);
      if (!existsSync(target)) {
        if (!seedMissing) continue;
        await mkdir(dirname(target), {recursive: true});
        try {await writeFile(target, await readFile(file), {flag: 'wx'});}
        catch (error) {if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;}
      } else {
        const previous = previousBrowserSkills[rel.replaceAll('\\', '/')];
        if (!previous || (await lstat(target)).isSymbolicLink()) continue;
        const current = (await readFile(target, 'utf8')).replace(/\r\n/g, '\n').replace(/\r/g, '');
        if (createHash('sha256').update(current).digest('hex') === previous) await writeFile(target, await readFile(file));
      }
    }
  } catch {}
}
function metadata(text: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  const fields: Record<string, string> = Object.create(null) as Record<string, string>;
  if (match) for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^([\w-]+):\s*(.*)$/.exec(line);
    if (field) fields[field[1]!] = field[2]!.replace(/^(['"])(.*)\1$/, '$2').trim();
  }
  const body = match ? text.slice(match[0].length).trim() : text.trim();
  return {fields, body, description: (fields.description || body.split(/\r?\n/).find(line => line.trim())?.replace(/^#+\s*/, '') || '').slice(0, 500)};
}
async function ancestors(cwd: string, boundary?: string) {
  const canonicalCwd = await realpath(cwd).catch(() => resolve(cwd));
  const canonicalBoundary = boundary ? await realpath(boundary).catch(() => resolve(boundary)) : undefined;
  const directories: string[] = [];
  let current = canonicalCwd;
  for (;;) {
    directories.unshift(current);
    if (canonicalBoundary && key(current) === key(canonicalBoundary)) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return directories;
}
export class Resources {
  private readonly assignments = new Map<string, Set<string>>();
  private readonly categoriesMap = new Map<string, Map<string, string>>();
  private value: ResourceSnapshot = Object.freeze({guidelines: [], skills: [], categories: [], commands: [], issues: []});
  constructor(readonly cwd: string, readonly options: ResourceOptions = {}) {}
  snapshot(): ResourceSnapshot {return this.value;}
  /** 显式分配只改变此 Resources 实例；借阅由单次任务输入提供，不写分配表。 */
  assignSkill(name: string, actorId: string, assigned = true): void {
    actorIdSchema.parse(actorId);
    if (!this.value.skills.some(skill => skill.name === name)) throw new Error('技能不存在');
    const actors = this.assignments.get(name) ?? new Set<string>();
    if (assigned) actors.add(actorId); else actors.delete(actorId);
    if (actors.size) this.assignments.set(name, actors); else this.assignments.delete(name);
  }
  skillsFor(input: SkillVisibility): readonly SkillResource[] {
    actorIdSchema.parse(input.actorId);
    return Object.freeze(this.value.skills.filter(skill => {
      const explicit = input.skills?.includes(skill.name) || this.assignments.get(skill.name)?.has(input.actorId);
      return explicit || input.borrowed?.includes(skill.name) || skill.actors?.includes(input.actorId)
        || (input.actorId === 'logox' && skill.actors === undefined);
    }));
  }
  categoriesFor(actorId: string, domainSkills?: readonly SkillResource[]): readonly DomainCategorySignpost[] {
    const result: DomainCategorySignpost[] = [];
    const seen = new Set<string>();

    const registered = this.categoriesMap.get(actorId);
    if (registered) {
      for (const [category, description] of registered) {
        if (!seen.has(category)) {
          seen.add(category);
          result.push(Object.freeze({actor: actorId, category, description}));
        }
      }
    }

    const publicRegistered = this.categoriesMap.get('public');
    if (publicRegistered) {
      for (const [category, description] of publicRegistered) {
        if (!seen.has(category)) {
          seen.add(category);
          result.push(Object.freeze({actor: 'public', category, description}));
        }
      }
    }

    if (domainSkills) {
      for (const skill of domainSkills) {
        if (skill.category && !seen.has(skill.category)) {
          seen.add(skill.category);
          let desc = registered?.get(skill.category) ?? publicRegistered?.get(skill.category);
          if (!desc) {
            for (const catMap of this.categoriesMap.values()) {
              if (catMap.has(skill.category)) {
                desc = catMap.get(skill.category);
                break;
              }
            }
          }
          desc = desc ?? `${skill.category} specialized workflows and domain SOPs`;
          result.push(Object.freeze({actor: actorId, category: skill.category, description: desc}));
        }
      }
    }

    return Object.freeze(result.sort((a, b) => a.category.localeCompare(b.category)));
  }
  prompt(visibility: SkillVisibility = {actorId: 'logox'}): {context: string} {
    const state = this.value;
    const skills = this.skillsFor(visibility);
    const guidelines = state.guidelines.map(item => 'Project Collaboration Guidelines: ' + item.path + '\n' + item.text);

    if (!skills.length) {
      return {context: guidelines.join('\n\n')};
    }

    const coreSkills = skills.filter(item => item.level !== 'domain');
    const domainSkills = skills.filter(item => item.level === 'domain');
    const actorCategories = this.categoriesFor(visibility.actorId, domainSkills);

    const sections: string[] = [];

    if (coreSkills.length) {
      sections.push([
        '【Core Principles】(Always in effect. Read full text via path as needed)',
        ...coreSkills.map(item => `- ${item.name}: ${item.description} (path: ${item.path})`),
      ].join('\n'));
    }

    if (actorCategories.length) {
      sections.push([
        `【Domain Repositories】(Base root: skills/${visibility.actorId}/)`,
        ...actorCategories.map(cat => `- ${cat.category}/: ${cat.description}`),
        `(Note: For specialized domain workflows, inspect directory via Glob and Read target SOP. See skills/${visibility.actorId}/agent.md for taxonomy boundaries.)`,
      ].join('\n'));
    }

    return {
      context: [
        ...guidelines,
        ...sections,
      ].filter(Boolean).join('\n\n'),
    };
  }
  expand(name: string, args: string): string | undefined {
    const command = this.value.commands.find(item => item.name === name.toLowerCase());
    if (!command) return undefined;
    if (Buffer.byteLength(args) > 16 * 1024 || args.includes('\0')) throw new Error('命令参数超过 16 KiB 或含无效字符');
    // 一次替换，参数中的占位符和 $& 等字符不会再次展开。
    const expanded = command.template.replace(/\{\{\s*args\s*\}\}|\$ARGUMENTS\b|\$args\b/gi, () => args.trim()).trim();
    if (!expanded || Buffer.byteLength(expanded) > maxBytes) throw new Error('命令展开为空或超过 64 KiB');
    return expanded;
  }
  async reload(): Promise<ResourceSnapshot> {
    const issues: ResourceIssue[] = [], seen = new Set<string>();
    const issue = (kind: ResourceKind, path: string, reason: string) => {issues.push(Object.freeze({kind, path, reason}));};
    const read = async (path: string, kind: ResourceKind): Promise<TextResource | undefined> => {
      try {
        if (forbidden(path)) throw new Error('legacy 材料不加载');
        const canonical = await realpath(path);
        if (forbidden(canonical)) throw new Error('legacy 材料不加载');
        if (seen.has(key(canonical))) return undefined;
        const handle = await open(canonical, 'r');
        let bytes: Buffer;
        try {
          if (!(await handle.stat()).isFile()) throw new Error('不是普通文件');
          const buffer = Buffer.alloc(maxBytes + 1);
          let count = 0;
          while (count < buffer.length) {
            const next = await handle.read(buffer, count, buffer.length - count, null);
            if (!next.bytesRead) break; count += next.bytesRead;
          }
          if (count > maxBytes) throw new Error('超过 64 KiB，整份跳过');
          bytes = buffer.subarray(0, count);
        } finally {await handle.close();}
        const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes).trim();
        if (!text) return undefined;
        seen.add(key(canonical));
        return Object.freeze({path: canonical, text});
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') issue(kind, path, error instanceof Error ? error.message : '读取失败');
        return undefined;
      }
    };
    // 角色人设由角色档案维护；用户目录只提供人工规范、技能与模板。
    const home = this.options.home ?? homedir();
    const userDirs = [join(home, '.logox'), join(home, '.logox-ts')];
    const guidelines: TextResource[] = [];
    let total = 0;
    for (const directory of [join(home, '.logox'), ...await ancestors(this.cwd, this.options.boundary)]) {
      const isUser = directory === join(home, '.logox');
      for (const name of isUser ? ['AGENTS.md', 'CLAUDE.md'] : ['LOGOX.md', 'AGENTS.md', 'CLAUDE.md']) {
        let selected = false;
        const candidatePaths = isUser
          ? [join(home, '.logox', name), join(home, '.logox-ts', name)]
          : [join(directory, name), join(directory, '.logox', name), join(directory, '.logox-ts', name)];
        for (const path of candidatePaths) {
          try {await lstat(path); selected = true;} catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {issue('guidelines', path, '无法检查规范文件'); selected = true;}
          }
          if (!selected) continue;
          const resource = await read(path, 'guidelines');
          if (resource) {
            const size = Buffer.byteLength(resource.text);
            if (total + size <= 128 * 1024) {guidelines.push(resource); total += size;}
            else issue('guidelines', path, '项目规范总量超过 128 KiB，整份跳过');
          }
          break;
        }
        if (selected) break;
      }
    }
    const skills = new Map<string, SkillResource>(), commands = new Map<string, CommandResource>();
    const builtins = new Set<string>(commandCatalog.map(item => item.name));

    const distBuiltinSkills = resolve(dirname(fileURLToPath(import.meta.url)), 'builtin-skills');
    const srcBuiltinSkills = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'resources', 'builtin-skills');
    const builtinSkillsDir = existsSync(distBuiltinSkills) ? distBuiltinSkills : srcBuiltinSkills;

    // Scan order: Builtin -> User global -> Project private (so project overrides user, user overrides builtin)
    const allowBuiltin = !this.options.boundary || builtinSkillsDir.toLowerCase().startsWith(this.options.boundary.toLowerCase());
    const userSkillsDir = join(home, '.logox', 'skills');
    if (allowBuiltin) {
      await ensureUserSkillsSeeded(userSkillsDir, builtinSkillsDir);
      await ensureUserSkillsSeeded(join(home, '.logox-ts', 'skills'), builtinSkillsDir, false);
    }
    const skillRoots = [...new Set([
      ...(allowBuiltin ? [builtinSkillsDir] : []),
      ...userDirs.map(d => join(d, 'skills')),
      join(this.cwd, '.logox', 'skills'),
      join(this.cwd, '.logox-ts', 'skills'),
    ])];
    const commandRoots = [...new Set([...userDirs.map(d => join(d, 'commands')), join(this.cwd, '.logox', 'commands'), join(this.cwd, '.logox-ts', 'commands')])];

    this.categoriesMap.clear();

    // 1. Scan hierarchical skill tree (Path as Prompt / Semantic Signposts)
    for (const directory of skillRoots) {
      const files = await collectSkillFiles(directory);
      for (const filePath of files) {
        if (basename(filePath).toLowerCase() === 'agent.md') {
          const resource = await read(filePath, 'skills');
          if (resource) {
            try {
              const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(resource.text);
              if (header) {
                const document = parseDocument(header[1]!, {uniqueKeys: true});
                const fields: unknown = document.toJS({maxAliasCount: 0});
                if (fields && typeof fields === 'object' && Object.hasOwn(fields, 'categories')) {
                  const rawCats = (fields as Record<string, unknown>).categories;
                  if (rawCats && typeof rawCats === 'object') {
                    const rel = relative(directory, filePath).replaceAll('\\', '/');
                    const actorSegment = rel.split('/')[0]?.toLowerCase();
                    if (actorSegment && ['kalon', 'techne', 'aletheia', 'logox', 'public'].includes(actorSegment)) {
                      let catMap = this.categoriesMap.get(actorSegment);
                      if (!catMap) {
                        catMap = new Map<string, string>();
                        this.categoriesMap.set(actorSegment, catMap);
                      }
                      for (const [catName, catDesc] of Object.entries(rawCats as Record<string, unknown>)) {
                        if (typeof catDesc === 'string') {
                          catMap.set(catName.toLowerCase(), catDesc.trim());
                        }
                      }
                    }
                  }
                }
              }
            } catch {}
          }
          continue;
        }
        const resource = await read(filePath, 'skills');
        if (!resource) continue;
        const meta = metadata(resource.text);

        const rawName = meta.fields.name || (basename(filePath).toLowerCase() === 'skill.md'
          ? basename(dirname(filePath))
          : basename(filePath, '.md'));
        const name = rawName.toLowerCase();
        if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) {
          issue('skills', filePath, '名称无效');
          continue;
        }

        // Infer default actors from directory path: e.g. skills/kalon/... -> ['kalon']
        let defaultActors: readonly string[] | undefined;
        const rel = relative(directory, filePath).replaceAll('\\', '/');
        const segments = rel.split('/');
        const firstSegment = segments[0]?.toLowerCase();
        if (firstSegment && ['kalon', 'techne', 'aletheia', 'logox'].includes(firstSegment)) {
          defaultActors = Object.freeze([firstSegment]);
        } else if (firstSegment === 'public') {
          defaultActors = Object.freeze(['logox', 'techne', 'kalon', 'aletheia']);
        }

        let level: 'core' | 'domain' = 'domain';
        let category: string | undefined;
        if (segments.length <= 2) {
          level = 'core';
        } else {
          level = 'domain';
          category = segments[1]?.toLowerCase();
        }

        let actors = defaultActors;
        try {
          const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(resource.text);
          if (header) {
            const document = parseDocument(header[1]!, {uniqueKeys: true});
            if (document.errors.length) throw new Error('技能 Frontmatter 无效');
            const fields: unknown = document.toJS({maxAliasCount: 0});
            if (fields && typeof fields === 'object' && Object.hasOwn(fields, 'actors')) {
              const raw: unknown = (fields as Record<string, unknown>).actors;
              if (!Array.isArray(raw) || raw.length > 256) throw new Error('actors 必须是角色 ID 列表');
              actors = Object.freeze([...new Set(raw.map(value => actorIdSchema.parse(String(value))))]);
            }
          }

          const item: SkillResource = {
            name,
            description: meta.description || name,
            path: resource.path,
            level,
            ...(category ? {category} : {}),
            ...(actors ? {actors} : {}),
          };
          skills.set(name, Object.freeze(item));
        } catch (error) {
          issue('skills', filePath, error instanceof Error ? error.message : '技能角色声明无效');
        }
      }
    }

    // 2. Scan custom commands
    for (const directory of commandRoots) {
      let entries;
      try {
        entries = await readdir(directory, {withFileTypes: true});
      } catch (error) {
        continue;
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 256)) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        const path = join(directory, entry.name);
        const resource = await read(path, 'commands');
        if (!resource) continue;
        const meta = metadata(resource.text);
        const name = (meta.fields.name || entry.name.slice(0, -3)).toLowerCase();
        if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) {
          issue('commands', path, '名称无效');
          continue;
        }
        if (builtins.has(name)) {
          issue('commands', path, '与内置命令重名，未加载');
          continue;
        }
        commands.set(name, Object.freeze({name, description: meta.description || name, path: resource.path, template: meta.body}));
      }
    }
    const categoriesList: DomainCategorySignpost[] = [];
    for (const [actor, catMap] of this.categoriesMap) {
      for (const [category, description] of catMap) {
        categoriesList.push(Object.freeze({actor, category, description}));
      }
    }
    this.value = Object.freeze({guidelines: Object.freeze(guidelines),
      skills: Object.freeze([...skills.values()]), categories: Object.freeze(categoriesList), commands: Object.freeze([...commands.values()]), issues: Object.freeze(issues)});
    return this.value;
  }
}
