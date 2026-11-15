import {homedir} from 'node:os';
import {join, resolve} from 'node:path';

/** The runtime entries that live in a project's data folder (relative names, mirrored by the old `<project>/.logox/` layout). */
export const PROJECT_DATA_ENTRIES = ['state', 'snapshots', 'permissions.json', 'demo'] as const;

/** An absolute project path as a folder name: every character outside `[A-Za-z0-9]` becomes `-` (`G:\hz\Logox` -> `G--hz-Logox`, `/home/a/b` -> `-home-a-b`). */
export function projectKey(absolutePath: string): string {
  return absolutePath.replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * The folder for everything Logox writes by itself about one project: `<home>/.logox/projects/<key>/`.
 * The project is resolved first (a Windows drive letter is upper-cased so `g:\x` and `G:\x` agree); pass the canonical path
 * (`realpath`) where one is known so a symlinked spelling of the folder shares its data.
 * `<project>/.logox/` keeps only what the user reads, edits or commits (`config.toml`, `actors/`, `skills/`, `hooks/`, `bulletin.md`, `memory/`).
 */
export function projectDataDir(cwd: string, home: string = homedir()): string {
  const absolute = resolve(cwd);
  return join(home, '.logox', 'projects', projectKey(process.platform === 'win32' ? absolute.replace(/^[a-z]:/, drive => drive.toUpperCase()) : absolute));
}
