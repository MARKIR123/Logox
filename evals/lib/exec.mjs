import {spawn} from 'node:child_process';

/**
 * Runs a subprocess and captures exit code, stdout, and stderr without throwing on non-zero exits.
 */
export function runCommand(cmd, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: options.shell ?? false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on('data', chunk => {
      stdoutChunks.push(chunk);
      if (options.onStdout) options.onStdout(chunk);
    });
    child.stderr.on('data', chunk => {
      stderrChunks.push(chunk);
      if (options.onStderr) options.onStderr(chunk);
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({
        code: code ?? (signal ? 1 : 0),
        signal: signal ?? null,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}

/**
 * Runs `npm test` inside a task work directory across Windows and POSIX.
 */
export function runNpmTest(cwd) {
  return runCommand('npm', ['test'], {cwd, shell: process.platform === 'win32'});
}
