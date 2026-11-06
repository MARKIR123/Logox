import {spawn as nodeSpawn, type ChildProcess, type SpawnOptions} from 'node:child_process';
import {basename} from 'node:path';

export interface EditorChoice {readonly source: 'VISUAL' | 'EDITOR' | 'os'; readonly command: string; readonly args: readonly string[]; readonly shell: boolean}
export interface EditorDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly spawn?: (command: string, args: readonly string[], options: SpawnOptions) => Pick<ChildProcess, 'once' | 'unref'>;
}
const quote = (path: string) => '"' + path.replaceAll('"', '') + '"';

/** `$VISUAL`, then `$EDITOR`, else the OS default opener. The editor string may carry arguments (`code -w`), so it runs through the shell. */
export function resolveEditor(path: string, deps: EditorDeps = {}): EditorChoice {
  const env = deps.env ?? process.env, platform = deps.platform ?? process.platform;
  for (const name of ['VISUAL', 'EDITOR'] as const) {
    const value = env[name]?.trim();
    if (value) return {source: name, command: value + ' ' + quote(path), args: [], shell: true};
  }
  if (platform === 'win32') return {source: 'os', command: 'cmd', args: ['/c', 'start', '""', quote(path)], shell: false};
  return {source: 'os', command: platform === 'darwin' ? 'open' : 'xdg-open', args: [path], shell: false};
}

/** Starts the editor detached and never waits for it: the TUI does not edit text itself. Resolves with the notice to show. */
export function openInEditor(path: string, deps: EditorDeps = {}): Promise<{readonly ok: boolean; readonly message: string}> {
  const choice = resolveEditor(path, deps), spawn = deps.spawn ?? nodeSpawn, file = basename(path);
  const via = choice.source === 'os' ? 'the system opener' : '$' + choice.source;
  return new Promise(resolve => {
    try {
      const child = spawn(choice.command, choice.args, {detached: true, stdio: 'ignore', shell: choice.shell, windowsHide: true, ...(choice.shell || choice.source === 'os' && process.platform === 'win32' ? {windowsVerbatimArguments: true} : {})});
      child.once('error', error => resolve({ok: false, message: 'Could not open ' + file + ' via ' + via + ': ' + (error instanceof Error ? error.message : String(error))}));
      child.once('spawn', () => {child.unref(); resolve({ok: true, message: 'Opened ' + file + ' via ' + via + '. Run /reload after saving.'});});
    } catch (error) {
      resolve({ok: false, message: 'Could not open ' + file + ': ' + (error instanceof Error ? error.message : String(error))});
    }
  });
}
