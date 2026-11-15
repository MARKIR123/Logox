// Where Logox keeps the runtime state of a project: `<home>/.logox/projects/<key>/` (mirrors src/config/project-data.ts:projectDataDir()).
import {homedir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';

/** Every character outside [A-Za-z0-9] becomes `-` (`G:\hz\Logox` -> `G--hz-Logox`, `/home/a/b` -> `-home-a-b`). */
export const projectKey = absolutePath => absolutePath.replace(/[^A-Za-z0-9]/g, '-');

export function projectDataDir(project, home = homedir()) {
  const absolute = resolve(project);
  return join(home, '.logox', 'projects', projectKey(process.platform === 'win32' ? absolute.replace(/^[a-z]:/, drive => drive.toUpperCase()) : absolute));
}

/**
 * The `state/sessions` folders a user path may mean, best first: the path being a data or old `.logox` folder, the project data folder of a
 * project (or of the project that holds a `.logox` folder) and the old in-project layout `<project>/.logox/state/sessions`.
 */
export function sessionsCandidates(path, home = homedir()) {
  const root = resolve(path);
  return [
    join(root, 'state', 'sessions'),
    join(projectDataDir(root, home), 'state', 'sessions'),
    ...(basename(root) === '.logox' ? [join(projectDataDir(dirname(root), home), 'state', 'sessions')] : []),
    join(root, '.logox', 'state', 'sessions'),
  ];
}
