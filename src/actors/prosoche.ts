// The prosoche: after a companion activity has worked a long time it looks, mechanically and without a model call, at what the activity did since
// the last check and asks the Director to take a look only when it seems stuck. It never stops, pauses or limits anything (natural loop).
import type {Activity, Message, RuntimeSnapshot} from '../runtime/contracts.js';
import {isDirector} from '../runtime/director-id.js';
import {prosocheNotice} from '../prompts/runtime/director.js';

const MINUTE = 60_000;
const REPEATED_ERROR = 3;
const DUPLICATE_WINDOW = 20;
const DUPLICATE_MIN_CALLS = 10;
const DUPLICATE_SHARE = 0.6;
const READ_ONLY_CALLS = 30;
const DISTINCT_TARGETS = 5;
const RECENT_CALLS = 5;
const TICK_MS = 30_000;

export type WorkState = 'working' | 'waiting' | 'idle';
/** The work time of one activity: `workMs` counted up to `at`, with `state` holding from then on. */
export interface WorkClock {readonly at: number; readonly state: WorkState; readonly workMs: number}

/** Whether the activity is working, waiting on the human or another actor (`parked`), or not running at all. */
export function workStateOf(activity: Pick<Activity, 'status' | 'phase'>, parked: boolean): WorkState {
  if (activity.status === 'waiting_input' || activity.phase === 'approval' || activity.phase === 'question' || parked && activity.status === 'running') return 'waiting';
  return activity.status === 'running' ? 'working' : 'idle';
}
/** Moves the clock to `now`: the time since its last sample counts as work only while it was working. `next` is the state from `now` on. */
export function advanceWork(clock: WorkClock, now: number, next: WorkState): WorkClock {
  const elapsed = Math.max(0, now - clock.at);
  return {at: Math.max(now, clock.at), state: next, workMs: clock.workMs + (clock.state === 'working' ? elapsed : 0)};
}
/** The work time of the first check: the configured minutes, or the task's expected duration when that is longer. Each next check is at twice the previous. */
export function firstCheckMs(checkMinutes: number, expectMinutes?: number): number {
  return Math.max(checkMinutes, expectMinutes ?? 0) * MINUTE;
}

/** One finished tool call of an activity, reduced to what the check reads. */
export interface CallRecord {readonly tool: string; readonly target: string; readonly failed: boolean; readonly error: string; readonly file?: string}

const TARGET_KEYS = ['file_path', 'path', 'command', 'pattern', 'url', 'query', 'to', 'id', 'name', 'prompt'];
function mainArgument(args: Record<string, unknown>): string {
  for (const key of TARGET_KEYS) if (typeof args[key] === 'string' && args[key]) return args[key] as string;
  return JSON.stringify(args);
}
/** Text with the parts that differ between repeats of the same problem collapsed: paths, hex ids, numbers and spacing. */
export function normalise(text: string): string {
  return text.toLowerCase()
    .replace(/(?:[a-z]:)?[\\/][^\s"'`:()]+/g, '<path>').replace(/\b[0-9a-f]{7,}\b/g, '<hex>').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 160);
}
/** The finished tool calls of one activity, in order, read from the store's tool messages. */
export function callsOf(messages: readonly Message[], activityId: string): CallRecord[] {
  const calls: CallRecord[] = [];
  for (const message of messages) {
    const step = message.step;
    if (message.kind !== 'tool' || message.activityId !== activityId || !step?.call || (step.state !== 'completed' && step.state !== 'failed')) continue;
    let args: Record<string, unknown> = {};
    try {const parsed: unknown = JSON.parse(step.call.arguments); if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>;} catch {}
    const tool = step.call.name, result = message.text.startsWith(tool + '\n') ? message.text.slice(tool.length + 1) : message.text;
    const exit = tool === 'Shell' ? /^Exit code:\s*(-?\d+)/im.exec(result)?.[1] : undefined;
    const failed = step.state === 'failed' || exit !== undefined && exit !== '0';
    const file = (tool === 'Write' || tool === 'Edit') && !failed && typeof args.file_path === 'string' ? args.file_path : undefined;
    calls.push({tool, target: mainArgument(args), failed, error: failed ? normalise(result.split('\n').find(line => line.trim()) ?? 'failed') : '', ...(file ? {file} : {})});
  }
  return calls;
}

export interface CheckInput {
  /** Calls the activity made since the previous check. */
  readonly window: readonly CallRecord[];
  /** Calls it made before that (what counts as an already-read file). */
  readonly before: readonly CallRecord[];
  /** Files its foreground Shell commands changed since the previous check. */
  readonly shellFiles: readonly string[];
  /** Ids of background jobs it started that still run. */
  readonly jobs: readonly string[];
}
export interface CheckResult {
  readonly verdict: 'progressing' | 'suspect';
  readonly calls: number;
  readonly files: number;
  readonly signals: readonly string[];
  readonly recent: readonly string[];
}
const keyOf = (call: CallRecord) => call.tool + ' ' + normalise(call.target);
const oneLine = (call: CallRecord) => (call.tool + ' ' + call.target).replace(/\s+/g, ' ').trim().slice(0, 80) + (call.failed ? ' (failed)' : '');

/** The mechanical classification: progress signals (files changed, plan updates, varied targets) against loop signals (repeated errors, near-duplicate calls, reading without writing). */
export function checkActivity(input: CheckInput): CheckResult {
  const {window, before} = input;
  const files = new Set([...window.flatMap(call => call.file ? [call.file] : []), ...input.shellFiles]).size;
  const planUpdates = window.filter(call => call.tool === 'Plan' && !call.failed).length;
  const targets = new Set(window.map(keyOf)).size;
  const progress = files > 0 || planUpdates > 0 || targets >= DISTINCT_TARGETS;
  const loops: string[] = [];
  const errors = new Map<string, number>();
  for (const call of window) if (call.failed) errors.set(call.error, (errors.get(call.error) ?? 0) + 1);
  const [error, repeats] = [...errors].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
  if (repeats >= REPEATED_ERROR) loops.push(`the same error ${repeats} times ("${error.slice(0, 60)}")`);
  const last = window.slice(-DUPLICATE_WINDOW), counts = new Map<string, number>();
  for (const call of last) counts.set(keyOf(call), (counts.get(keyOf(call)) ?? 0) + 1);
  const duplicates = last.filter(call => counts.get(keyOf(call))! > 1).length;
  if (last.length >= DUPLICATE_MIN_CALLS && duplicates / last.length >= DUPLICATE_SHARE) loops.push(`${duplicates} of its last ${last.length} calls are near-duplicates`);
  const read = new Set(before.filter(call => call.tool === 'Read').map(call => normalise(call.target)));
  const newReads = new Set(window.filter(call => call.tool === 'Read' && !read.has(normalise(call.target))).map(call => normalise(call.target))).size;
  if (window.length >= READ_ONLY_CALLS && !files && !newReads) loops.push(`${window.length} calls with no file written and no new file read`);
  const verdict = progress && !loops.length ? 'progressing' : 'suspect';
  const signals = [...loops, ...(!progress ? ['no progress signal'] : []), ...(input.jobs.length ? [`background job ${input.jobs.join(', ')} still running`] : [])];
  return {verdict, calls: window.length, files, signals, recent: window.slice(-RECENT_CALLS).map(oneLine)};
}

export function formatMinutes(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / MINUTE));
  return minutes >= 60 ? Math.floor(minutes / 60) + 'h' + (minutes % 60 ? ' ' + (minutes % 60) + 'm' : '') : minutes + 'm';
}

export interface ProsocheDeps {
  readonly store: {getSnapshot(): RuntimeSnapshot; subscribe(listener: () => void): () => void};
  readonly sessionId: string;
  /** `[kernel] check_after_minutes`, read on every evaluation (0 never). */
  minutes(): number;
  /** The actor waits on another actor's reply (`AskBoard.isParked`). */
  parked(ownerId: string): boolean;
  /** Ids of the background jobs this actor started that still run. */
  jobs(ownerId: string): readonly string[];
  /** Files the activity's foreground Shell commands changed so far. */
  shellFiles(activityId: string): readonly string[];
  nameOf(ownerId: string): string;
  /** True while an earlier prosoche notice about this activity still waits for the Director. */
  pending(activityId: string): boolean;
  notify(text: string, source: string): Promise<void>;
  now?: () => number;
  tickMs?: number;
}
interface Watched {clock: WorkClock; threshold: number; seen: number; shell: Set<string>}

/** One service per session: samples every companion activity on store changes and on a coarse tick, and looks at one when its work time reaches its next check. */
export class Prosoche {
  private readonly watched = new Map<string, Watched>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsubscribe: (() => void) | undefined;
  private readonly now: () => number;
  constructor(private readonly deps: ProsocheDeps) {this.now = deps.now ?? Date.now;}
  start(): void {
    if (this.timer) return;
    this.unsubscribe = this.deps.store.subscribe(() => this.evaluate());
    this.timer = setInterval(() => this.evaluate(), this.deps.tickMs ?? TICK_MS);
    this.timer.unref?.();
  }
  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined; this.unsubscribe?.(); this.unsubscribe = undefined; this.watched.clear();
  }
  /** Samples all companion activities once; a check that falls due is made now. Never throws. */
  evaluate(): void {
    try {this.sample();} catch {}
  }
  /** The work time counted so far (undefined for an activity that is not watched). */
  workMs(activityId: string): number | undefined { return this.watched.get(activityId)?.clock.workMs; }
  private sample(): void {
    const checkMinutes = this.deps.minutes();
    if (!(checkMinutes > 0)) {this.watched.clear(); return;}
    const snapshot = this.deps.store.getSnapshot(), now = this.now(), live = new Set<string>();
    for (const activity of snapshot.activities) {
      if (activity.sessionId !== this.deps.sessionId || activity.kind !== 'actor' || isDirector(activity.ownerId)) continue;
      if (activity.status === 'completed' || activity.status === 'failed' || activity.status === 'cancelled') continue;
      live.add(activity.activityId);
      const state = workStateOf(activity, this.deps.parked(activity.ownerId));
      const known = this.watched.get(activity.activityId);
      const entry = known ?? {clock: {at: now, state, workMs: 0}, threshold: firstCheckMs(checkMinutes, activity.expectMinutes), seen: 0, shell: new Set<string>()};
      if (!known) this.watched.set(activity.activityId, entry);
      entry.clock = advanceWork(entry.clock, now, state);
      if (entry.clock.workMs >= entry.threshold) this.check(activity, entry, snapshot);
    }
    for (const id of [...this.watched.keys()]) if (!live.has(id)) this.watched.delete(id);
  }
  private check(activity: Activity, entry: Watched, snapshot: RuntimeSnapshot): void {
    const calls = callsOf(snapshot.messages, activity.activityId);
    const shellAll = this.deps.shellFiles(activity.activityId), shellFiles = shellAll.filter(path => !entry.shell.has(path));
    const result = checkActivity({window: calls.slice(entry.seen), before: calls.slice(0, entry.seen), shellFiles, jobs: this.deps.jobs(activity.ownerId)});
    entry.seen = calls.length; entry.shell = new Set(shellAll); entry.threshold *= 2;
    if (result.verdict === 'progressing' || this.deps.pending(activity.activityId)) return;
    const text = prosocheNotice({name: this.deps.nameOf(activity.ownerId), worked: formatMinutes(entry.clock.workMs), title: activity.taskTitle ?? activity.title,
      activityId: activity.activityId, calls: result.calls, files: result.files ? result.files + (result.files === 1 ? ' file' : ' files') + ' changed' : 'no files changed',
      signals: result.signals.join('; ') || 'no signal', recent: result.recent.join(' | ') || 'none', next: formatMinutes(entry.threshold - entry.clock.workMs)});
    void this.deps.notify(text, activity.ownerId).catch(() => {});
  }
}
