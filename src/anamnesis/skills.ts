/**
 * Skill operations of a harvest: the model may create a learned skill or patch one it learned earlier. The answer is data, not authority: every
 * operation is validated here, frontmatter is written by the runtime and never taken from the body, secrets are dropped, and a refusal is reported
 * on the card instead of being retried. Files are written atomically; nothing touches the running session's prompt (the skill shows up after the next
 * `/reload` or app start). Layout: `<root>/<actor>/<category>/<name>.md`, roots `~/.logox/skills` (user) and `<project>/.logox/skills` (project).
 */
import {mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {basename, dirname, join, relative} from 'node:path';
import {randomUUID} from 'node:crypto';
import {parse as parseYaml, parseDocument, stringify as stringifyYaml} from 'yaml';
import {z} from 'zod';
import {replaceFile} from '../store/replace-file.js';
import {looksSecret} from './operations.js';

export const MAX_SKILL_OPERATIONS = 2;
export const MAX_SKILL_BODY_BYTES = 8 * 1024;
export const SKILL_ACTORS = ['logox', 'techne', 'kalon', 'aletheia', 'public'] as const;
const slug = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
/** Folder names that say nothing about what is inside. */
const GENERIC_CATEGORIES: ReadonlySet<string> = new Set(['learned', 'misc', 'notes', 'general', 'other', 'others', 'stuff', 'tmp', 'temp', 'skills', 'new', 'various', 'common', 'untitled', 'default']);
const oneLine = (max: number) => z.string().trim().min(1).max(max).refine(value => !/[\r\n]/.test(value), 'One line only');
const createSchema = z.object({
  op: z.literal('create'), actor: z.enum(SKILL_ACTORS), scope: z.enum(['user', 'project']),
  category: slug.refine(value => !GENERIC_CATEGORIES.has(value), 'A category must say what is inside'), name: slug,
  description: oneLine(200), body: z.string().min(1), category_description: oneLine(200).optional(),
});
const patchSchema = z.object({op: z.literal('patch'), name: slug, old: z.string().min(1).max(MAX_SKILL_BODY_BYTES), new: z.string().max(MAX_SKILL_BODY_BYTES)});
const operationSchema = z.discriminatedUnion('op', [createSchema, patchSchema]);
export type SkillOperation = z.infer<typeof operationSchema>;
export type SkillScope = 'user' | 'project';

const FRONTMATTER = /^\s*---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
/** The body without a leading frontmatter block the model may have written. */
export const stripFrontmatter = (text: string): string => text.replace(FRONTMATTER, '').trim();
const bytes = (text: string) => Buffer.byteLength(text, 'utf8');
function fieldsOf(raw: string): {fields: Record<string, unknown>; body: string; head: string} {
  const match = FRONTMATTER.exec(raw);
  if (!match) return {fields: {}, body: raw, head: ''};
  let fields: Record<string, unknown> = {};
  try {
    const value: unknown = parseYaml(match[1]!);
    if (value && typeof value === 'object' && !Array.isArray(value)) fields = value as Record<string, unknown>;
  } catch {}
  return {fields, body: raw.slice(match[0].length), head: raw.slice(0, match[0].length)};
}

/** Valid operations (at most two, in the model's order) and why each other one was left out. */
export function validSkillOperations(raw: readonly unknown[]): {operations: SkillOperation[]; refused: string[]} {
  const operations: SkillOperation[] = [], refused: string[] = [];
  for (const item of raw) {
    const label = item && typeof item === 'object' && 'name' in item ? String((item as {name: unknown}).name).slice(0, 64) : 'skill';
    const parsed = operationSchema.safeParse(item);
    if (!parsed.success) {refused.push(label + ': ' + (parsed.error.issues[0]?.message ?? 'invalid operation') + ' (' + parsed.error.issues[0]?.path.join('.') + ')'); continue;}
    const operation = parsed.data;
    if (operation.op === 'create') {
      const body = stripFrontmatter(operation.body);
      if (!body) {refused.push(operation.name + ': the body is empty'); continue;}
      if (bytes(body) > MAX_SKILL_BODY_BYTES) {refused.push(operation.name + ': the body is over 8 KiB'); continue;}
      if (looksSecret([operation.name, operation.description, body, operation.category_description ?? ''].join('\n'))) {refused.push(operation.name + ': looks like it holds a secret'); continue;}
      operations.push({...operation, body});
    } else {
      if (looksSecret(operation.new)) {refused.push(operation.name + ': looks like it holds a secret'); continue;}
      operations.push(operation);
    }
  }
  if (operations.length > MAX_SKILL_OPERATIONS) refused.push('Only the first ' + MAX_SKILL_OPERATIONS + ' skill operations apply.');
  return {operations: operations.slice(0, MAX_SKILL_OPERATIONS), refused};
}

export interface SkillRoots {readonly user: string; readonly project: string; /** Shipped skills: their names are taken too. */ readonly builtin?: string | undefined}
export interface SkillInfo {readonly name: string; readonly path: string; readonly origin: 'builtin' | SkillScope; readonly actor: string; readonly category?: string; readonly learned: boolean; readonly description: string}
export type SkillChange =
  | {readonly kind: 'created'; readonly path: string; readonly scope: SkillScope; readonly actor: string; readonly category: string; readonly name: string; readonly text: string; readonly newCategory: boolean}
  | {readonly kind: 'patched'; readonly path: string; readonly scope: SkillScope; readonly actor: string; readonly category: string; readonly name: string; readonly before: string; readonly after: string};
export interface SkillResult {readonly changes: readonly SkillChange[]; readonly refused: readonly string[]}

async function walk(dir: string, depth = 0): Promise<string[]> {
  if (depth > 4) return [];
  let entries;
  try {entries = await readdir(dir, {withFileTypes: true});} catch {return [];}
  const out: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.')) out.push(...await walk(path, depth + 1));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(path);
  }
  return out;
}
async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), {recursive: true});
  const temp = path + '.' + randomUUID().slice(0, 8) + '.tmp';
  try {await writeFile(temp, text, 'utf8'); await replaceFile(temp, path);}
  catch (error) {await rm(temp, {force: true}).catch(() => {}); throw error;}
}

export class SkillStore {
  constructor(private readonly roots: SkillRoots, private readonly today: () => string = () => new Date().toISOString().slice(0, 10)) {}
  private rootOf(origin: SkillScope | 'builtin'): string | undefined {return origin === 'user' ? this.roots.user : origin === 'project' ? this.roots.project : this.roots.builtin;}
  /** Every skill file of the three roots (agent.md files are signposts, not skills). */
  async list(): Promise<SkillInfo[]> {
    const found: SkillInfo[] = [];
    for (const origin of ['builtin', 'user', 'project'] as const) {
      const root = this.rootOf(origin);
      if (!root) continue;
      for (const path of await walk(root)) {
        if (basename(path).toLowerCase() === 'agent.md') continue;
        let raw: string;
        try {raw = await readFile(path, 'utf8');} catch {continue;}
        const {fields} = fieldsOf(raw), parts = relative(root, path).replaceAll('\\', '/').split('/');
        const name = String(fields['name'] ?? (basename(path).toLowerCase() === 'skill.md' ? parts.at(-2) : basename(path, '.md'))).toLowerCase();
        found.push({name, path, origin, actor: parts[0] ?? '', ...(parts.length > 2 ? {category: parts[1]!.toLowerCase()} : {}), learned: fields['origin'] === 'learned', description: String(fields['description'] ?? name)});
      }
    }
    return found;
  }
  /** Categories an actor's `agent.md` files declare (every root), with their descriptions. */
  async categories(actor: string): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    for (const origin of ['builtin', 'user', 'project'] as const) {
      const root = this.rootOf(origin);
      if (!root) continue;
      try {
        const {fields} = fieldsOf(await readFile(join(root, actor, 'agent.md'), 'utf8'));
        const raw = fields['categories'];
        if (raw && typeof raw === 'object') for (const [name, description] of Object.entries(raw)) if (typeof description === 'string') result.set(name.toLowerCase(), description.trim());
      } catch {}
    }
    return result;
  }
  /** What the model needs to place and patch skills: the categories of its actor (and `public`) and the learned skills it may patch. */
  async describeFor(actor: string): Promise<string> {
    const lines: string[] = [];
    for (const owner of actor === 'public' ? ['public'] : [actor, 'public']) {
      for (const [name, description] of await this.categories(owner)) lines.push('- ' + owner + '/' + name + ': ' + description);
    }
    const learned = (await this.list()).filter(skill => skill.learned && skill.origin !== 'builtin' && (skill.actor === actor || skill.actor === 'public'));
    return 'Skill categories (actor/category: description):\n' + (lines.join('\n') || '(none)') + '\n\nLearned skills you may patch (name, scope, actor/category):\n' +
      (learned.length ? learned.map(skill => '- ' + skill.name + ' (' + skill.origin + ', ' + skill.actor + '/' + (skill.category ?? '') + '): ' + skill.description).join('\n') : '(none)');
  }
  async apply(raw: readonly unknown[], learnedBy: string): Promise<SkillResult> {
    const {operations, refused} = validSkillOperations(raw), changes: SkillChange[] = [], refusals = [...refused];
    for (const operation of operations) {
      try {
        const outcome = operation.op === 'create' ? await this.create(operation, learnedBy) : await this.patch(operation);
        if (typeof outcome === 'string') refusals.push(outcome); else changes.push(outcome);
      } catch (error) {refusals.push(operation.name + ': ' + (error instanceof Error ? error.message : String(error)));}
    }
    return {changes, refused: refusals};
  }
  private async create(operation: Extract<SkillOperation, {op: 'create'}>, learnedBy: string): Promise<SkillChange | string> {
    const {actor, scope, category, name} = operation;
    if ((await this.list()).some(skill => skill.name === name)) return name + ': already exists; patch it instead of creating it again';
    const known = await this.categories(actor), isNew = !known.has(category);
    if (isNew && !operation.category_description) return name + ': the category "' + category + '" does not exist yet, so category_description is required';
    const root = this.rootOf(scope)!, path = join(root, actor, category, name + '.md');
    const front = stringifyYaml({name, description: operation.description, origin: 'learned', learned_at: this.today(), learned_by: learnedBy}).trimEnd();
    const text = '---\n' + front + '\n---\n\n' + operation.body.trim() + '\n';
    await writeAtomic(path, text);
    if (isNew) await this.registerCategory(root, actor, category, operation.category_description!);
    return {kind: 'created', path, scope, actor, category, name, text, newCategory: isNew};
  }
  /** Adds `<category>: <description>` under `categories:` of `<root>/<actor>/agent.md`, keeping every other key and comment. */
  private async registerCategory(root: string, actor: string, category: string, description: string): Promise<void> {
    const file = join(root, actor, 'agent.md');
    let raw = '';
    try {raw = await readFile(file, 'utf8');} catch {raw = '';}
    const crlf = raw.includes('\r\n'), block = (text: string) => crlf ? text.replace(/\r?\n/g, '\r\n') : text;
    const match = /^(---\r?\n)([\s\S]*?)(\r?\n---)(\r?\n|$)([\s\S]*)$/.exec(raw.replace(/^﻿/, ''));
    let text: string;
    if (!raw.trim()) text = '---\n' + stringifyYaml({categories: {[category]: description}}) + '---\n';
    else if (match) {
      const document = parseDocument(match[2]!, {uniqueKeys: true});
      if (document.errors.length) throw new Error('agent.md has invalid frontmatter; the category was not registered');
      const categories = document.get('categories', true);
      if (categories && typeof categories === 'object' && 'items' in categories) document.setIn(['categories', category], description);
      else document.set('categories', document.createNode({[category]: description}));
      text = match[1] + block(document.toString().trimEnd()) + match[3] + match[4] + match[5];
    } else text = block('---\n' + stringifyYaml({categories: {[category]: description}}) + '---\n\n') + raw;
    await writeAtomic(file, text);
  }
  private async patch(operation: Extract<SkillOperation, {op: 'patch'}>): Promise<SkillChange | string> {
    const matches = (await this.list()).filter(skill => skill.name === operation.name && skill.origin !== 'builtin');
    const target = matches.find(skill => skill.origin === 'project') ?? matches[0];
    if (!target) return operation.name + ': no such skill to patch (only learned skills in the user or project folder can be patched)';
    if (!target.learned) return operation.name + ': only skills that were learned can be patched';
    const parsed = fieldsOf(await readFile(target.path, 'utf8'));
    if (parsed.fields['origin'] !== 'learned') return operation.name + ': only skills that were learned can be patched';
    const count = parsed.body.split(operation.old).length - 1;
    if (count !== 1) return operation.name + ': the text to replace occurs ' + count + ' times; it must occur exactly once';
    const body = parsed.body.replace(operation.old, () => operation.new);
    if (bytes(body) > MAX_SKILL_BODY_BYTES) return operation.name + ': the patched skill would be over 8 KiB';
    await writeAtomic(target.path, parsed.head + body);
    const parts = relative(this.rootOf(target.origin as SkillScope)!, target.path).replaceAll('\\', '/').split('/');
    return {kind: 'patched', path: target.path, scope: target.origin as SkillScope, actor: parts[0] ?? '', category: parts[1] ?? '', name: operation.name, before: operation.old, after: operation.new};
  }
}

/** The card text of a finished skill step: what was written, what was refused and when it shows up. */
export function skillsDetail(result: SkillResult): string {
  const sections: string[] = [];
  if (result.changes.length) sections.push(['Learned skills', ...result.changes.map(change => '• ' + change.name + ' (' + change.kind + ', ' + change.scope + ' ' + change.actor + '/' + change.category + ')'),
    'They appear in prompts after /reload or the next start.'].join('\n'));
  if (result.refused.length) sections.push(['Skill changes refused', ...result.refused.map(reason => '• ' + reason)].join('\n'));
  return sections.join('\n\n');
}
/** Markdown for the notice's page: a created skill in full (path, frontmatter, body), a patch as the region before and after. */
export function skillsPage(changes: readonly SkillChange[]): string {
  const quote = (text: string) => text.split(/\r?\n/).map(line => '> ' + line).join('\n');
  return changes.map(change => change.kind === 'created'
    ? '## Created · ' + change.actor + '/' + change.category + '/' + change.name + ' (' + change.scope + (change.newCategory ? ', new category' : '') + ')\n\n' + change.path + '\n\n' + quote(change.text)
    : '## Patched · ' + change.actor + '/' + change.category + '/' + change.name + ' (' + change.scope + ')\n\n' + change.path + '\n\nBefore:\n\n' + quote(change.before) + '\n\nAfter:\n\n' + quote(change.after)).join('\n\n');
}
