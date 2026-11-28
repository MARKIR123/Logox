/**
 * Skill files on disk: scanning a skill root, reading one skill's metadata, and the archive moves of the curator. Archiving moves a skill
 * (its file, or its directory when it is a `SKILL.md` directory) into `<skill root>/.archive/` under the same relative path; restoring moves it
 * back. Nothing here deletes or overwrites anything: a move whose target exists is refused.
 */
import {existsSync} from 'node:fs';
import {mkdir, readdir, rename} from 'node:fs/promises';
import {basename, dirname, join, relative, sep, isAbsolute} from 'node:path';
import {parseDocument} from 'yaml';
import {actorIdSchema} from '../actors/definitions.js';
import type {SkillResource, TextResource} from './manager.js';

/** The folder inside a skill root that holds archived skills; skill scans ignore every dot folder, so it is never loaded. */
export const ARCHIVE_DIR = '.archive';
const headerPattern = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
export const forbiddenPath = (path: string) => path.split(/[\\/]/).some(part => part.toLowerCase() === 'legacy');

export async function collectSkillFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  try {
    const entries = await readdir(dir, {withFileTypes: true});
    for (const entry of entries) {
      if (entry.name.startsWith('.') || forbiddenPath(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) files.push(...await collectSkillFiles(full));
      else if (entry.isFile() && entry.name.endsWith('.md')) files.push(full);
    }
  } catch {}
  return files;
}

export function metadata(text: string) {
  const match = headerPattern.exec(text);
  const fields: Record<string, string> = Object.create(null) as Record<string, string>;
  if (match) for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^([\w-]+):\s*(.*)$/.exec(line);
    if (field) fields[field[1]!] = field[2]!.replace(/^(['"])(.*)\1$/, '$2').trim();
  }
  const body = match ? text.slice(match[0].length).trim() : text.trim();
  return {fields, body, description: (fields.description || body.split(/\r?\n/).find(line => line.trim())?.replace(/^#+\s*/, '') || '').slice(0, 500)};
}

/**
 * One skill file as a resource. `root` is the folder its relative path counts from (a skill root, or its `.archive` folder), so the actor
 * and category are inferred the same way for live and archived skills. Throws with the reason when the skill is invalid.
 */
export function describeSkill(root: string, filePath: string, resource: TextResource): SkillResource {
  const meta = metadata(resource.text);
  const rawName = meta.fields.name || (basename(filePath).toLowerCase() === 'skill.md' ? basename(dirname(filePath)) : basename(filePath, '.md'));
  const name = rawName.toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) throw new Error('Invalid name');
  // Infer default actors from the directory path: skills/kalon/... -> ['kalon'].
  let actors: readonly string[] | undefined;
  const segments = relative(root, filePath).replaceAll('\\', '/').split('/');
  const first = segments[0]?.toLowerCase();
  if (first && ['kalon', 'techne', 'aletheia', 'logox'].includes(first)) actors = Object.freeze([first]);
  else if (first === 'public') actors = Object.freeze(['logox', 'techne', 'kalon', 'aletheia']);
  const level: 'core' | 'domain' = segments.length <= 2 ? 'core' : 'domain';
  const category = level === 'domain' ? segments[1]?.toLowerCase() : undefined;
  let publicSkill = first === 'public', pinned = false;
  const header = headerPattern.exec(resource.text);
  if (header) {
    const document = parseDocument(header[1]!, {uniqueKeys: true});
    if (document.errors.length) throw new Error('Invalid skill frontmatter');
    const fields: unknown = document.toJS({maxAliasCount: 0});
    if (fields && typeof fields === 'object') {
      const record = fields as Record<string, unknown>;
      if (Object.hasOwn(record, 'actors')) {
        publicSkill = false;
        const raw = record.actors;
        if (!Array.isArray(raw) || raw.length > 256) throw new Error('actors must be a list of actor IDs');
        actors = Object.freeze([...new Set(raw.map(value => actorIdSchema.parse(String(value))))]);
      }
      pinned = record.pinned === true || record.pinned === 'true';
    }
  }
  return Object.freeze({name, description: meta.description || name, path: resource.path, level, ...(category ? {category} : {}),
    ...(publicSkill ? {public: true as const} : {}), ...(actors ? {actors} : {}), ...(pinned ? {pinned: true as const} : {})});
}

/** What gets moved for a skill file: the file itself, or its folder when the file is a `SKILL.md`. */
const unitOf = (file: string) => basename(file).toLowerCase() === 'skill.md' ? dirname(file) : file;
const within = (root: string, path: string) => {const rel = relative(root, path); return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);};

/** The skill root and the relative path of a file inside an `.archive` folder; undefined for a file that is not archived. */
export function splitArchived(file: string): {root: string; rel: string} | undefined {
  const parts = file.split(sep), at = parts.indexOf(ARCHIVE_DIR);
  if (at <= 0 || at === parts.length - 1) return undefined;
  return {root: parts.slice(0, at).join(sep), rel: parts.slice(at + 1).join(sep)};
}

async function move(from: string, to: string): Promise<void> {
  if (existsSync(to)) throw new Error('Cannot move ' + from + ': ' + to + ' already exists');
  await mkdir(dirname(to), {recursive: true});
  await rename(from, to);
}

/** Moves a live skill (file or `SKILL.md` folder) of `root` into `<root>/.archive/`; returns the new path of the skill file. Never deletes. */
export async function archiveSkillFile(root: string, file: string): Promise<string> {
  if (!within(root, file) || relative(root, file).split(/[\\/]/)[0]!.startsWith('.')) throw new Error('Not a live skill of ' + root + ': ' + file);
  await move(unitOf(file), join(root, ARCHIVE_DIR, relative(root, unitOf(file))));
  return join(root, ARCHIVE_DIR, relative(root, file));
}

/** Moves an archived skill back to its original place; returns the restored path of the skill file. Refuses when something already stands there. */
export async function restoreSkillFile(file: string): Promise<string> {
  const parts = splitArchived(file);
  if (!parts) throw new Error('Not an archived skill: ' + file);
  const archive = join(parts.root, ARCHIVE_DIR);
  await move(unitOf(file), join(parts.root, relative(archive, unitOf(file))));
  return join(parts.root, relative(archive, file));
}
