/**
 * Headless run mode: `logox -p "<task>"` runs one task end to end without the TUI. It drives the application object through its public API
 * (`createApplication`, `submit`, `cancel`, the runtime store, the journal and the token meters): the task is submitted to the Director as a
 * human message and the run is over when the work is settled (nothing of the session is queued, running or waiting). Nobody can answer a
 * permission request or a question, so the run answers them itself (see `HEADLESS_DENIAL`, `HEADLESS_ANSWER`).
 * `runHeadless(argv, io)` is a plain function over injectable streams, so tests drive it without spawning a process.
 */
import {randomUUID} from 'node:crypto';
import {readFile, realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import {isAbsolute, join, relative, sep} from 'node:path';
import {parseArgs} from 'node:util';
import {createApplication} from './application.js';
import {loadConfig, type Config} from './config/config.js';
import {applyUiSettings} from './config/ui-settings.js';
import {permissionModeSchema} from './permissions/engine.js';
import {AuthStorage} from './providers/auth.js';
import {CustomProviderStorage} from './providers/custom-storage.js';
import {ProviderRegistry} from './providers/registry.js';
import {stripLeadingActionLines} from './context/contracts.js';
import {costOf} from './context/cost.js';
import type {UsageRecord} from './context/budget.js';
import type {ResourceOptions} from './resources/manager.js';
import {stripNarration} from './runtime/narration.js';
import {answerEnvelope} from './runtime/interactions.js';
import {DIRECTOR_ID} from './runtime/director-id.js';
import {activityCosts, projectDelegations} from './runtime/delegations.js';
import type {Provider} from './runtime/messages.js';
import type {Activity, Message} from './runtime/contracts.js';

// The two answers are model-visible runtime text, so they live with the other prompt constants (`src/kernel/echo-guard.ts` recognises them).
import {HEADLESS_ANSWER, HEADLESS_DENIAL} from './prompts/runtime/headless.js';
export {HEADLESS_ANSWER, HEADLESS_DENIAL};
export const HEADLESS_NO_MODEL = 'No usable model: run logox interactively and /login first.';

export const HEADLESS_EXIT = {completed: 0, failed: 1, interrupted: 2, setup: 3} as const;
export type HeadlessStatus = 'completed' | 'failed' | 'cancelled' | 'timeout';

export const HEADLESS_HELP =
  '  -p, --print <task>             Run one task without the TUI and print the Director\'s final reply (use - to read the task from stdin)\n' +
  '  --task-file <path>             Read the task for a headless run from a file\n' +
  '  --output <text|json>           Headless output: the final reply (default) or one JSON object\n' +
  '  --verbose                      Headless progress lines on stderr: [mm:ss] <actor> · <title> · <status or tool>\n' +
  '  --permission-mode <mode>       Headless only: default, auto or creative for this run (not saved)\n' +
  '  --timeout <minutes>            Headless only: cancel all work after this wall-clock time and exit 2 (a harness guard, not an agent limit)\n';

export interface HeadlessIo {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout(text: string): void;
  stderr(text: string): void;
  /** Reads the whole standard input (`-p -`). */
  stdin?: () => Promise<string>;
  /** The process, or anything with its signal methods; SIGINT and SIGTERM cancel the run. */
  signals?: {on(signal: 'SIGINT' | 'SIGTERM', handler: () => void): unknown; removeListener(signal: 'SIGINT' | 'SIGTERM', handler: () => void): unknown};
  /** Test hooks, passed through to `createApplication`. */
  provider?: Provider;
  fetcher?: typeof fetch;
  resourceOptions?: ResourceOptions;
  authPath?: string;
  outageDelaysMs?: readonly number[];
}

/** True when the arguments ask for a headless run (and not for the help text). */
export function isHeadlessArgv(argv: readonly string[]): boolean {
  if (argv.includes('--help')) return false;
  return argv.some(arg => arg === '-p' || arg === '--print' || arg.startsWith('--print=') || arg === '--task-file' || arg.startsWith('--task-file='));
}

interface HeadlessArgs {
  task: {kind: 'text'; text: string} | {kind: 'stdin'} | {kind: 'file'; path: string};
  output: 'text' | 'json'; verbose: boolean; timeoutMs?: number; permissionMode?: ReturnType<typeof permissionModeSchema.parse>;
  session?: string; resume: boolean; model?: string; provider?: string; baseUrl?: string; authFile?: string;
}
function parseHeadless(argv: readonly string[]): HeadlessArgs {
  const {values} = parseArgs({args: [...argv], options: {
    print: {type: 'string', short: 'p'}, 'task-file': {type: 'string'}, output: {type: 'string'}, verbose: {type: 'boolean'}, timeout: {type: 'string'},
    'permission-mode': {type: 'string'}, session: {type: 'string'}, resume: {type: 'boolean'}, model: {type: 'string'}, provider: {type: 'string'},
    'base-url': {type: 'string'}, 'auth-file': {type: 'string'},
  }});
  if (values.print !== undefined && values['task-file'] !== undefined) throw new Error('Use either -p/--print or --task-file, not both');
  if (values.print === undefined && values['task-file'] === undefined) throw new Error('A headless run needs -p/--print <task> or --task-file <path>');
  const output = values.output ?? 'text';
  if (output !== 'text' && output !== 'json') throw new Error('--output must be text or json');
  let timeoutMs: number | undefined;
  if (values.timeout !== undefined) {
    const minutes = Number(values.timeout);
    if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('--timeout needs a positive number of minutes');
    timeoutMs = Math.min(minutes * 60_000, 2_147_483_000);
  }
  const mode = values['permission-mode'] === undefined ? undefined : permissionModeSchema.safeParse(values['permission-mode']);
  if (mode && !mode.success) throw new Error('--permission-mode must be default, auto or creative');
  if (values.session !== undefined && !values.session.trim()) throw new Error('--session requires a valid session ID');
  const task = values['task-file'] !== undefined ? {kind: 'file' as const, path: values['task-file']}
    : values.print === '-' ? {kind: 'stdin' as const} : {kind: 'text' as const, text: values.print!};
  return {task, output, verbose: values.verbose === true, ...(timeoutMs !== undefined ? {timeoutMs} : {}), ...(mode?.success ? {permissionMode: mode.data} : {}),
    ...(values.session ? {session: values.session} : {}), resume: values.resume === true, ...(values.model ? {model: values.model} : {}),
    ...(values.provider ? {provider: values.provider} : {}), ...(values['base-url'] ? {baseUrl: values['base-url']} : {}), ...(values['auth-file'] ? {authFile: values['auth-file']} : {})};
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const LIVE = new Set(['queued', 'running', 'waiting_input']);
/** The work must look settled and the store must not have changed for this long before the run ends (a report handoff wakes the Director a moment after a companion ends). */
const STABLE_MS = 150;
const POLL_MS = 50;
/** After a cancel the work gets this long to wind down before the application is closed anyway. */
const CANCEL_GRACE_MS = 60_000;

interface Totals {inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number | null}
function totalsOf(records: readonly UsageRecord[], config: Config): Totals {
  const cost = costOf(records, config);
  return {inputTokens: records.reduce((sum, record) => sum + record.input, 0), outputTokens: records.reduce((sum, record) => sum + record.output, 0),
    cacheReadTokens: records.reduce((sum, record) => sum + record.cacheRead, 0), cacheWriteTokens: records.reduce((sum, record) => sum + record.cacheWrite, 0),
    costUsd: cost && cost.currency === 'USD' ? Number(cost.amount.toFixed(6)) : null};
}
const clock = (ms: number) => {const seconds = Math.floor(ms / 1000); return String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');};

/** Fails early, before an application (and its onboarding wizard) is created, when no model can be used. */
async function usableModel(config: Config, io: HeadlessIo): Promise<boolean> {
  const home = io.resourceOptions?.home ?? homedir();
  const registry = new ProviderRegistry(config, io.env, io.fetcher, new AuthStorage(io.authPath ?? join(home, '.logox', 'auth.json')), new CustomProviderStorage(join(home, '.logox', 'custom-providers.json')));
  try {
    await registry.syncCustom().catch(() => {});
    if (!registry.selection().model.trim()) return false;
    await registry.settings(true);
    return true;
  } catch {return false;}
  finally {await registry.close();}
}

export async function runHeadless(argv: readonly string[], io: HeadlessIo): Promise<number> {
  const setup = (message: string) => {io.stderr(message + '\n'); return HEADLESS_EXIT.setup;};
  let args: HeadlessArgs, task: string;
  try {args = parseHeadless(argv);} catch (error) {return setup(error instanceof Error ? error.message : String(error));}
  try {
    task = args.task.kind === 'text' ? args.task.text : args.task.kind === 'stdin' ? await (io.stdin?.() ?? Promise.reject(new Error('Standard input is not available'))) : await readFile(args.task.path, 'utf8');
  } catch (error) {return setup('Cannot read the task: ' + (error instanceof Error ? error.message : String(error)));}
  task = task.trim();
  if (!task) return setup('The task is empty');
  let config: Config;
  try {
    config = await loadConfig(io.cwd, {provider: {...(args.model ? {model: args.model} : {}), ...(args.provider ? {name: args.provider} : {}),
      ...(args.baseUrl ? {base_url: args.baseUrl} : {}), ...(args.authFile ? {auth_file: args.authFile} : {})}}, io.env, io.resourceOptions?.home, io.resourceOptions?.boundary);
  } catch (error) {return setup(error instanceof Error ? error.message : String(error));}
  if (!io.provider && !await usableModel(config, io)) return setup(HEADLESS_NO_MODEL);
  let app: Awaited<ReturnType<typeof createApplication>>;
  try {
    // Unlike the TUI, a headless run starts a fresh session unless `--session` or `--resume` says otherwise (the TUI reopens the project's latest one),
    // so two unattended runs in one project never share a conversation by accident.
    app = await createApplication({cwd: io.cwd, config, env: io.env, anamnesis: {disabled: true},
      ...(args.session ? {sessionId: args.session} : args.resume ? {resume: true} : {sessionId: randomUUID()}),
      ...(io.provider ? {provider: io.provider} : {}), ...(io.fetcher ? {fetcher: io.fetcher} : {}), ...(io.resourceOptions ? {resourceOptions: io.resourceOptions} : {}),
      ...(io.authPath ? {authPath: io.authPath} : {}), ...(io.outageDelaysMs ? {outageDelaysMs: io.outageDelaysMs} : {})});
  } catch (error) {return setup(error instanceof Error ? error.message : String(error));}
  let outcome: Awaited<ReturnType<typeof drive>> | undefined;
  try {outcome = await drive(app, task, args, config, io);}
  catch (error) {io.stderr('[Error] ' + (error instanceof Error ? error.message : String(error)) + '\n');}
  finally {await app.close();}
  return outcome ? emit(outcome, args, io) : HEADLESS_EXIT.failed;
}

type App = Awaited<ReturnType<typeof createApplication>>;
async function drive(app: App, task: string, args: HeadlessArgs, config: Config, io: HeadlessIo) {
  const {store} = app, session = app.sessionId, started = Date.now();
  io.stderr('Session ' + session + '\n');
  // This run only: the mode is held by the engine in memory and never written (`setMode` is what saves). Notifications and bells are a terminal matter.
  if (args.permissionMode) app.permissions.mode = args.permissionMode;
  applyUiSettings({notify: 'off'});
  const baselineActivities = new Set(store.getSnapshot().activities.map(activity => activity.activityId));
  const ledger = await app.journal.load(session, DIRECTOR_ID);
  const baselineLength = ledger.length;
  const records = () => [...app.contexts.sessionMeters(session)].flatMap(([owner, meter]) => meter.usageRecords().map(record => ({owner, record})));
  if (baselineLength > 0) {
    // A resumed session restores its usage into the meters in the background; the baseline is taken once their count stops growing.
    let previous = -1;
    for (let waited = 0; waited < 1500; waited += 25) {const count = records().length; if (count === previous) break; previous = count; await sleep(25);}
  }
  const baselineUsage = new Set(records().map(item => item.record.id));
  const runActivities = () => store.getSnapshot().activities.filter(activity => activity.sessionId === session && !baselineActivities.has(activity.activityId) && activity.kind !== 'anamnesis');
  const nameOf = (id: string) => app.actors.find(id)?.name ?? id;

  // Questions and permission requests: nobody is here to answer, so the run answers them itself.
  const answered = new Set<string>();
  const answerInteractions = () => {
    for (const request of store.interactions.list()) {
      if (request.status !== 'pending' || answered.has(request.requestId)) continue;
      answered.add(request.requestId);
      if (request.kind === 'permission') store.interactions.respond(answerEnvelope(request, {kind: 'permission', decision: 'deny', note: HEADLESS_DENIAL}));
      else store.interactions.respond(answerEnvelope(request, {kind: 'question',
        answers: Object.fromEntries(request.questions.map(question => [question.id, {type: 'text' as const, text: HEADLESS_ANSWER}]))}));
    }
  };
  let setupError: string | undefined, cancelling = false, forced = false, interrupted = false, timedOut = false;
  const sawLogin = () => {
    if (!app.authentication.getSnapshot() || setupError) return;
    setupError = HEADLESS_NO_MODEL;
    app.authentication.cancel();
    cancelling = true;
  };
  const seen = new Set<string>();
  const progress = () => {
    if (!args.verbose) return;
    const snapshot = store.getSnapshot(), activities = new Map(runActivities().map(activity => [activity.activityId, activity] as const));
    const line = (activity: Activity, what: string) => io.stderr('[' + clock(Date.now() - started) + '] ' + nameOf(activity.ownerId) + ' · ' + activity.title + ' · ' + what + '\n');
    for (const activity of activities.values()) {
      const key = activity.activityId + ':' + activity.status;
      if (!seen.has(key)) {seen.add(key); line(activity, activity.status);}
    }
    for (const message of snapshot.messages) {
      const activity = message.activityId ? activities.get(message.activityId) : undefined, call = message.step?.call;
      if (!activity || message.kind !== 'tool' || !call || call.name.startsWith('_') || !message.step) continue;
      for (const state of ['running', 'failed'] as const) {
        const key = message.id + ':' + state;
        if (message.step.state === state && !seen.has(key)) {seen.add(key); line(activity, call.name + (state === 'failed' ? ' failed' : ''));}
      }
    }
  };
  const tick = () => {answerInteractions(); sawLogin(); progress();};
  const stopWatching = store.subscribe(tick);

  // Cancellation is the same as Esc: the Director first, then every companion activity still alive. Repeated until nothing is left.
  const cancelled = new Set<string>();
  const cancelAll = () => {
    const live = runActivities().filter(activity => LIVE.has(activity.status) && !cancelled.has(activity.activityId))
      .sort((a, b) => Number(b.ownerId === DIRECTOR_ID) - Number(a.ownerId === DIRECTOR_ID));
    for (const activity of live) {cancelled.add(activity.activityId); try {app.cancel(activity.activityId);} catch {/* already ending */}}
  };
  const interrupt = () => {if (cancelling) forced = true; interrupted = true; cancelling = true;};
  io.signals?.on('SIGINT', interrupt); io.signals?.on('SIGTERM', interrupt);
  const guard = args.timeoutMs === undefined ? undefined : setTimeout(() => {timedOut = true; cancelling = true;}, args.timeoutMs);

  const errors: string[] = [];
  // Background Automa jobs are part of the dispatcher's open work: the run does not settle before they ended and reached it.
  const settledNow = () => !runActivities().some(activity => LIVE.has(activity.status)) && !app.ensemble.isBusy() && !app.tools.background.open(session) &&
    !app.getInputQueue().queued.length && !app.getInputQueue().steering.length;
  try {
    try {await app.submit(task);}
    catch (error) {errors.push(error instanceof Error ? error.message : String(error)); cancelling = true;}
    let cancelStarted: number | undefined;
    for (;;) {
      tick();
      if (cancelling) {cancelStarted ??= Date.now(); cancelAll(); if (Date.now() - cancelStarted > CANCEL_GRACE_MS) forced = true;}
      if (forced) break;
      if (settledNow()) {
        const revision = store.getSnapshot().revision;
        await sleep(STABLE_MS);
        if (settledNow() && store.getSnapshot().revision === revision) break;
        continue;
      }
      await sleep(POLL_MS);
    }
    tick();
  } finally {
    if (guard) clearTimeout(guard);
    stopWatching();
    io.signals?.removeListener('SIGINT', interrupt); io.signals?.removeListener('SIGTERM', interrupt);
  }

  // Results.
  const snapshot = store.getSnapshot(), activities = runActivities(), ids = new Set(activities.map(activity => activity.activityId));
  const directors = activities.filter(activity => activity.ownerId === DIRECTOR_ID), lastDirector = directors.at(-1);
  const entries = (await app.journal.load(session, DIRECTOR_ID)).slice(baselineLength);
  const finalEntry = entries.findLast(entry => entry.role === 'assistant' && entry.message?.role === 'assistant' && !entry.message.contextExcluded &&
    !entry.message.memoryOnly && !entry.message.textToolCall && stripNarration(entry.text).trim());
  const final = finalEntry ? stripLeadingActionLines(finalEntry.text).trim() : '';
  for (const activity of activities) if (activity.status === 'failed') errors.push(nameOf(activity.ownerId) + ': ' + activity.detail);
  if (!lastDirector && !errors.length) errors.push('The task started no work.');
  if (activities.some(activity => activity.status === 'failed' && /not logged in|No model configured/i.test(activity.detail))) setupError ??= HEADLESS_NO_MODEL;
  if (lastDirector?.status === 'cancelled' && !interrupted && !timedOut) errors.push('The Director task was cancelled.');
  const status: HeadlessStatus = timedOut ? 'timeout' : interrupted ? 'cancelled' : lastDirector?.status === 'completed' ? 'completed' : 'failed';

  const toolMessages = snapshot.messages.filter((message: Message) => message.kind === 'tool' && message.step?.call && !message.step.call.name.startsWith('_') && message.activityId && ids.has(message.activityId));
  const actorStats: Record<string, {tasks: number; toolCalls: number}> = {};
  for (const activity of activities) (actorStats[activity.ownerId] ??= {tasks: 0, toolCalls: 0}).tasks++;
  for (const message of toolMessages) (actorStats[message.ownerId] ??= {tasks: 0, toolCalls: 0}).toolCalls++;
  const jobs = snapshot.messages.filter(message => message.activityId && ids.has(message.activityId)).flatMap(message => message.step?.swarm?.jobs ?? []);
  const used = records().filter(item => !baselineUsage.has(item.record.id));
  const group = (key: (item: typeof used[number]) => string) => {
    const groups = new Map<string, UsageRecord[]>();
    for (const item of used) groups.set(key(item), [...groups.get(key(item)) ?? [], item.record]);
    return Object.fromEntries([...groups].map(([name, list]) => [name, totalsOf(list, config)]));
  };
  // The delegation record of this run (the same projection `/tasks` reads): every companion activity and Automa job, with how it ended.
  const owners = [...new Set(activities.map(activity => activity.ownerId))];
  const ledgers = (await Promise.all(owners.map(owner => app.journal.load(session, owner).catch(() => [])))).flat().filter(entry => entry.activityId && ids.has(entry.activityId));
  const costs = activityCosts(ledgers);
  const delegations = projectDelegations({snapshot, sessionId: session, deliveries: app.ensemble.deliveries.snapshot()})
    .filter(node => node.kind === 'automa' ? node.parentId !== undefined && ids.has(node.parentId) : node.kind === 'actor' && ids.has(node.id))
    .map(node => ({id: node.kind === 'automa' ? node.jobId! : node.id, owner: node.ownerId, kind: node.kind as 'actor' | 'automa', parentId: node.parentId ?? null, title: node.title,
      status: node.status, stopReason: node.stopReason ?? null, durationMs: node.durationMs ?? null,
      costUsd: costs.has(node.id) ? Number(costs.get(node.id)!.toFixed(6)) : null,
      ...(node.route ? {route: node.route} : {}), ...(node.model ? {model: node.model} : {}),
      ...(node.background ? {background: true, delivered: node.delivered === true} : {}),
      blockedBy: [...node.blockedBy], result: node.result ? {summary: node.result.summary, notVerified: [...node.result.notVerified ?? []]} : null}));
  // The plans this run touched (changed during it, or holding work it started): derived, as the hub and `/plan` read them.
  const plans = app.plans.plans().filter(plan => plan.updatedAt >= started || plan.nodes.some(node => node.links.some(link => ids.has((link.activityId ?? link.automaJob ?? '').split('/')[0]!))));
  const cwd = await realpath(io.cwd).catch(() => io.cwd);
  const changedFiles = (await app.tools.snapshots.changedPaths([...ids]).catch(() => [])).map(path => {
    const inside = relative(cwd, path);
    return (inside && !inside.startsWith('..') && !isAbsolute(inside) ? inside : path).split(sep).join('/');
  });
  return {
    exit: setupError ? HEADLESS_EXIT.setup : status === 'completed' ? HEADLESS_EXIT.completed : status === 'failed' ? HEADLESS_EXIT.failed : HEADLESS_EXIT.interrupted,
    setupError, final,
    report: {version: 1 as const, sessionId: session, status, durationMs: Date.now() - started, final, actors: actorStats,
      delegations,
      plans,
      automa: {jobs: jobs.length, done: jobs.filter(job => job.state === 'done').length, blocked: jobs.filter(job => job.state === 'blocked').length, failed: jobs.filter(job => job.state === 'failed').length,
        ...(jobs.some(job => job.state === 'skipped') ? {skipped: jobs.filter(job => job.state === 'skipped').length} : {})},
      usage: {...totalsOf(used.map(item => item.record), config), byActor: group(item => item.owner), byCategory: group(item => item.record.category)},
      changedFiles, errors},
  };
}

function emit(outcome: Awaited<ReturnType<typeof drive>>, args: HeadlessArgs, io: HeadlessIo): number {
  if (outcome.setupError) {io.stderr(outcome.setupError + '\n'); return HEADLESS_EXIT.setup;}
  if (args.output === 'json') io.stdout(JSON.stringify(outcome.report) + '\n');
  else if (outcome.final) io.stdout(outcome.final + '\n');
  if (args.output === 'text' && outcome.report.errors.length) for (const error of outcome.report.errors) io.stderr('[Error] ' + error + '\n');
  return outcome.exit;
}
