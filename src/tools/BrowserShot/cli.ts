#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir, writeFile, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, extname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import {inspect} from 'node:util';
import {capture} from './cdp.js';

const usage = 'Usage: browser-shot <fileOrUrl> [out.png] [--time <ms>] [--size <w,h>] [--full] [--frames <a,b,c>] [--diff]';

async function legacy(target: string, output: string, time: number, width: number, height: number): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  // Compiled trees may not include the historical .mjs. Use tracked source in that case.
  const script = [resolve(here, '../bin/browser-shot.mjs'), resolve(here, '../../../../src/tools/bin/browser-shot.mjs')].find(existsSync);
  if (!script) throw new Error('Legacy browser-shot.mjs not found');
  await new Promise<void>((done, reject) => {
    const child = spawn(process.execPath, [script, target, output, '--time', String(time), '--size', `${width},${height}`], {windowsHide: true, stdio: 'inherit'});
    const timer = setTimeout(() => {
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore'});
        killer.on('error', () => {});
      } else child.kill('SIGKILL');
      reject(new Error('Legacy CLI deadline exceeded'));
    }, 18000);
    child.once('error', error => {clearTimeout(timer); reject(error);});
    child.once('close', code => {clearTimeout(timer); code === 0 ? done() : reject(new Error(`Legacy CLI exited ${code}`));});
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help') || args.includes('-h')) {console.log(usage); return;}
  let target = '', output = '', time = 0, width = 1280, height = 800, fullPage = false, diff = false;
  let frames: number[] | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const key = arg.split('=')[0];
    if (key === '--time' || key === '--size' || key === '--frames') {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[++i];
      if (value === undefined) throw new Error(`Missing value for ${key}`);
      if (key === '--time') time = Math.max(0, Number.parseInt(value, 10) || 0);
      if (key === '--size') {
        const [w, h] = value.split(',').map(n => Number.parseInt(n, 10));
        if (w && h) {width = w; height = h;}
      }
      if (key === '--frames') {
        frames = value.split(',').map(Number);
        if (!frames.length || frames.length > 8 || frames.some(n => !Number.isInteger(n) || n < 0 || n > 3600)) throw new Error('--frames requires 1–8 integers in 0..3600');
        frames = [...new Set(frames)].sort((a, b) => a - b);
      }
    } else if (arg === '--full') fullPage = true;
    else if (arg === '--diff') diff = true;
    else if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}`);
    else if (!target) target = arg;
    else if (!output) output = arg;
    else throw new Error('Too many positional arguments');
  }
  if (!target) throw new Error(usage);
  const url = /^(https?|file):\/\//i.test(target) ? target : pathToFileURL(resolve(target)).href;
  const finalOutput = output ? resolve(output) : join(tmpdir(), 'logox-shots', `shot-${randomUUID()}.png`);
  await mkdir(dirname(finalOutput), {recursive: true});
  const times = frames ? frames.map(frame => frame * (1000 / 60)) : [time];
  const paths = frames ? frames.map(frame => join(dirname(finalOutput), `${basename(finalOutput, extname(finalOutput))}@${frame}.png`)) : [finalOutput];
  let images: Buffer[];
  try {
    images = await capture({url, width, height, fullPage, times});
    for (let i = 0; i < paths.length; i++) await writeFile(paths[i]!, images[i]!);
  } catch (error) {
    console.error(`[browser-shot] fell back to legacy CLI: ${inspect(error, {depth: 5})}`);
    if (fullPage) console.error('[browser-shot] legacy CLI does not support --full; capturing viewport');
    images = [];
    for (let i = 0; i < paths.length; i++) {
      await legacy(target, paths[i]!, times[i]!, width, height);
      images.push(await readFile(paths[i]!));
    }
  }
  for (let i = 0; i < images.length; i++) console.log(`[browser-shot] time=${times[i]}ms bytes=${images[i]!.length} sha256=${createHash('sha256').update(images[i]!).digest('hex')}\n${paths[i]}`);
  if (diff) {
    let allStatic = true;
    for (let i = 1; i < images.length; i++) {
      const same = images[i - 1]!.equals(images[i]!); allStatic &&= same;
      console.log(`[browser-shot] diff ${times[i - 1]}ms -> ${times[i]}ms: ${same ? 'static (byte-identical)' : 'different'}`);
    }
    if (images.length < 2) console.error('[browser-shot] --diff needs --frames with at least two frames');
    else if (allStatic) console.error('[browser-shot] static: all frames are byte-identical');
  }
}

await main().catch(error => {console.error(`[browser-shot] ${inspect(error, {depth: 5})}`); process.exitCode = 1;});
