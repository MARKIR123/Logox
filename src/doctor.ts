import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {resolveRgPath} from './tools/GrepTool/rg-path.js';

export interface DoctorCheckItem {
  readonly name: string;
  readonly status: 'pass' | 'warn' | 'fail';
  readonly message: string;
  readonly detail?: string | undefined;
}

export interface DoctorReport {
  readonly checks: readonly DoctorCheckItem[];
  readonly allPassed: boolean;
}

export function detectPlaywrightChromium(): {installed: boolean; path?: string; version?: string} {
  const custom = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const pwDir = custom && existsSync(custom)
    ? custom
    : process.platform === 'win32'
      ? process.env.LOCALAPPDATA
        ? join(process.env.LOCALAPPDATA, 'ms-playwright')
        : join(homedir(), 'AppData', 'Local', 'ms-playwright')
      : process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Caches', 'ms-playwright')
        : process.env.XDG_CACHE_HOME
          ? join(process.env.XDG_CACHE_HOME, 'ms-playwright')
          : join(homedir(), '.cache', 'ms-playwright');

  if (!existsSync(pwDir)) return {installed: false};
  try {
    const entries = readdirSync(pwDir);
    const chromiumEntry = entries.find(e => /^chromium-\d+/i.test(e));
    if (chromiumEntry) {
      return {installed: true, path: join(pwDir, chromiumEntry), version: chromiumEntry};
    }
  } catch {
    // Permission or I/O error
  }
  return {installed: false};
}

export function detectActorProfiles(): {installed: string[]; missing: string[]} {
  const targetDir = join(homedir(), '.logox', 'actors');
  const expected = ['logox', 'techne', 'kalon', 'aletheia'];
  const installed: string[] = [];
  const missing: string[] = [];

  for (const id of expected) {
    const actorDir = join(targetDir, id);
    if (existsSync(actorDir) && existsSync(join(actorDir, 'config.yaml'))) {
      installed.push(id);
    } else {
      missing.push(id);
    }
  }
  return {installed, missing};
}

export function detectCredentials(cwd = process.cwd()): {
  envFound: string[];
  dotEnvFound: boolean;
  authStorageFound: string[];
} {
  const recognizedEnv = ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY'];
  const envFound = recognizedEnv.filter(k => Boolean(process.env[k]?.trim()));
  const dotEnvFound = existsSync(join(cwd, '.env'));

  const authStorageFound: string[] = [];
  const authPaths = [join(homedir(), '.logox', 'auth.json')];
  for (const p of authPaths) {
    if (existsSync(p)) {
      try {
        const data = JSON.parse(readFileSync(p, 'utf8'));
        if (typeof data === 'object' && data !== null) {
          authStorageFound.push(...Object.keys(data));
        }
      } catch {
        // ignore parse error
      }
    }
  }

  return {envFound, dotEnvFound, authStorageFound: [...new Set(authStorageFound)]};
}

export function runDoctorChecks(cwd = process.cwd(), home = homedir()): DoctorReport {
  const checks: DoctorCheckItem[] = [];

  // 1. Node.js version
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.slice(1).split('.')[0] ?? '0', 10);
  if (major >= 22) {
    checks.push({
      name: 'Node.js Runtime',
      status: 'pass',
      message: `${nodeVersion} (>= 22.0.0 supported)`,
    });
  } else {
    checks.push({
      name: 'Node.js Runtime',
      status: 'fail',
      message: `${nodeVersion} is below the required Node.js 22+`,
      detail: 'Please upgrade Node.js to v22 LTS or v24.',
    });
  }

  // 2. Terminal TTY & Color
  const isTTY = Boolean(process.stdout.isTTY);
  const colorDepth = process.stdout.getColorDepth ? process.stdout.getColorDepth() : 4;
  const terminalApp = process.env.WT_SESSION ? 'Windows Terminal' : process.env.TERM_PROGRAM || process.env.TERM || 'Unknown';
  if (isTTY && colorDepth >= 24) {
    checks.push({
      name: 'Terminal Capabilities',
      status: 'pass',
      message: `${terminalApp} (24-bit TrueColor, interactive TTY)`,
    });
  } else if (isTTY) {
    checks.push({
      name: 'Terminal Capabilities',
      status: 'warn',
      message: `${terminalApp} (${colorDepth}-bit color, interactive TTY)`,
      detail: 'Recommend a TrueColor terminal (e.g. Windows Terminal, iTerm2, Ghostty, Alacritty) for full palette support.',
    });
  } else {
    checks.push({
      name: 'Terminal Capabilities',
      status: 'warn',
      message: 'Non-interactive stdout (not a TTY)',
      detail: 'Logox interactive full-screen TUI requires an interactive terminal.',
    });
  }

  // 3. Bundled ripgrep
  try {
    const rgPath = resolveRgPath();
    const versionOutput = execFileSync(rgPath, ['--version'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});
    const firstLine = versionOutput.trim().split('\n')[0] ?? 'ripgrep';
    checks.push({
      name: 'Bundled ripgrep',
      status: 'pass',
      message: `${firstLine} at ${rgPath}`,
    });
  } catch (error) {
    checks.push({
      name: 'Bundled ripgrep',
      status: 'fail',
      message: 'Failed to execute bundled ripgrep',
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  // 4. Playwright Chromium
  const pw = detectPlaywrightChromium();
  if (pw.installed) {
    checks.push({
      name: 'Playwright Chromium',
      status: 'pass',
      message: `Installed (${pw.version})`,
    });
  } else {
    checks.push({
      name: 'Playwright Chromium',
      status: 'warn',
      message: 'Not installed (optional for frontend / browser testing)',
      detail: 'Run `npm run browser:install` if you need companion actors to capture screenshots and verify web apps.',
    });
  }

  // 5. Actor Profiles
  const profiles = detectActorProfiles();
  if (profiles.missing.length === 0) {
    checks.push({
      name: 'Actor Profiles',
      status: 'pass',
      message: `All 4 core roles installed (${profiles.installed.join(', ')})`,
    });
  } else if (profiles.installed.length > 0) {
    checks.push({
      name: 'Actor Profiles',
      status: 'warn',
      message: `Installed: ${profiles.installed.join(', ')}; Missing: ${profiles.missing.join(', ')}`,
      detail: 'Run `logox --install-profiles` to restore default actor profiles into ~/.logox/actors/.',
    });
  } else {
    checks.push({
      name: 'Actor Profiles',
      status: 'fail',
      message: 'No actor profiles found in ~/.logox/actors/',
      detail: 'Run `logox --install-profiles` to install core actor profiles.',
    });
  }

  // 6. Model Credentials
  const creds = detectCredentials(cwd);
  const totalSources = creds.envFound.length + creds.authStorageFound.length;
  if (totalSources > 0) {
    const sourcesDesc = [
      ...creds.envFound.map(k => `env:${k}`),
      ...creds.authStorageFound.map(k => `auth:${k}`),
    ].join(', ');
    checks.push({
      name: 'Model Credentials',
      status: 'pass',
      message: `Configured (${sourcesDesc})`,
    });
  } else if (creds.dotEnvFound) {
    checks.push({
      name: 'Model Credentials',
      status: 'warn',
      message: 'Found .env file, but no standard keys (DEEPSEEK_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY) detected',
      detail: 'Check .env or run `/login` to set up your provider.',
    });
  } else {
    checks.push({
      name: 'Model Credentials',
      status: 'warn',
      message: 'No model credentials detected',
      detail: 'Set DEEPSEEK_API_KEY/OPENAI_API_KEY in .env, or run `/login` inside Logox to configure providers.',
    });
  }

  // 7. Retired legacy directory
  if (existsSync(join(home, '.logox-ts'))) {
    checks.push({
      name: 'Legacy Directory',
      status: 'warn',
      message: 'Legacy ~/.logox-ts directory found; it is no longer read. Move anything you need into ~/.logox and delete it.',
    });
  }

  const allPassed = checks.every(c => c.status !== 'fail');
  return {checks, allPassed};
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('\x1b[1m◈ Logox Doctor · Environment & Readiness Diagnosis\x1b[0m');
  lines.push('──────────────────────────────────────────────────────────');

  for (const check of report.checks) {
    const symbol =
      check.status === 'pass'
        ? '✔'
        : check.status === 'warn'
          ? '▲'
          : '✖';
    lines.push(`${symbol} \x1b[1m${check.name.padEnd(24)}\x1b[0m ${check.message}`);
    if (check.detail) {
      lines.push(`  \x1b[2m└─ ${check.detail}\x1b[0m`);
    }
  }

  lines.push('──────────────────────────────────────────────────────────');
  lines.push('\x1b[1mFont & Powerline Alignment Check:\x1b[0m');
  lines.push('   ◈ Logox  ⊞ Techne  ✧ Kalon  ◎ Aletheia ');
  lines.push('  \x1b[2m└─ If the glyphs above render smoothly without [?], your terminal has Nerd Font enabled.\x1b[0m');
  lines.push('  \x1b[2m   Recommended font: JetBrainsMono Nerd Font (JetBrainsMono NFM).\x1b[0m');
  lines.push('');

  return lines.join('\n');
}
