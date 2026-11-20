#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import {countWords} from './count.mjs';

function main() {
  const args = process.argv.slice(2);
  let filePath = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write('Usage: node src/cli.mjs <file>\n');
      return;
    }
    if (arg.startsWith('-')) {
      process.stderr.write(`Unknown option: ${arg}\n`);
      process.exitCode = 1;
      return;
    }
    if (filePath !== null) {
      process.stderr.write(`Unexpected argument: ${arg}\n`);
      process.exitCode = 1;
      return;
    }
    filePath = arg;
  }

  if (!filePath) {
    process.stderr.write('Usage: node src/cli.mjs <file>\n');
    process.exitCode = 1;
    return;
  }

  const text = readFileSync(filePath, 'utf8');
  const entries = [...countWords(text).entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });

  if (entries.length === 0) return;
  const width = Math.max(...entries.map(([word]) => word.length));
  for (const [word, count] of entries) {
    process.stdout.write(`${word.padEnd(width)}  ${count}\n`);
  }
}

main();
