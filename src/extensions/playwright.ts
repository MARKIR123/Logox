import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname, isAbsolute, join, win32} from 'node:path';
import {getScratchpadDir} from '../kernel/scratchpad.js';
import {mcpServerSchema, type McpServerConfig} from './config.js';

export function playwrightServer(cwd: string): McpServerConfig {
  const require = createRequire(import.meta.url);
  const cli = join(dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js');
  return mcpServerSchema.parse({
    command: process.execPath,
    args: [cli, '--browser', 'chromium', '--headless', '--isolated', '--image-responses', 'allow',
      '--output-dir', dirname(getScratchpadDir(cwd, 'browser-' + randomUUID())), '--codegen', 'none', '--no-webmcp', '--allow-unrestricted-file-access'],
    description: 'Local Playwright browser: observe, interact and capture screenshots in your own isolated browser window.',
    timeout: 90,
  });
}

/** Tool arguments that name an output file; the Playwright MCP resolves a relative one against the workspace root. */
const OUTPUT_FILE_ARGUMENTS = ['filename'] as const;

/**
 * Redirects a relative output file name (`filename`) to the calling actor's scratchpad so screenshots, snapshots and saved logs
 * never land in the project root. Absolute names are the model's explicit choice and stay as given; permissions judge them.
 */
export function scratchOutputArguments(args: Record<string, unknown>, scratchDir: string): Record<string, unknown> {
  let next = args;
  for (const key of OUTPUT_FILE_ARGUMENTS) {
    const value = args[key];
    if (typeof value !== 'string' || !value || isAbsolute(value) || win32.isAbsolute(value) || /^[a-z][a-z0-9+.-]*:/i.test(value)) continue;
    const parts = value.split(/[\/]+/).filter(part => part && part !== '.' && part !== '..');
    if (parts.length) next = {...next, [key]: join(scratchDir, ...parts)};
  }
  return next;
}

/** Server arguments with the automatic output directory (`--output-dir`) pointed at one actor's scratchpad. */
export function withOutputDir(args: readonly string[], dir: string): string[] {
  const at = args.indexOf('--output-dir');
  return at < 0 || at + 1 >= args.length ? [...args] : [...args.slice(0, at + 1), dir, ...args.slice(at + 2)];
}

/** Sent instead of a navigation to a standalone SVG: the Playwright MCP's post-navigation page snapshot hangs on SVG documents until its 30 s timeout. */
export const SVG_NAVIGATION_TEXT = 'The browser tool cannot open a standalone SVG document: its page snapshot never finishes on one and the call times out after 30 s. Open an HTML page that shows it instead, such as one containing <img src="<the svg>"> or the inline <svg>, then navigate to that page.';

/** True when `browser_navigate` targets a URL whose path ends in `.svg` (query and fragment ignored). */
export function navigatesToSvg(tool: string, args: Record<string, unknown>): boolean {
  if (tool !== 'browser_navigate' || typeof args.url !== 'string') return false;
  return /\.svgz?$/i.test(args.url.trim().split(/[?#]/)[0] ?? '');
}
