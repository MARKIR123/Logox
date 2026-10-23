import {cp, mkdir, readdir, rm, stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

/** Shipped roles that must exist in the user actor directory. */
export const BUILTIN_ACTOR_IDS = ['logox', 'techne', 'kalon', 'aletheia'] as const;

function packagedProfilesDir(): string {
  return fileURLToPath(new URL('./profiles/', import.meta.url));
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function assertProfile(directory: string): Promise<void> {
  for (const file of ['config.yaml', 'persona.md']) {
    if (!await exists(join(directory, file))) throw new Error('Missing actor profile file: ' + join(directory, file));
  }
}

/** Copies shipped profiles into a user directory, never overwriting existing files. */
export async function seedActorProfiles(home = homedir(), options: {force?: boolean} = {}): Promise<string[]> {
  const source = packagedProfilesDir();
  const target = join(home, '.logox', 'actors');
  const installed: string[] = [];
  for (const id of BUILTIN_ACTOR_IDS) {
    const from = join(source, id), to = join(target, id);
    if (!options.force && await exists(to)) continue;
    if (options.force) await rm(to, {recursive: true, force: true});
    await mkdir(target, {recursive: true});
    await cp(from, to, {recursive: true});
    installed.push(id);
  }
  return installed;
}

/** Throws with an actionable message when the installed profile set is incomplete. */
export async function assertActorProfiles(home = homedir()): Promise<void> {
  const target = join(home, '.logox', 'actors');
  const missing: string[] = [];
  for (const id of BUILTIN_ACTOR_IDS) {
    try {
      await assertProfile(join(target, id));
    } catch {
      missing.push(id);
    }
  }
  if (missing.length) {
    throw new Error('LOGOX actor profiles are missing or incomplete in ' + target + ' (missing: ' + missing.join(', ') +
      '). Run `logox --install-profiles` after installing the package.');
  }
}

/** Lists shipped profile ids, useful for sync diagnostics. */
export async function packagedActorIds(): Promise<string[]> {
  return (await readdir(packagedProfilesDir(), {withFileTypes: true})).filter(entry => entry.isDirectory()).map(entry => entry.name);
}
