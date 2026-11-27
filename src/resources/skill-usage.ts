import {mkdir, realpath} from 'node:fs/promises';
import {dirname, join, resolve, relative, isAbsolute} from 'node:path';
import {z} from 'zod';
import {StateFile} from '../config/model-preferences.js';
import type {SkillResource} from './manager.js';

const entrySchema = z.strictObject({count: z.number().int().nonnegative(), lastUsedAt: z.number().nonnegative(), lastUsedDay: z.string()});
const usageSchema = z.strictObject({version: z.literal(1), activeDays: z.array(z.string()).default([]), skills: z.record(z.string(), entrySchema).default({})});
export type SkillUsageEntry = z.infer<typeof entrySchema>;
export type SkillUsageFile = z.infer<typeof usageSchema>;
export type SkillScope = 'user' | 'project';
/** The activity doing a read: a skill counts once per `[sessionId, activityId, skill]`. */
export interface SkillReadContext {readonly sessionId: string; readonly activityId: string}
export interface SkillUsageOptions {
  readonly home: string;
  readonly cwd: string;
  /** The project data folder (`projectDataDir()`): project skill counts live here, never in the project. */
  readonly dataDir: string;
  readonly resources: {skillAt(path: string): SkillResource | undefined};
  readonly now?: () => number;
  /** Receives a failed write; the tool call never sees it. */
  readonly onError?: (error: unknown) => void;
}
const keepDays = 400;
const emptyUsage = (): SkillUsageFile => ({version: 1, activeDays: [], skills: {}});
const inside = (root: string, path: string) => {const rel = relative(root, path); return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);};
const withDay = (days: readonly string[], day: string) => [...new Set([...days, day])].sort().slice(-keepDays);
/** The local calendar day (`YYYY-MM-DD`) of an epoch-ms time. */
export function dayOf(time: number): string {
  const date = new Date(time);
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}
/** How many distinct recorded active days fall strictly after `day`. */
export function activeDaysSince(activeDays: readonly string[], day: string): number {
  return new Set(activeDays.filter(item => item > day)).size;
}

/** Counts skill uses (a successful `Read` of a skill file, once per activity) and the days Logox was active. Writes are fire-and-forget. */
export class SkillUsage {
  private readonly now: () => number;
  private readonly userFile: StateFile<SkillUsageFile>;
  private readonly projectFile: StateFile<SkillUsageFile>;
  private readonly counted = new Set<string>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly counting = new Set<Promise<void>>();
  private dirs: Promise<{user: string; project: string}> | undefined;
  constructor(private readonly options: SkillUsageOptions) {
    this.now = options.now ?? Date.now;
    this.userFile = new StateFile(join(options.home, '.logox', 'skills', '.usage.json'), usageSchema);
    this.projectFile = new StateFile(join(options.dataDir, 'skill-usage.json'), usageSchema);
  }
  private fail(error: unknown): void {try {this.options.onError?.(error);} catch {}}
  /** Writes to one file run one after another, so concurrent records in this process never lose an update. */
  private enqueue(file: StateFile<SkillUsageFile>, change: (current: SkillUsageFile) => SkillUsageFile): void {
    const next = (this.chains.get(file.path) ?? Promise.resolve()).then(async () => {
      await mkdir(dirname(file.path), {recursive: true});
      await file.update(current => change(current ?? emptyUsage()));
    }).catch(error => this.fail(error));
    this.chains.set(file.path, next);
    void next.then(() => {if (this.chains.get(file.path) === next) this.chains.delete(file.path);});
  }
  private scopes(): Promise<{user: string; project: string}> {
    const real = (path: string) => realpath(path).catch(() => resolve(path));
    return this.dirs ??= Promise.all([real(this.options.home), real(this.options.cwd)]).then(([home, cwd]) =>
      ({user: join(home, '.logox', 'skills'), project: join(cwd, '.logox', 'skills')}));
  }
  /** Records that Logox was active today (a session started). */
  recordDay(): void {
    const day = dayOf(this.now());
    this.enqueue(this.userFile, current => ({...current, activeDays: withDay(current.activeDays, day)}));
  }
  /** Called with the canonical path of a file a `Read` returned successfully; counts it when it is a skill, once per activity. */
  read(path: string, context: SkillReadContext): void {
    const task: Promise<void> = this.count(path, context).catch(error => this.fail(error)).then(() => {this.counting.delete(task);});
    this.counting.add(task);
  }
  private async count(path: string, context: SkillReadContext): Promise<void> {
    const skill = this.options.resources.skillAt(path);
    if (!skill) return;
    const id = [context.sessionId, context.activityId, skill.name].join('\0');
    if (this.counted.has(id)) return;
    this.counted.add(id);
    const dirs = await this.scopes(), at = resolve(skill.path);
    const scope: SkillScope = !inside(dirs.user, at) && inside(dirs.project, at) ? 'project' : 'user';
    const time = this.now(), day = dayOf(time);
    this.enqueue(scope === 'user' ? this.userFile : this.projectFile, current => {
      const before = current.skills[skill.name];
      return {...current, ...(scope === 'user' ? {activeDays: withDay(current.activeDays, day)} : {}),
        skills: {...current.skills, [skill.name]: {count: (before?.count ?? 0) + 1, lastUsedAt: time, lastUsedDay: day}}};
    });
    if (scope === 'project') this.recordDay();
  }
  /** Resolves once every write queued so far has finished. */
  async idle(): Promise<void> {
    while (this.counting.size || this.chains.size) await Promise.all([...this.counting, ...this.chains.values()]);
  }
  /** The stored entry of each given skill that was ever used (keyed by name), taken from the scope its file belongs to; waits for queued writes. */
  async entriesFor(skills: readonly SkillResource[]): Promise<Readonly<Record<string, SkillUsageEntry>>> {
    const [stored, dirs] = await Promise.all([this.usage(), this.scopes()]);
    const result: Record<string, SkillUsageEntry> = {};
    for (const skill of skills) {
      const at = resolve(skill.path);
      const entry = (!inside(dirs.user, at) && inside(dirs.project, at) ? stored.project : stored.user)[skill.name];
      if (entry) result[skill.name] = entry;
    }
    return result;
  }
  /** Both scopes as stored; only the user file carries the active days. */
  async usage(): Promise<{activeDays: readonly string[]; user: Readonly<Record<string, SkillUsageEntry>>; project: Readonly<Record<string, SkillUsageEntry>>}> {
    await this.idle();
    const [user, project] = await Promise.all([this.userFile.read(), this.projectFile.read()]);
    return {activeDays: user?.activeDays ?? [], user: user?.skills ?? {}, project: project?.skills ?? {}};
  }
}
