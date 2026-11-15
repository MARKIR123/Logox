import {cp, lstat, mkdir, readdir, rm, rmdir, unlink} from 'node:fs/promises';
import {basename, dirname, join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {PROJECT_DATA_ENTRIES, projectDataDir} from '../config/project-data.js';
import {acquireFileLock} from './file-lock.js';

export interface ProjectMigrationOptions {
  /** The canonical project folder. */
  readonly project: string;
  readonly home: string;
  /** Test hook: copies one file or folder; the default is a non-overwriting recursive copy. */
  readonly copy?: (from: string, to: string) => Promise<void>;
}
export interface ProjectMigrationResult {
  /** The folder the run keeps its runtime state in: the project data folder, or the old `<project>/.logox` when the move failed. */
  readonly dataDir: string;
  /** One-time lines for the user, in order. */
  readonly notices: readonly string[];
}
type Step = {name: string; from: string; to: string; mode: 'move' | 'merge'; files: string[]; conflicts: number};
const code = (error: unknown) => (error as NodeJS.ErrnoException).code;
const reason = (error: unknown) => error instanceof Error ? error.message : String(error);
const defaultCopy = (from: string, to: string) => cp(from, to, {recursive: true, errorOnExist: true, force: false});

async function exists(path: string): Promise<boolean> {
  try {await lstat(path); return true;}
  catch (error) {if (code(error) === 'ENOENT') return false; throw error;}
}
/** Every file under `path` as relative path to byte size; a plain file maps to its own name. */
async function listing(path: string): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const visit = async (current: string, relative: string): Promise<void> => {
    const info = await lstat(current);
    if (!info.isDirectory()) {result.set(relative, info.size); return;}
    for (const name of await readdir(current)) await visit(join(current, name), relative ? relative + '/' + name : name);
  };
  await visit(path, '');
  return result;
}
/** The cross-process lock path serializing the move of one project's data (`<home>/.logox/projects/<key>.migration`). */
export function migrationLockPath(project: string, home: string): string {
  const target = projectDataDir(project, home);
  return join(dirname(target), basename(target) + '.migration');
}
async function lockMigration(path: string): Promise<() => Promise<void>> {
  for (let attempt = 0; ; attempt++) {
    try {return await acquireFileLock(path);}
    catch (error) {
      // Another Logox is moving the same project: wait for it (a move of a large history can take a while) instead of failing.
      if (!/Another process is saving state/.test(reason(error)) || attempt >= 240) throw error;
      await delay(500);
    }
  }
}
async function plan(project: string, target: string): Promise<Step[]> {
  const steps: Step[] = [];
  for (const name of PROJECT_DATA_ENTRIES) {
    const from = join(project, '.logox', name), to = join(target, name);
    if (!await exists(from)) continue;
    const mode = await exists(to) ? 'merge' : 'move';
    steps.push({name, from, to, mode, files: [], conflicts: 0});
  }
  return steps;
}
/**
 * Moves the runtime state Logox wrote under `<project>/.logox/` (`state/`, `snapshots/`, `permissions.json`, `demo/`) to the project data folder.
 * Copy first, verify the same file list and byte sizes, then delete the old copy; any failure removes what this run created and keeps the old folder in use.
 * Entries that exist at both places are merged file by file: only files missing at the target move, conflicting ones stay where they are.
 * Nothing is created when the project has no old runtime state.
 */
export async function migrateProjectData(options: ProjectMigrationOptions): Promise<ProjectMigrationResult> {
  const {project, home} = options, copy = options.copy ?? defaultCopy;
  const target = projectDataDir(project, home), legacy = join(project, '.logox');
  const settled: ProjectMigrationResult = {dataDir: target, notices: []};
  if (!(await plan(project, target)).length) return settled;
  let release: (() => Promise<void>) | undefined;
  const created: string[] = [];
  try {
    release = await lockMigration(migrationLockPath(project, home));
    // Another process may have finished the move while this one waited.
    const steps = await plan(project, target);
    if (!steps.length) return settled;
    for (const step of steps) {
      const parent = dirname(step.to);
      if (step.mode === 'move') {
        await mkdir(parent, {recursive: true});
        created.push(step.to);
        await copy(step.from, step.to);
        const before = await listing(step.from), after = await listing(step.to);
        if (before.size !== after.size || [...before].some(([file, size]) => after.get(file) !== size)) throw new Error('Copy of ' + step.name + ' did not match the original');
        step.files = [...before.keys()];
        continue;
      }
      const sourceKind = (await lstat(step.from)).isDirectory(), targetKind = (await lstat(step.to)).isDirectory();
      if (!sourceKind || !targetKind) {step.conflicts = 1; continue;}
      const before = await listing(step.from);
      for (const [file, size] of before) {
        const from = join(step.from, file), to = join(step.to, file);
        if (await exists(to)) {step.conflicts++; continue;}
        await mkdir(dirname(to), {recursive: true});
        created.push(to);
        await copy(from, to);
        if ((await lstat(to)).size !== size) throw new Error('Copy of ' + step.name + '/' + file + ' did not match the original');
        step.files.push(file);
      }
    }
    const notices: string[] = [];
    let left = 0;
    for (const step of steps) {
      left += step.conflicts;
      try {
        if (step.mode === 'move') await rm(step.from, {recursive: true, force: true});
        else {
          for (const file of step.files) await unlink(join(step.from, file));
          const prune = async (directory: string): Promise<void> => {
            for (const name of await readdir(directory)) {
              const child = join(directory, name);
              if ((await lstat(child)).isDirectory()) await prune(child);
            }
            await rmdir(directory).catch(() => {});
          };
          if ((await lstat(step.from)).isDirectory()) await prune(step.from);
        }
      } catch {left++;}
    }
    if (steps.some(step => step.files.length || step.mode === 'move')) notices.push('Moved runtime state to ' + target + '.');
    if (left) notices.push('Runtime state exists in both ' + legacy + ' and ' + target + '; kept ' + target + '. Left in place: ' + left + ' entries.');
    return {dataDir: target, notices};
  } catch (error) {
    for (const path of created.reverse()) await rm(path, {recursive: true, force: true}).catch(() => {});
    await rmdir(target).catch(() => {});
    return {dataDir: legacy, notices: ['Could not move runtime state to ' + target + ': ' + reason(error) + '. Using ' + legacy + ' for now.']};
  } finally {
    await release?.().catch(() => {});
  }
}
