#!/usr/bin/env node
import {spawn, spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';

function printUsage() {
  console.error('Usage: browser-shot <fileOrUrl> [outputPng] [--time <ms>] [--size <width,height>]');
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  printUsage();
}

let target = '';
let outputPng = '';
let delayMs = 0;
let width = 1280;
let height = 800;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--time' && i + 1 < args.length) {
    delayMs = Math.max(0, Number.parseInt(args[++i], 10) || 0);
  } else if (arg.startsWith('--time=')) {
    delayMs = Math.max(0, Number.parseInt(arg.slice(7), 10) || 0);
  } else if (arg === '--size' && i + 1 < args.length) {
    const [w, h] = (args[++i] || '').split(',').map(n => Number.parseInt(n, 10));
    if (w && h) { width = w; height = h; }
  } else if (arg.startsWith('--size=')) {
    const [w, h] = arg.slice(7).split(',').map(n => Number.parseInt(n, 10));
    if (w && h) { width = w; height = h; }
  } else if (!target) {
    target = arg;
  } else if (!outputPng) {
    outputPng = arg;
  }
}

if (!target) {
  printUsage();
}

// 1. Resolve target URL
let targetUrl = target;
if (!/^https?:\/\//i.test(target) && !/^file:\/\//i.test(target)) {
  const absPath = resolve(process.cwd(), target);
  if (!existsSync(absPath)) {
    console.error(`[browser-shot] Error: Target file does not exist: ${absPath}`);
    process.exit(1);
  }
  targetUrl = pathToFileURL(absPath).href;
}

// 2. Resolve output PNG path
const defaultDir = join(tmpdir(), 'logox-shots');
mkdirSync(defaultDir, {recursive: true});

const finalOutput = outputPng
  ? resolve(process.cwd(), outputPng)
  : join(defaultDir, `shot-${Date.now()}-${randomUUID().slice(0, 6)}.png`);

const parentDir = resolve(finalOutput, '..');
mkdirSync(parentDir, {recursive: true});

// 3. Locate browser executable
const browserCandidates = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

let browserPath = '';
for (const cand of browserCandidates) {
  if (existsSync(cand)) {
    browserPath = cand;
    break;
  }
}

if (!browserPath) {
  // Try command lookup
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  for (const name of ['chrome', 'msedge', 'chromium', 'google-chrome']) {
    try {
      const res = spawnSync(cmd, [name], {encoding: 'utf8'});
      if (res.status === 0 && res.stdout.trim()) {
        const found = res.stdout.trim().split(/\r?\n/)[0];
        if (found && existsSync(found)) {
          browserPath = found;
          break;
        }
      }
    } catch {}
  }
}

if (!browserPath) {
  console.error('[browser-shot] Error: No Chromium-based browser (Chrome/Edge) found on this system.');
  process.exit(1);
}

// 4. Dedicated isolated profile directory
const profileDir = join(tmpdir(), 'logox-shots', `profile-${Date.now()}-${randomUUID().slice(0, 6)}`);
mkdirSync(profileDir, {recursive: true});

// 5. Construct browser arguments
const browserArgs = [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--no-first-run',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  `--user-data-dir=${profileDir}`,
  `--window-size=${width},${height}`,
  `--screenshot=${finalOutput}`,
];

// Critical: Chromium deadlocks with --virtual-time-budget=0. Only pass when > 0.
if (delayMs > 0) {
  browserArgs.push(`--virtual-time-budget=${delayMs}`);
}

browserArgs.push(targetUrl);

// 6. Execute with 15-second hard timeout
const started = Date.now();
const child = spawn(browserPath, browserArgs, {
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stderr = '';
child.stderr?.on('data', d => { stderr += d.toString(); });

const timeout = setTimeout(() => {
  if (child.pid) {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore'});
    } else {
      child.kill('SIGKILL');
    }
  }
}, 15000);
timeout.unref?.();

child.on('close', (code) => {
  clearTimeout(timeout);
  // Clean up temporary profile
  try { rmSync(profileDir, {recursive: true, force: true}); } catch {}

  const elapsed = Date.now() - started;
  if (existsSync(finalOutput)) {
    console.log(`[browser-shot] Captured screenshot (${width}x${height}) in ${elapsed}ms:\n${finalOutput}`);
    process.exit(0);
  } else {
    console.error(`[browser-shot] Failed to capture screenshot (exit code: ${code}, elapsed: ${elapsed}ms). Stderr:\n${stderr}`);
    process.exit(code || 1);
  }
});

child.on('error', (err) => {
  clearTimeout(timeout);
  try { rmSync(profileDir, {recursive: true, force: true}); } catch {}
  console.error(`[browser-shot] Process launch error: ${err.message}`);
  process.exit(1);
});
