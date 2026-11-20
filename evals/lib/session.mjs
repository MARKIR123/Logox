import {existsSync, readdirSync, realpathSync} from 'node:fs';
import {readdir, readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join, resolve} from 'node:path';
import {projectDataDir} from '../../scripts/project-data.mjs';

function parseJsonl(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // Ignore torn or invalid JSONL lines.
    }
  }
  return rows;
}

function parseJsonSafe(text) {
  try {
    const val = JSON.parse(text);
    return val && typeof val === 'object' ? val : {};
  } catch {
    return {};
  }
}

/**
 * Locates `<home>/.logox/projects/<key>/state/sessions/<sessionId>/` for a temporary work directory.
 */
export function findSessionDir(workDir, sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return null;
  const candidates = new Set([resolve(workDir)]);
  try {
    candidates.add(realpathSync(workDir));
  } catch {
    // Ignore if workDir was already cleaned up.
  }
  try {
    candidates.add(realpathSync.native(workDir));
  } catch {
    // Ignore if workDir was already cleaned up.
  }
  for (const dir of candidates) {
    const candidate = join(projectDataDir(dir), 'state', 'sessions', sessionId);
    if (existsSync(candidate)) return candidate;
  }
  // Fallback: scan ~/.logox/projects/*/state/sessions/<sessionId>
  const projectsRoot = join(homedir(), '.logox', 'projects');
  if (existsSync(projectsRoot)) {
    for (const entry of readdirSync(projectsRoot, {withFileTypes: true})) {
      if (!entry.isDirectory()) continue;
      const candidate = join(projectsRoot, entry.name, 'state', 'sessions', sessionId);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Reads additional orchestration telemetry from a Logox session directory.
 * Returns null if the session directory does not exist.
 */
export async function readSessionMetrics(workDir, sessionId) {
  const sessionDir = findSessionDir(workDir, sessionId);
  if (!sessionDir) return null;

  const directorPath = join(sessionDir, 'director.jsonl');
  const subagentsDir = join(sessionDir, 'subagents');
  const automaPath = join(subagentsDir, 'automa.jsonl');

  const directorRows = existsSync(directorPath)
    ? parseJsonl(await readFile(directorPath, 'utf8').catch(() => ''))
    : [];

  let dispatches = 0;
  const dispatchTaskCounts = [];
  const briefChecks = {clear: 0, skipped: 0, failed: 0, gaps: 0};
  const sendMessages = {total: 0, bySender: {}};

  const recordSendMessages = (defaultActor, rows) => {
    for (const row of rows) {
      const msg = row.message ?? {};
      const actor = row.ownerId ?? defaultActor;
      const role = row.role ?? msg.role;
      const toolCalls = Array.isArray(msg.toolCalls) ? msg.toolCalls : [];
      if (role === 'assistant') {
        for (const call of toolCalls) {
          if (call?.name === 'SendMessage') {
            sendMessages.total++;
            sendMessages.bySender[actor] = (sendMessages.bySender[actor] ?? 0) + 1;
          }
        }
      }
    }
  };

  for (const row of directorRows) {
    const msg = row.message ?? {};
    const role = row.role ?? msg.role;
    const toolCalls = Array.isArray(msg.toolCalls) ? msg.toolCalls : [];
    if (role === 'assistant') {
      for (const call of toolCalls) {
        if (call?.name === 'Actor') {
          dispatches++;
          const args = parseJsonSafe(call.arguments);
          const count = Array.isArray(args.tasks) ? args.tasks.length : 0;
          dispatchTaskCounts.push(count);
        }
      }
    } else if (role === 'tool' && msg.name === 'Actor') {
      const text = typeof msg.text === 'string' ? msg.text : typeof row.text === 'string' ? row.text : '';
      if (text.includes('Brief check: clear.')) briefChecks.clear++;
      if (text.includes('Brief check: skipped.')) briefChecks.skipped++;
      if (text.includes('Brief check: failed')) briefChecks.failed++;
      if (text.includes('Brief check found gaps')) briefChecks.gaps++;
    }
  }
  recordSendMessages('logox', directorRows);

  if (existsSync(subagentsDir)) {
    const entries = await readdir(subagentsDir).catch(() => []);
    for (const file of entries.sort()) {
      if (!file.endsWith('.jsonl') || file === 'automa.jsonl') continue;
      const actorName = file.slice(0, -'.jsonl'.length);
      const rows = parseJsonl(await readFile(join(subagentsDir, file), 'utf8').catch(() => ''));
      recordSendMessages(actorName, rows);
    }
  }

  const automaRows = existsSync(automaPath)
    ? parseJsonl(await readFile(automaPath, 'utf8').catch(() => ''))
    : [];
  const automa = {
    jobs: 0,
    byRoute: {read: 0, code: 0, vision: 0},
    byStatus: {},
  };
  for (const entry of automaRows) {
    if (entry.event !== 'end') continue;
    automa.jobs++;
    const route = entry.route;
    if (route === 'read' || route === 'code' || route === 'vision') {
      automa.byRoute[route]++;
    } else if (typeof route === 'string' && route) {
      automa.byRoute[route] = (automa.byRoute[route] ?? 0) + 1;
    }
    const status = entry.status ?? entry.state ?? 'unknown';
    automa.byStatus[status] = (automa.byStatus[status] ?? 0) + 1;
  }

  return {
    sessionDir,
    dispatches,
    dispatchTaskCounts,
    dispatchedTasksTotal: dispatchTaskCounts.reduce((sum, n) => sum + n, 0),
    briefChecks,
    sendMessages,
    automa,
  };
}
