import {readFile} from 'node:fs/promises';
import {z} from 'zod';
import type {ToolResult} from '../types.js';
import type {SkillResource} from '../../resources/manager.js';
import {SKILL_LOAD_NEEDS_NAME, SKILL_NO_LIBRARY, SKILL_SEARCH_NEEDS_QUERY, skillLoadUnknown, skillSearchEmpty} from './prompt.js';

export const skillSchema = z.strictObject({
  action: z.enum(['search', 'load']).describe('"search" finds skills by topic words; "load" returns one skill\'s instructions'),
  query: z.string().max(200).optional().describe('search: topic words; every word must appear in a skill\'s name, description or category'),
  name: z.string().max(100).optional().describe('load: the exact skill name, as listed by search'),
});

export type SkillArgs = z.infer<typeof skillSchema>;

/** What the tool needs from the host: the skills one actor sees and how often each was used (live counts), and the curator's archive. */
export interface SkillLibrary {
  visible(actorId: string): readonly SkillResource[];
  uses(skills: readonly SkillResource[]): Promise<Readonly<Record<string, {readonly count: number}>>>;
  /** Archived skills the actor would see if they were live; search lists them marked `archived`. */
  archived?(actorId: string): readonly SkillResource[];
  /** Moves an archived skill back and returns it at its live path; `load` of an archived skill calls this. */
  restore?(name: string): Promise<SkillResource>;
}

const limit = 10;
const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
};

async function search(query: string, actorId: string, library: SkillLibrary): Promise<ToolResult> {
  const words = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
  if (!words.length) return {text: SKILL_SEARCH_NEEDS_QUERY, isError: true};
  const live = library.visible(actorId), kept = new Set(live.map(skill => skill.name));
  const archived = new Set<SkillResource>((library.archived?.(actorId) ?? []).filter(skill => !kept.has(skill.name)));
  const matches = [...live, ...archived].filter(skill => {
    const haystack = [skill.name, skill.description, skill.category ?? ''].join('\n').toLowerCase();
    return words.every(word => haystack.includes(word));
  });
  if (!matches.length) return {text: skillSearchEmpty(query), isError: false};
  const uses = await library.uses(matches);
  const nameHits = (skill: SkillResource) => words.filter(word => skill.name.includes(word)).length;
  const used = (skill: SkillResource) => uses[skill.name]?.count ?? 0;
  const ranked = [...matches].sort((a, b) => nameHits(b) - nameHits(a) || Number(archived.has(a)) - Number(archived.has(b)) || used(b) - used(a) || a.name.localeCompare(b.name)).slice(0, limit);
  const lines = ranked.map(skill => [skill.name, skill.category ?? 'core', ...(archived.has(skill) ? ['archived'] : []), `uses ${used(skill)}`, oneLine(skill.description, 120), skill.path].join(' · '));
  return {text: lines.join('\n') + (matches.length > limit ? `\n(${matches.length - limit} more; narrow the query)` : ''), isError: false};
}

function closest(name: string, skills: readonly SkillResource[]): string[] {
  const wanted = name.toLowerCase();
  const prefix = (a: string, b: string) => {let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i;};
  return skills.map(skill => {
    const own = skill.name;
    const score = (own.includes(wanted) || wanted.includes(own) ? 100 : 0) + prefix(own, wanted) * 2 +
      wanted.split(/[-_\s]+/).filter(part => part.length > 1 && own.includes(part)).length * 10;
    return {name: own, score};
  }).filter(item => item.score >= 4).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, 5).map(item => item.name);
}

const stripFrontmatter = (text: string) => text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim();

async function load(name: string, actorId: string, library: SkillLibrary, used: (path: string) => void): Promise<ToolResult> {
  const visible = library.visible(actorId), wanted = name.trim().toLowerCase();
  let skill = visible.find(item => item.name === wanted), restored = false;
  if (!skill && library.restore && library.archived?.(actorId).some(item => item.name === wanted)) {
    try {skill = await library.restore(wanted); restored = true;}
    catch (error) {return {text: `Could not restore archived skill ${wanted}: ${error instanceof Error ? error.message : 'restore failed'}`, isError: true};}
  }
  if (!skill) return {text: skillLoadUnknown(name, closest(name.trim(), visible)), isError: true};
  let text: string;
  try {text = await readFile(skill.path, 'utf8');}
  catch (error) {return {text: `Could not read skill ${skill.name} (${skill.path}): ${error instanceof Error ? error.message : 'read failed'}`, isError: true};}
  try {used(skill.path);} catch {}
  return {text: `Skill ${skill.name} (${skill.path})${restored ? '\n' + 'Restored from the archive.' : ''}\n\n${stripFrontmatter(text)}`, isError: false};
}

/** `used` counts the load as a use of the skill file, the same way a successful `Read` of it does. */
export async function executeSkill(args: SkillArgs, actorId: string, library: SkillLibrary | undefined, used: (path: string) => void): Promise<ToolResult> {
  if (!library) return {text: SKILL_NO_LIBRARY, isError: true};
  if (args.action === 'search') return search(args.query ?? '', actorId, library);
  if (!args.name?.trim()) return {text: SKILL_LOAD_NEEDS_NAME, isError: true};
  return load(args.name, actorId, library, used);
}

export const metadata: import('../metadata.js').ToolMetadataInput = {name: 'Skill', category: 'core', roles: 'all', terminalVisibility: 'card', readOnly: true, description: 'Search and load skills'};
