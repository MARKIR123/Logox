/**
 * The skill curator: skills nobody uses for a long time are moved out of the way instead of crowding the prompt, and are never deleted.
 * Idle time counts active days (days with a session, `SkillUsage.recordDay`), not calendar days: after `STALE_ACTIVE_DAYS` without a use a
 * skill is stale (shown as such in `/skills` only), after `ARCHIVE_ACTIVE_DAYS` it moves to `<skill root>/.archive/<same relative path>`.
 * A skill that was never used starts its clock the day it is first seen; `pinned: true` in the frontmatter exempts a skill. Built-in skills
 * are archived through their seeded copy in the user root, and seeding skips what is archived (`manager.ts:ensureUserSkillsSeeded`).
 */
import {relative, isAbsolute} from 'node:path';
import type {Resources, SkillResource} from './manager.js';
import {archiveSkillFile, restoreSkillFile, splitArchived} from './skill-archive.js';
import {activeDaysSince, dayOf, type SkillScope, type SkillUsage} from './skill-usage.js';

/** Active days without a use before a skill is marked stale. */
export const STALE_ACTIVE_DAYS = 14;
/** Further active days (after stale) before a stale skill is archived. */
export const STALE_TO_ARCHIVE_ACTIVE_DAYS = 16;
/** Active days without a use before a skill is archived (14 + 16). */
export const ARCHIVE_ACTIVE_DAYS = STALE_ACTIVE_DAYS + STALE_TO_ARCHIVE_ACTIVE_DAYS;
/** The restore count at which the person is advised to pin the skill. */
export const PIN_SUGGESTION_RESTORES = 2;

export interface CuratorRun {
  /** Names archived by this run. */
  readonly archived: readonly string[];
  /** Names that are stale (idle for `STALE_ACTIVE_DAYS` or more, not yet archived). */
  readonly stale: readonly string[];
  /** Names whose idle clock started in this run. */
  readonly seen: readonly string[];
  /** Archive moves that failed (never fatal). */
  readonly failed: readonly string[];
}
export interface SkillRestored {readonly skill: SkillResource; readonly restores: number; readonly pinSuggested: boolean}
export interface SkillCuratorOptions {
  readonly usage: SkillUsage;
  readonly resources: Resources;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}

const inside = (root: string, path: string) => {const rel = relative(root, path); return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);};
const later = (a: string | undefined, b: string | undefined) => a === undefined ? b : b === undefined ? a : a > b ? a : b;

export class SkillCurator {
  private readonly now: () => number;
  private staleNames: ReadonlySet<string> = new Set();
  /** Called after every restore; the application turns the pin suggestion into a notice. */
  onRestored: ((info: SkillRestored) => void) | undefined;
  constructor(private readonly options: SkillCuratorOptions) {this.now = options.now ?? Date.now;}

  /** Skills marked stale as of the last run (and still live): shown in `/skills`, nowhere else. */
  stale(): ReadonlySet<string> {return this.staleNames;}

  /** Archived skills as of the last reload, minus those restored since. */
  archived(): readonly SkillResource[] {return this.options.resources.archived();}

  /**
   * Once per session start, after `recordDay`: starts the idle clock of newly seen skills, marks stale ones and archives the ones idle for
   * `ARCHIVE_ACTIVE_DAYS`. Reloads the resources when something moved, so the session's prompt starts without the archived skills.
   */
  async run(): Promise<CuratorRun> {
    const {usage, resources} = this.options;
    const [roots, stored] = await Promise.all([usage.roots(), usage.usage()]);
    const today = dayOf(this.now());
    const scopeOf = (path: string): SkillScope | undefined => inside(roots.user, path) ? 'user' : inside(roots.project, path) ? 'project' : undefined;
    const seen: Record<SkillScope, string[]> = {user: [], project: []};
    const toArchive: {skill: SkillResource; scope: SkillScope; root: string}[] = [], stale: string[] = [];
    for (const skill of resources.snapshot().skills) {
      const scope = scopeOf(skill.path);
      if (!scope || skill.pinned) continue;
      const entry = stored[scope][skill.name];
      const since = later(entry?.lastUsedDay, stored.seen[scope][skill.name]);
      if (since === undefined) {seen[scope].push(skill.name); continue;}
      const idle = activeDaysSince(stored.activeDays, since);
      if (idle >= ARCHIVE_ACTIVE_DAYS) toArchive.push({skill, scope, root: roots[scope]});
      else if (idle >= STALE_ACTIVE_DAYS) stale.push(skill.name);
    }
    for (const scope of ['user', 'project'] as const) {
      if (!seen[scope].length) continue;
      await usage.update(scope, current => ({...current, seen: {...current.seen, ...Object.fromEntries(seen[scope].map(name => [name, today]))}}));
    }
    const archived: string[] = [], failed: string[] = [];
    for (const {skill, scope, root} of toArchive) {
      try {
        await archiveSkillFile(root, skill.path);
        await usage.update(scope, current => ({...current, archive: {...current.archive,
          [skill.name]: {archivedAt: this.now(), restores: current.archive[skill.name]?.restores ?? 0}}}));
        archived.push(skill.name);
      } catch (error) {
        failed.push(skill.name);
        try {this.options.onError?.(error);} catch {}
      }
    }
    this.staleNames = new Set(stale);
    if (archived.length) await resources.reload();
    return Object.freeze({archived, stale, seen: [...seen.user, ...seen.project], failed});
  }

  /**
   * Moves an archived skill back, resets its idle clock and counts the restore. The skill is usable at once; the prompt lists it again
   * after the next reload. Throws when no such archived skill exists or something already stands at its place.
   */
  async restore(name: string): Promise<SkillResource> {
    const {usage, resources} = this.options;
    const wanted = name.trim().toLowerCase();
    const found = resources.archived().find(item => item.name === wanted);
    if (!found) throw new Error('No archived skill named ' + name);
    if (resources.snapshot().skills.some(item => item.name === wanted)) throw new Error('A live skill named ' + wanted + ' already exists');
    const root = splitArchived(found.path)?.root, roots = await usage.roots();
    const scope: SkillScope = root !== undefined && relative(roots.user, root) === '' ? 'user' : 'project';
    const path = await restoreSkillFile(found.path);
    const restored: SkillResource = Object.freeze({...found, path});
    let restores = 0;
    const day = dayOf(this.now());
    await usage.update(scope, current => {
      restores = (current.archive[wanted]?.restores ?? 0) + 1;
      return {...current, seen: {...current.seen, [wanted]: day}, archive: {...current.archive, [wanted]: {restores}}};
    });
    resources.adopt(restored);
    const info: SkillRestored = {skill: restored, restores, pinSuggested: restores >= PIN_SUGGESTION_RESTORES};
    try {this.onRestored?.(info);} catch {}
    return restored;
  }
}
