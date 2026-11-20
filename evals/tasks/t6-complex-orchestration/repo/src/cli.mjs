#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import {runAudit} from './engine.mjs';

function main() {
  const filePath = process.argv[2];
  if (!filePath || filePath === '--help' || filePath === '-h') {
    process.stdout.write('Usage: node src/cli.mjs <config.json>\n');
    if (!filePath) process.exitCode = 1;
    return;
  }

  const config = JSON.parse(readFileSync(filePath, 'utf8'));
  const audit = runAudit(config);

  for (const item of audit.results) {
    const mark = item.valid ? 'PASS' : item.level.toUpperCase();
    process.stdout.write(`[${mark}] ${item.id} ${item.name}: ${item.reason}\n`);
  }

  if (!audit.ok) {
    process.exitCode = 1;
  }
}

main();
