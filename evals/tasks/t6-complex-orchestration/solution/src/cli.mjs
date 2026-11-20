#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import {auditConfig} from './engine.mjs';
import {formatJsonReport, formatMarkdownReport, formatTextReport} from './reporter.mjs';

function main() {
  const args = process.argv.slice(2);
  let filePath = null;
  let format = 'text';
  let strict = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write('Usage: node src/cli.mjs <config.json> [--format text|json|markdown] [--strict]\n');
      return;
    }
    if (arg === '--strict') {
      strict = true;
      continue;
    }
    if (arg === '--format') {
      const val = args[++i];
      if (!val) {
        process.stderr.write('Missing value for --format\n');
        process.exitCode = 1;
        return;
      }
      format = val;
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

  if (format !== 'text' && format !== 'json' && format !== 'markdown') {
    process.stderr.write(`Unsupported format: ${format}. Expected text, json, or markdown.\n`);
    process.exitCode = 1;
    return;
  }
  if (!filePath) {
    process.stderr.write('Usage: node src/cli.mjs <config.json> [--format text|json|markdown] [--strict]\n');
    process.exitCode = 1;
    return;
  }

  const config = JSON.parse(readFileSync(filePath, 'utf8'));
  const audit = auditConfig(config, {strict});

  if (format === 'json') {
    process.stdout.write(formatJsonReport(audit));
  } else if (format === 'markdown') {
    process.stdout.write(formatMarkdownReport(audit));
  } else {
    process.stdout.write(formatTextReport(audit));
  }

  if (!audit.passed) {
    process.exitCode = 1;
  }
}

main();
