import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';
import {getScratchpadDir} from '../kernel/scratchpad.js';
import {mcpServerSchema, type McpServerConfig} from './config.js';

export function playwrightServer(cwd: string): McpServerConfig {
  const require = createRequire(import.meta.url);
  const cli = join(dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js');
  return mcpServerSchema.parse({
    command: process.execPath,
    args: [cli, '--browser', 'chromium', '--headless', '--isolated', '--image-responses', 'allow',
      '--output-dir', dirname(getScratchpadDir(cwd, 'browser-' + randomUUID())), '--codegen', 'none', '--no-webmcp'],
    description: 'Local Playwright browser: observe, interact and capture screenshots in your own isolated browser window.',
    timeout: 90,
  });
}
