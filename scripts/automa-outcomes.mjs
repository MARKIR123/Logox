#!/usr/bin/env node
// Success rates of Automa workers per model, from the journals of a state directory.
// Usage: node scripts/automa-outcomes.mjs <path to a .logox/state/sessions directory>
import {readdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';

const root = process.argv[2];
if (!root) {
  console.error('Usage: node scripts/automa-outcomes.mjs <.logox/state/sessions directory>');
  process.exit(2);
}

const models = new Map();
for (const session of await readdir(root, {withFileTypes: true}).catch(() => [])) {
  if (!session.isDirectory()) continue;
  const text = await readFile(join(root, session.name, 'subagents', 'automa.jsonl'), 'utf8').catch(() => '');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {entry = JSON.parse(line);} catch {continue;}
    // Only jobs that reached a model carry one (refusals before the run have none).
    if (entry.event !== 'end' || !entry.model) continue;
    const row = models.get(entry.model) ?? {jobs: 0, done: 0, blocked: 0, failed: 0};
    row.jobs++;
    const status = entry.status ?? entry.state;
    if (status in row && status !== 'jobs') row[status]++;
    models.set(entry.model, row);
  }
}

if (!models.size) {
  console.log('No finished Automa jobs found under ' + root);
} else {
  const pad = (value, width) => String(value).padStart(width);
  const width = Math.max(5, ...[...models.keys()].map(name => name.length));
  console.log('model'.padEnd(width) + pad('jobs', 7) + pad('done', 7) + pad('blocked', 9) + pad('failed', 8) + pad('done%', 8));
  for (const [model, row] of [...models].sort((a, b) => b[1].jobs - a[1].jobs)) {
    console.log(model.padEnd(width) + pad(row.jobs, 7) + pad(row.done, 7) + pad(row.blocked, 9) + pad(row.failed, 8) + pad(Math.round(100 * row.done / row.jobs) + '%', 8));
  }
}
