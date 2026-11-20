#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import {getSortedWordCounts} from './count.mjs';

function main() {
  const args = process.argv.slice(2);
  let filePath = null;
  let format = 'text';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write('Usage: node src/cli.mjs <file> [--format text|json]\n');
      return;
    }
    if (arg === '--format') {
      const value = args[++i];
      if (!value) {
        process.stderr.write('Missing value for --format\n');
        process.exitCode = 1;
        return;
      }
      format = value;
      continue;
    }
    if (arg.startsWith('--format=')) {
      format = arg.slice('--format='.length);
      continue;
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

  if (format !== 'text' && format !== 'json') {
    process.stderr.write(`Unsupported format: ${format}. Expected "text" or "json".\n`);
    process.exitCode = 1;
    return;
  }

  if (!filePath) {
    process.stderr.write('Usage: node src/cli.mjs <file> [--format text|json]\n');
    process.exitCode = 1;
    return;
  }

  const text = readFileSync(filePath, 'utf8');
  const entries = getSortedWordCounts(text);

  if (format === 'json') {
    process.stdout.write(JSON.stringify(entries, null, 2) + '\n');
    return;
  }

  if (entries.length === 0) return;
  const width = Math.max(...entries.map(item => item.word.length));
  for (const {word, count} of entries) {
    process.stdout.write(`${word.padEnd(width)}  ${count}\n`);
  }
}

main();
