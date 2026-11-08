#!/usr/bin/env node
// Scores real LOGOX session directories with workflow-quality metrics so live test runs can be compared without reading logs.
//
//   node scripts/score-session.mjs <path> [<path> ...] [--json]
//
// <path> is a session directory (state/sessions/<id>/), a project `.logox` directory (newest session is scored, the others
// are listed) or a project directory that contains `.logox`. Several paths print one comparison table, one column per session.
//
// Data read (all optional; a metric whose data is missing prints `n/a`):
//   tasks.json            activities: owner, status, error, parent/root ids, coordinationWake, stopReason, progress.stageHistory
//   events.json           system events (model_error, ...)
//   deliveries.json       actor-to-actor messages with receipts
//   director.jsonl        Director ledger; subagents/<actor>.jsonl actor ledgers (assistant / tool / user / context records)
//   subagents/automa.jsonl  Automa worker events (start / message / tool / end)
//
// Metric definitions (also repeated next to the code that computes each one):
//   Root task      A human request (activity whose rootActivityId is itself, inputKind `human`) and every activity that has it as root.
//   Report-like    A Director assistant message that carries no tool call except `_FinishRound` and whose trimmed text is at least
//                  60 characters with markdown structure (bold, link, list item, heading) or at least 400 characters. Plain status
//                  narration ("the team is still working") and messages that also dispatch or message teammates are not report-like.
//   Final reports  Report-like Director messages per root task (ideal 1).
//   Wake           A Director activity under a root other than the root itself, started by an actor report (inputKind `actor` or
//                  coordinationWake). Late wake: a wake whose first ledger record (task time when it has none)
//                  is after the first final report of that root.
//   Stage share    Assistant turns of an actor with a stage (`message.stage` or a `⏵` line in the text) divided by all its assistant turns.
//   Round closing  Per actor activity (round) that has assistant turns: `same` = the `_FinishRound` message itself carries answer
//                  text; `separate` = answer text sits in another text-only turn (before or after); `silent` = `_FinishRound` with no
//                  answer text anywhere in the activity; `never` = no `_FinishRound` call.
//   Failure        An activity with status `failed` (reason = its error, whitespace-collapsed) plus events.json `model_error` events.
//   Write refusal  A Write tool result flagged as error that starts with the large-file notice ("Not written: ...").
//   Saved write    A refusal whose text names a `rejected-writes` path (recorded) and whether that file still exists on disk.
//   Preview server A Shell call whose command starts a static or dev server (http.server, serve, vite, live-server, ...).
//   Port conflict  A Shell result matching EADDRINUSE / address already in use / WinError 10048.
//   Navigation     A Playwright `browser_navigate` call, classified by URL scheme: file://, local http (localhost, 127.0.0.1, ::1), other.
//   Messaging      SendMessage calls per sender and `type` (reply / inform / ask / other); to-Logox counts `to` = logox.
//   Automa         Dispatches = Automa tool calls; jobs = `start` events in automa.jsonl; job failures = `end` events whose state is
//                  not `done`; keep / continue / release = jobs or calls that pass a real (non-placeholder) value for that argument.
//   Usage          Sum of `usage` on assistant records when the ledger carries it (input, output, cacheRead, cacheWrite, cost).
//   Wall time      Root task: first ledger record under the root to the last record (any actor or Automa worker) under that root.
//   Interruptions  User interrupts = activities with stopReason `user` or `interrupted`; Director stops = activities stopped with
//                  `director_cancel` plus CancelActor calls (reported side by side); interventions = inputs of kind `collaboration_interrupt`.
import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs';
import {basename, dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const EMPTY_REPLY = 'Model returned only thinking or an empty reply';
const SERVER_COMMAND = /http\.server|SimpleHTTPServer|\bhttp-server\b|\blive-server\b|\bbrowser-sync\b|\bvite\b|\bwebpack(?:-dev-server| serve)\b|\bnext (?:dev|start)\b|\bnpx\s+(?:-y\s+)?serve\b|\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:dev|serve|start)\b|(?:^|[\s;&|])serve\s+[\w./\\-]+|\bphp\s+-S\b|\bnode\s+\S*server\S*/i;
const PORT_CONFLICT = /EADDRINUSE|address already in use|port\s+\d+\s+is\s+(?:already\s+)?in use|Errno 10048|WinError 10048|Only one usage of each socket address/i;
const PLACEHOLDER = /^(?:|n\/?a|na|none|null|nil|undefined|no|false|new|fresh|omit(?:ted)?|unused|default|auto|-+|\/|\.|\.\w+|_+\w*_+|<.*>)$/i;
const LARGE_WRITE = /^Not written: this file already exists and is large/;

function readJson(file) {
  try {return JSON.parse(readFileSync(file, 'utf8'));} catch {return undefined;}
}
function readArray(file) {
  const value = readJson(file);
  return Array.isArray(value) ? value : [];
}
function readJsonl(file) {
  let text;
  try {text = readFileSync(file, 'utf8');} catch {return [];}
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {rows.push(JSON.parse(line));} catch {/* torn or foreign line */}
  }
  return rows;
}
const rate = (part, whole) => whole ? part / whole : null;
const bump = (map, key, by = 1) => {map[key] = (map[key] ?? 0) + by;};
const sum = values => values.reduce((total, value) => total + value, 0);
const parseArgs = text => {try {const value = JSON.parse(text); return value && typeof value === 'object' ? value : {};} catch {return {};}};
const realValue = value => typeof value === 'string' ? !PLACEHOLDER.test(value.trim()) : Array.isArray(value) ? value.some(realValue) : value === true;

/** Resolves a user path into the session directory to score plus the other sessions found next to it. */
export function resolveSession(path) {
  const root = resolve(path);
  const isSession = dir => existsSync(join(dir, 'director.jsonl')) || existsSync(join(dir, 'tasks.json'));
  if (isSession(root)) return {dir: root, others: []};
  const base = [join(root, 'state', 'sessions'), join(root, '.logox', 'state', 'sessions')].find(existsSync);
  if (!base) throw new Error('No LOGOX session found at ' + root);
  const stamp = dir => Math.max(0, ...['director.jsonl', 'tasks.json'].map(file => { try {return statSync(join(dir, file)).mtimeMs;} catch {return 0;} }));
  const sessions = readdirSync(base, {withFileTypes: true}).filter(entry => entry.isDirectory() && isSession(join(base, entry.name)))
    .map(entry => ({dir: join(base, entry.name), id: entry.name, stamp: stamp(join(base, entry.name))})).sort((a, b) => b.stamp - a.stamp);
  if (!sessions.length) throw new Error('No LOGOX session found in ' + base);
  return {dir: sessions[0].dir, others: sessions.slice(1).map(({id, stamp: modified}) => ({id, modified: new Date(modified).toISOString()}))};
}

/** Loads every ledger of a session into uniform records. Automa has its own event log and is read separately. */
function loadLedgers(dir) {
  const files = [['logox', join(dir, 'director.jsonl')]];
  const sub = join(dir, 'subagents');
  if (existsSync(sub)) for (const file of readdirSync(sub).sort()) if (file.endsWith('.jsonl') && file !== 'automa.jsonl') files.push([file.slice(0, -6), join(sub, file)]);
  const records = [];
  for (const [name, file] of files) {
    for (const raw of readJsonl(file)) {
      const message = raw.message ?? {};
      const text = message.text ?? raw.text;
      records.push({actor: raw.ownerId ?? name, role: raw.role ?? message.role, activityId: raw.activityId, time: raw.time,
        text: typeof text === 'string' ? text : '', toolCalls: Array.isArray(message.toolCalls) ? message.toolCalls : [],
        stage: typeof message.stage === 'string' ? message.stage : undefined, name: message.name, isError: message.isError === true,
        usage: message.usage ?? raw.usage, inputKind: raw.inputKind});
    }
  }
  return records;
}

const onlyFinish = message => message.toolCalls.every(call => call.name === '_FinishRound');
const reportLike = message => {
  if (!onlyFinish(message)) return false;
  const text = message.text.trim();
  return text.length >= 400 || (text.length >= 60 && /\*\*|\]\(|^\s*[-*] |^#{1,4} |\n\d+\. /m.test(text));
};

/** Computes every metric for one session directory. Missing data yields null values and an entry in `missing`. */
export function scoreSession(dir, {others = []} = {}) {
  const missing = [];
  const tasks = readArray(join(dir, 'tasks.json'));
  const events = readArray(join(dir, 'events.json'));
  const deliveries = readArray(join(dir, 'deliveries.json'));
  const records = loadLedgers(dir);
  const automa = readJsonl(join(dir, 'subagents', 'automa.jsonl'));
  const assistant = records.filter(record => record.role === 'assistant');
  const actors = [...new Set(records.map(record => record.actor))];

  // Root structure: each activity maps to its root; roots come from tasks.json, falling back to human inputs in the Director ledger.
  const taskById = new Map(tasks.map(task => [task.activityId, task]));
  const rootOf = id => taskById.get(id)?.rootActivityId ?? id;
  const rootIds = tasks.filter(task => task.inputKind === 'human' && rootOf(task.activityId) === task.activityId).map(task => task.activityId);
  if (!rootIds.length) for (const record of records) if (record.actor === 'logox' && record.role === 'user' && record.inputKind === 'human' && record.activityId && !rootIds.includes(record.activityId)) rootIds.push(record.activityId);
  const times = new Map();
  const touch = (root, time) => {if (typeof time !== 'number') return; const range = times.get(root) ?? [time, time]; times.set(root, [Math.min(range[0], time), Math.max(range[1], time)]);};
  for (const record of records) if (record.activityId) touch(rootOf(record.activityId), record.time);
  const starts = new Map();
  for (const record of records) if (record.activityId && typeof record.time === 'number') starts.set(record.activityId, Math.min(starts.get(record.activityId) ?? Infinity, record.time));
  for (const event of automa) if (event.parentActivityId) touch(rootOf(event.parentActivityId), event.time);

  // 1. Final reports and wakes per root task, plus wall time (first to last recorded activity under the root).
  const roots = rootIds.map((root, index) => {
    const task = taskById.get(root);
    const reports = assistant.filter(message => message.actor === 'logox' && message.activityId && rootOf(message.activityId) === root && reportLike(message));
    const firstFinal = reports.length ? Math.min(...reports.map(message => message.time ?? Infinity)) : undefined;
    const wakes = tasks.filter(item => item.ownerId === 'logox' && item.activityId !== root && rootOf(item.activityId) === root && (item.coordinationWake || item.inputKind === 'actor'));
    const late = firstFinal === undefined ? [] : wakes.filter(item => (starts.get(item.activityId) ?? item.time) > firstFinal);
    const lateIds = new Set(late.map(item => item.activityId));
    const range = times.get(root);
    return {index: index + 1, activityId: root, status: task?.status ?? null,
      prompt: String(task?.prompt ?? records.find(record => record.activityId === root && record.role === 'user')?.text ?? '').replace(/\s+/g, ' ').slice(0, 80),
      finalReports: reports.length, wakes: wakes.length, lateWakes: late.length,
      lateWakeReports: reports.filter(message => lateIds.has(message.activityId)).length, wallMs: range ? range[1] - range[0] : null};
  });

  // 2. Stage lines per actor.
  const stages = {};
  let stagesRecorded = false;
  for (const message of assistant) {
    const entry = stages[message.actor] ??= {turns: 0, withStage: 0, share: null, distinct: 0, names: new Set()};
    entry.turns++;
    const found = [message.stage, ...[...message.text.matchAll(/^\s*⏵\s*(.+)$/gm)].map(match => match[1])].filter(Boolean);
    if (found.length) {entry.withStage++; stagesRecorded = true; for (const name of found) entry.names.add(name.trim());}
  }
  for (const task of tasks) {
    const history = task.progress?.stageHistory;
    if (Array.isArray(history) && history.length && stages[task.ownerId]) {stagesRecorded = true; for (const name of history) stages[task.ownerId].names.add(String(name).trim());}
  }
  for (const entry of Object.values(stages)) {
    entry.share = stagesRecorded ? rate(entry.withStage, entry.turns) : null;
    entry.distinct = stagesRecorded ? entry.names.size : null;
    delete entry.names;
  }
  if (!stagesRecorded) missing.push('stage lines: no assistant record has a `stage` or a ⏵ line and tasks.json has no progress.stageHistory (older build)');

  // 3. Round closing per actor activity.
  const closing = {};
  const rounds = new Map();
  for (const message of assistant) if (message.activityId) {
    const key = message.actor + '\u0000' + message.activityId;
    if (!rounds.has(key)) rounds.set(key, {actor: message.actor, messages: []});
    rounds.get(key).messages.push(message);
  }
  for (const {actor, messages} of rounds.values()) {
    const entry = closing[actor] ??= {rounds: 0, same: 0, separate: 0, silent: 0, never: 0};
    entry.rounds++;
    const finish = messages.find(message => message.toolCalls.some(call => call.name === '_FinishRound'));
    if (!finish) entry.never++;
    else if (finish.text.trim()) entry.same++;
    else if (messages.some(message => message !== finish && message.text.trim() && message.toolCalls.length === 0)) entry.separate++;
    else entry.silent++;
  }

  // 4. Failures: failed tasks by reason, model_error events, tool errors.
  const reasons = {};
  let emptyReply = 0;
  const failed = tasks.filter(task => task.status === 'failed');
  for (const task of failed) {
    const raw = typeof task.error === 'string' ? task.error : task.error?.message ?? (task.error ? JSON.stringify(task.error) : 'unknown');
    bump(reasons, raw.replace(/\s+/g, ' ').trim().slice(0, 120) || 'unknown');
    if (raw.includes(EMPTY_REPLY)) emptyReply++;
  }
  const modelErrors = events.filter(event => event.kind === 'model_error');
  const toolErrors = {};
  for (const record of records) if (record.role === 'tool' && record.isError) bump(toolErrors, record.name ?? 'unknown');
  const failures = {failedTasks: failed.length, cancelledTasks: tasks.filter(task => task.status === 'cancelled').length,
    byReason: reasons, emptyReplyFailures: emptyReply, modelErrorEvents: modelErrors.length,
    emptyReplyEvents: modelErrors.filter(event => String(event.text ?? '').includes(EMPTY_REPLY)).length,
    failureNotices: deliveries.filter(item => item.kind === 'failure').length, toolErrors: sum(Object.values(toolErrors)), toolErrorsByTool: toolErrors};

  // 5. Write refusals and saved attempts.
  const refusals = records.filter(record => record.role === 'tool' && record.name === 'Write' && record.isError && LARGE_WRITE.test(record.text));
  const savedPaths = refusals.map(record => record.text.match(/saved to:\s*(.+?)\s*$/)?.[1]).filter(path => path && /rejected-writes/.test(path));
  const writes = {refusals: refusals.length, byActor: {}, savedRecorded: savedPaths.length, savedOnDisk: savedPaths.filter(path => existsSync(path)).length};
  for (const record of refusals) bump(writes.byActor, record.actor);

  // 6. Preview servers, port conflicts, browser navigations.
  const preview = {serverStarts: 0, backgroundStarts: 0, byActor: {}, portConflicts: 0, navigations: {file: 0, localHttp: 0, otherHttp: 0, other: 0}};
  for (const message of assistant) for (const call of message.toolCalls) {
    const args = parseArgs(call.arguments);
    if (call.name === 'Shell' && typeof args.command === 'string' && SERVER_COMMAND.test(args.command)) {
      preview.serverStarts++; bump(preview.byActor, message.actor);
      if (args.run_in_background === true) preview.backgroundStarts++;
    }
    if (call.name === 'mcp' && args.tool === 'browser_navigate') {
      const url = String(args.arguments?.url ?? '');
      if (/^file:/i.test(url)) preview.navigations.file++;
      else if (/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::\d+)?(?:[/?#]|$)/i.test(url)) preview.navigations.localHttp++;
      else if (/^https?:/i.test(url)) preview.navigations.otherHttp++;
      else preview.navigations.other++;
    }
  }
  for (const record of records) if (record.role === 'tool' && ['Shell', 'ShellJob'].includes(record.name) && PORT_CONFLICT.test(record.text)) preview.portConflicts++;

  // 7. Messaging by sender and type.
  const messaging = {bySender: {}, toLogox: 0, broadcasts: 0, total: 0};
  for (const message of assistant) for (const call of message.toolCalls) if (call.name === 'SendMessage') {
    const args = parseArgs(call.arguments);
    const type = ['reply', 'inform', 'ask'].includes(args.type) ? args.type : 'other';
    (messaging.bySender[message.actor] ??= {reply: 0, inform: 0, ask: 0, other: 0})[type]++;
    messaging.total++;
    const to = String(args.to ?? '').toLowerCase();
    if (to === 'logox') messaging.toLogox++;
    if (to === 'all') messaging.broadcasts++;
  }

  // 8. Automa.
  const automaStats = {dispatches: 0, byActor: {}, jobs: automa.filter(event => event.event === 'start').length,
    jobFailures: automa.filter(event => event.event === 'end' && event.state !== 'done').length,
    dispatchErrors: records.filter(record => record.role === 'tool' && record.name === 'Automa' && record.isError).length, keep: 0, continue: 0, release: 0};
  for (const message of assistant) for (const call of message.toolCalls) if (call.name === 'Automa') {
    automaStats.dispatches++; bump(automaStats.byActor, message.actor);
    const args = parseArgs(call.arguments);
    for (const job of Array.isArray(args.jobs) ? args.jobs : []) {
      if (job?.keep === true) automaStats.keep++;
      if (realValue(job?.continue)) automaStats.continue++;
    }
    if (realValue(args.release)) automaStats.release++;
  }

  // 9. Usage and session wall time.
  const zero = () => ({input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0});
  const usage = {recorded: false, costRecorded: false, total: zero(), byActor: {}};
  for (const message of assistant) if (message.usage && typeof message.usage === 'object') {
    usage.recorded = true;
    const entry = usage.byActor[message.actor] ??= zero();
    for (const key of Object.keys(usage.total)) if (typeof message.usage[key] === 'number') {
      entry[key] += message.usage[key]; usage.total[key] += message.usage[key];
      if (key === 'cost') usage.costRecorded = true;
    }
  }
  if (!usage.recorded) missing.push('tokens and cost: no ledger record carries `usage` (provider turn usage is not persisted)');
  else if (!usage.costRecorded) missing.push('cost: usage has tokens but no cost field');
  const ranges = [...times.values()];
  const wallMs = ranges.length ? Math.max(...ranges.map(range => range[1])) - Math.min(...ranges.map(range => range[0])) : null;

  // 10. Interruptions.
  const stopped = (...reasons) => tasks.filter(task => reasons.includes(task.stopReason)).length;
  const interruptions = {userInterrupts: stopped('user', 'interrupted'), directorStops: stopped('director_cancel'),
    cancelActorCalls: sum(assistant.map(message => message.toolCalls.filter(call => call.name === 'CancelActor').length)),
    interventions: records.filter(record => record.role === 'user' && record.inputKind === 'collaboration_interrupt').length};

  // dir is <project>/.logox/state/sessions/<id> for real runs; a bare session directory falls back to its id.
  const id = basename(dir);
  const project = basename(dirname(dirname(dirname(dir)))) === '.logox' ? basename(dirname(dirname(dirname(dirname(dir))))) : id.slice(0, 8);
  return {session: {id, project, label: project, dir, wallMs, actors, others}, roots,
    finalReports: {total: sum(roots.map(root => root.finalReports))},
    stages, roundClosing: closing, failures, writes, preview, messaging, automa: automaStats, usage, interruptions, missing};
}

const na = 'n/a';
const pct = value => value === null ? na : Math.round(value * 100) + '%';
const num = value => value === null || value === undefined ? na : String(value);
const duration = ms => {
  if (ms === null || ms === undefined) return na;
  const seconds = Math.round(ms / 1000);
  return Math.floor(seconds / 60) + 'm' + String(seconds % 60).padStart(2, '0') + 's';
};

/** Flattens one score into ordered [section, label, text] rows; the table merges rows with equal labels across sessions. */
export function flatten(score) {
  const rows = [];
  const add = (section, label, text) => rows.push([section, label, String(text)]);
  add('Session', 'wall time', duration(score.session.wallMs));
  add('Session', 'root tasks', score.roots.length);
  add('Final reports', 'final reports (total)', score.finalReports.total);
  for (const root of score.roots) {
    const tag = 'root #' + root.index;
    add('Final reports', tag + ' final reports', root.finalReports);
    add('Final reports', tag + ' director wakes', root.wakes);
    add('Final reports', tag + ' late wakes', root.lateWakes);
    add('Final reports', tag + ' late-wake reports', root.lateWakeReports);
    add('Final reports', tag + ' wall time', duration(root.wallMs));
  }
  for (const [actor, entry] of Object.entries(score.stages)) {
    add('Stage lines', actor + ' stage share', entry.share === null ? na : pct(entry.share) + ' (' + entry.withStage + '/' + entry.turns + ')');
    add('Stage lines', actor + ' distinct stages', num(entry.distinct));
  }
  for (const [actor, entry] of Object.entries(score.roundClosing)) {
    add('Round closing', actor + ' same/separate/silent/never', [entry.same, entry.separate, entry.silent, entry.never].join('/') + ' of ' + entry.rounds);
  }
  const failures = score.failures;
  add('Failures', 'failed tasks', failures.failedTasks);
  add('Failures', 'cancelled tasks', failures.cancelledTasks);
  add('Failures', 'empty/thinking-only reply (tasks)', failures.emptyReplyFailures);
  add('Failures', 'model_error events', failures.modelErrorEvents);
  for (const [reason, count] of Object.entries(failures.byReason)) add('Failures', 'reason: ' + reason.slice(0, 44), count);
  add('Failures', 'tool errors', failures.toolErrors);
  add('Write', 'large-overwrite refusals', score.writes.refusals);
  add('Write', 'rejected-writes recorded / on disk', score.writes.savedRecorded + ' / ' + score.writes.savedOnDisk);
  add('Preview', 'server starts (background)', score.preview.serverStarts + ' (' + score.preview.backgroundStarts + ')');
  add('Preview', 'port-in-use errors', score.preview.portConflicts);
  const nav = score.preview.navigations;
  add('Preview', 'navigations file / local http / other', [nav.file, nav.localHttp, nav.otherHttp + nav.other].join(' / '));
  add('Messaging', 'SendMessage total', score.messaging.total);
  for (const [sender, entry] of Object.entries(score.messaging.bySender)) add('Messaging', sender + ' reply/inform/ask/other', [entry.reply, entry.inform, entry.ask, entry.other].join('/'));
  add('Messaging', 'messages to Logox', score.messaging.toLogox);
  add('Automa', 'dispatches / jobs / job failures', [score.automa.dispatches, score.automa.jobs, score.automa.jobFailures].join(' / '));
  add('Automa', 'dispatch errors (rejected calls)', score.automa.dispatchErrors);
  add('Automa', 'keep / continue / release', [score.automa.keep, score.automa.continue, score.automa.release].join(' / '));
  const usage = score.usage;
  add('Cost', 'tokens in / out', usage.recorded ? usage.total.input + ' / ' + usage.total.output : na);
  add('Cost', 'cache read / write', usage.recorded ? usage.total.cacheRead + ' / ' + usage.total.cacheWrite : na);
  add('Cost', 'cost', usage.costRecorded ? usage.total.cost.toFixed(4) : na);
  add('Interruptions', 'user interrupts', score.interruptions.userInterrupts);
  add('Interruptions', 'director stops (cancelled / CancelActor)', score.interruptions.directorStops + ' / ' + score.interruptions.cancelActorCalls);
  add('Interruptions', 'director interventions', score.interruptions.interventions);
  return rows;
}

/** Renders scores as one comparison table with a column per session. */
export function renderTable(scores) {
  const labels = scores.map(score => score.session.label);
  const cells = new Map();
  scores.forEach((score, column) => {
    for (const [section, label, text] of flatten(score)) {
      const key = section + '\u0000' + label;
      if (!cells.has(key)) cells.set(key, {section, label, values: []});
      cells.get(key).values[column] = text;
    }
  });
  const rows = [...cells.values()];
  const sections = [...new Set(rows.map(row => row.section))];
  const labelWidth = Math.max(...rows.map(row => row.label.length + 2), 6);
  const widths = labels.map((label, column) => Math.max(label.length, ...rows.map(row => (row.values[column] ?? '-').length)));
  const line = (first, values) => first.padEnd(labelWidth) + '  ' + values.map((value, column) => value.padEnd(widths[column])).join('  ').trimEnd();
  const out = [line('metric', labels), '-'.repeat(labelWidth + 2 + sum(widths) + 2 * (widths.length - 1))];
  for (const section of sections) {
    out.push('[' + section + ']');
    for (const row of rows.filter(item => item.section === section)) out.push(line('  ' + row.label, labels.map((_, column) => row.values[column] ?? '-')));
  }
  out.push('');
  for (const score of scores) {
    out.push(score.session.label + ': ' + score.session.dir);
    for (const root of score.roots) out.push('  root #' + root.index + ' [' + (root.status ?? '?') + '] ' + root.prompt);
    if (score.session.others.length) out.push('  other sessions: ' + score.session.others.map(item => item.id + ' (' + item.modified.slice(0, 16) + ')').join(', '));
    for (const note of score.missing) out.push('  n/a: ' + note);
  }
  return out.join('\n');
}

export function main(argv) {
  const paths = argv.filter(arg => !arg.startsWith('--'));
  if (!paths.length || argv.includes('--help')) {
    console.error('Usage: node scripts/score-session.mjs <path> [<path> ...] [--json]\n  <path>: a session directory, a project .logox directory (newest session) or a project directory.');
    return paths.length ? 0 : 2;
  }
  const scores = paths.map(path => {const {dir, others} = resolveSession(path); return scoreSession(dir, {others});});
  console.log(argv.includes('--json') ? JSON.stringify(scores.length === 1 ? scores[0] : scores, null, 2) : renderTable(scores));
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {process.exitCode = main(process.argv.slice(2));} catch (error) {console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;}
}
