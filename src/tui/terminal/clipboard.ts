import {execFile} from 'node:child_process';

/** Read plain text only after an explicit paste gesture. */
export async function readQuestionClipboard(): Promise<string | null> {
  const run = (file: string, args: readonly string[]) => new Promise<string>((resolve, reject) => {
    execFile(file, [...args], {encoding: 'utf8', timeout: 3000, maxBuffer: 128 * 1024, windowsHide: true},
      (error, stdout) => {if (error) reject(new Error('Clipboard text unavailable')); else resolve(stdout);});
  });
  if (process.platform === 'win32') {
    const encoded = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string](Get-Clipboard -Raw)))']);
    return Buffer.from(encoded.trim(), 'base64').toString('utf8') || null;
  }
  if (process.platform === 'darwin') return await run('pbpaste', []) || null;
  for (const [file, args] of [['wl-paste', ['--no-newline', '--type', 'text']], ['xclip', ['-selection', 'clipboard', '-o']], ['xsel', ['--clipboard', '--output']]] as const) {
    try {return await run(file, args) || null;} catch {}
  }
  return null;
}
export function osc52Clipboard(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`;
}
