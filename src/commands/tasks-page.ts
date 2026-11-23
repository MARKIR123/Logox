/**
 * `/team` shows the sidebar on its Team tab (the team event stream, `src/runtime/team-events.ts`) and registers `CommandSurfaces.teamPostOpener`, what a team post opens
 * (the delegation detail for work, the full text as Markdown for a message).
 *
 * `/tasks`: shows or hides the task flowchart sidebar (`/tasks sidebar [show|hide|toggle]`, the same as Ctrl+B), `/tasks plans` opens the plan switcher
 * (`src/commands/plan-page.ts`). The sidebar draws the session's task graph (the plan with the work nobody linked to it, or the work alone: `src/runtime/task-graph.ts`),
 * else the latest plan of an earlier session; this file owns what a work-graph node opens: the read-only detail page of a delegation (Assignment, Status and
 * Result, with the footer actions `o` and `t`), reached by `CommandSurfaces.openWorkNode()` and by the links of a plan node's page. Nothing here owns state:
 * the detail is projected from the runtime snapshot (`src/runtime/delegations.ts`) each time it opens.
 */
import type {TabRow} from '../runtime/command-surface.js';
import type {RuntimeStore} from '../runtime/store.js';
import {projectDelegations, type Delegation} from '../runtime/delegations.js';
import {foldAttempts, taskGraph} from '../runtime/task-graph.js';
import type {TeamEvent} from '../runtime/team-events.js';
import type {ActorDetail} from '../runtime/team-stage.js';
import {readFile} from 'node:fs/promises';
import {row, tabContent} from './tab-rows.js';
import type {CommandSurfaces, PageActions, PlanSidebarMode} from './surfaces.js';

export const TASKS_USAGE = 'Usage: /tasks [plans | sidebar [show|hide|toggle]]';
export const TASKS_NO_TERMINAL = 'The task sidebar needs the terminal UI.';
export const TEAM_USAGE = 'Usage: /team [sidebar] [show|hide|toggle]';
export const TEAM_NO_TERMINAL = 'The team sidebar needs the terminal UI.';

export interface TasksPageDeps {
  surfaces: CommandSurfaces;
  store: Pick<RuntimeStore, 'getSnapshot'>;
  session: string;
  actors: {find(id: string): {name: string} | undefined};
  deliveries(): readonly {readonly id: string; readonly sourceActivityId?: string | undefined; readonly kind: string}[];
  /** Priced cost (USD) per activity, from the ledgers; empty when nothing is priced. */
  costs(): Promise<ReadonlyMap<string, number>>;
  /** The file Automa workers journal to, when there is one. */
  journalPath(): string | undefined;
}

/** `45s`, `2m 13s`, `1h 05m`. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return total + 's';
  const minutes = Math.floor(total / 60);
  return minutes < 60 ? minutes + 'm ' + String(total % 60).padStart(2, '0') + 's' : Math.floor(minutes / 60) + 'h ' + String(minutes % 60).padStart(2, '0') + 'm';
}
const money = (usd: number) => '$' + (usd >= 1 ? usd.toFixed(2) : usd.toFixed(4));

/** The status words of a row: the status with its stop reason once settled (an ordinary completion needs none), what it waits on, how long it ran, what it cost. */
export function statusText(node: Delegation, cost: number | undefined): string {
  const stopped = node.stopReason && node.stopReason !== 'completed' ? ' (stop: ' + node.stopReason + ')' : '';
  return [node.fork ? 'kind: fork' : undefined, node.status + stopped, node.waiting?.text, node.durationMs !== undefined ? formatDuration(node.durationMs) : undefined, cost !== undefined ? money(cost) : undefined, deliveryText(node)].filter(Boolean).join(' · ');
}

/** A background Automa job: in the background while it works, then whether its result has reached the dispatcher. */
function deliveryText(node: Delegation): string | undefined {
  if (!node.background) return undefined;
  return node.delivered ? 'delivered' : node.result ? 'not delivered yet' : 'background';
}

/**
 * The events of one Automa job in the worker journal (`subagents/automa.jsonl`, one JSON object per line): from the `start` event that names it to its `end`,
 * rendered as readable lines. A job index repeats across dispatches of one activity, so the `start` event with the job's readable id selects the run.
 */
export function workerTranscript(raw: string, activityId: string, jobId: string): string[] {
  const lines: string[] = [];
  let index: number | undefined;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry: Record<string, any>;
    try {entry = JSON.parse(line) as Record<string, any>;} catch {continue;}
    if (entry.parentActivityId !== activityId) continue;
    if (entry.event === 'start') {
      index = entry.id === jobId ? entry.jobIndex as number : undefined;
      if (index !== undefined) {lines.length = 0; lines.push('Brief: ' + String(entry.brief ?? '').trim());}
      continue;
    }
    if (index === undefined || entry.jobIndex !== index) continue;
    if (entry.event === 'message') {
      const message = entry.message as {text?: string; toolCalls?: {name: string; arguments: string}[]} | undefined;
      if (message?.text?.trim()) lines.push('Worker: ' + message.text.trim());
      for (const call of message?.toolCalls ?? []) lines.push('Call: ' + call.name + ' ' + call.arguments.slice(0, 300));
    } else if (entry.event === 'tool') {
      lines.push((entry.isError ? 'Result (error): ' : 'Result: ') + String(entry.text ?? '').trim().slice(0, 600));
    } else if (entry.event === 'end') {
      lines.push('Ended: ' + String(entry.status ?? entry.state ?? ''));
      index = undefined;
    }
  }
  return lines;
}

export function createTasksCommand(deps: TasksPageDeps) {
  const {surfaces, store, session, actors, deliveries, costs, journalPath} = deps;
  const name = (ownerId: string) => actors.find(ownerId)?.name ?? ownerId;
  const project = () => projectDelegations({snapshot: store.getSnapshot(), sessionId: session, deliveries: deliveries()});

  const openDetail = async (node: Delegation, cost: number | undefined, backTo: () => Promise<void>) => {
    // The earlier attempts folded into this one (the sidebar draws them as one node), oldest first.
    const all = project(), folded = foldAttempts(all), earlier = all.filter(item => folded.get(item.id) === node.id);
    const result = node.result;
    const body: TabRow[] = [
      row.heading('Assignment'),
      row.field('Owner', node.kind === 'automa' ? (node.fork ? 'Fork of ' : 'Automa worker of ') + name(node.ownerId) : name(node.ownerId)),
      ...(node.fork ? [row.field('Kind', 'fork')] : []),
      row.field('Title', node.assignment.title),
      ...(node.assignment.owns.length ? [row.field('Owns', node.assignment.owns.join(', '))] : []),
      ...(node.assignment.acceptance.length ? [row.text('Acceptance:'), ...node.assignment.acceptance.map(item => row.bullet(item))] : []),
      row.blank(), row.heading('Status'),
      row.field('Status', node.status),
      ...(node.stopReason ? [row.field('Stop reason', node.stopReason)] : []),
      ...(node.diagnostic ? [row.field('Diagnostic', node.diagnostic)] : []),
      ...(node.waiting ? [row.field('Waiting on', node.waiting.text)] : []),
      ...(node.blockedBy.length ? [row.field('Blocked by', node.blockedBy.map(id => {const other = project().find(item => item.id === id); return other ? name(other.ownerId) + ' · ' + other.title : id;}).join('; '))] : []),
      ...(deliveryText(node) ? [row.field('Mode', 'background · ' + (node.delivered ? 'result delivered' : node.result ? 'result not delivered yet' : 'result pending'))] : []),
      ...(node.durationMs !== undefined ? [row.field('Duration', formatDuration(node.durationMs))] : []),
      ...(cost !== undefined ? [row.field('Cost', money(cost))] : []),
      ...(node.jobId ? [row.field('Worker', node.jobId + (node.workerName ? ' · ' + node.workerName : '') + (node.route ? ' · ' + node.route + ' route' : '') + (node.model ? ' · ' + node.model : ''))] : []),
      ...(node.batchId ? [row.field('Batch', node.batchId)] : []),
      ...(node.parentId ? [row.field('Parent', all.find(item => item.id === node.parentId)?.title ?? 'an earlier task')] : []),
      ...(earlier.length ? [row.blank(), row.heading('Earlier attempts'), ...earlier.map(item => row.bullet(name(item.ownerId) + ' · ' + item.status + (item.stopReason && item.stopReason !== 'completed' ? ' (stop: ' + item.stopReason + ')' : '') +
        (item.durationMs !== undefined ? ' · ' + formatDuration(item.durationMs) : '') + (item.result?.summary ? ' · ' + item.result.summary.slice(0, 160) : '')))] : []),
      ...(result ? [row.blank(), row.heading('Result'), row.field('Summary', result.summary || '(the task left no text)'),
        ...(result.evidence?.length ? [row.text('Evidence:'), ...result.evidence.map(item => row.bullet(item))] : []),
        ...(result.notVerified?.length ? [row.text('Not verified:'), ...result.notVerified.map(item => row.bullet(item))] : []),
        ...(result.question ? [row.field('Question', result.question)] : []),
        ...(result.finishedAt !== undefined ? [row.field('Finished', new Date(result.finishedAt).toLocaleTimeString())] : []),
        row.field('Full report', result.reportRef, 'muted')] : [])];
    const actions: PageActions = {
      onSaveToggles: () => ({}),
      onBack: backTo,
      onTabAction: async (_tab, action) => {
        if (action === 'open' && node.kind === 'actor') {surfaces.requestWindow(node.ownerId); return {close: true};}
        if (action === 'transcript' && node.kind === 'automa' && node.jobId) {
          const path = journalPath();
          const lines = path ? workerTranscript(await readFile(path, 'utf8').catch(() => ''), node.parentId ?? '', node.jobId) : [];
          surfaces.close();
          surfaces.openResult('Worker ' + node.jobId + ' · ' + node.title, lines.length ? lines.join('\n') : 'No transcript was recorded for this worker.');
          return {};
        }
        return {};
      },
    };
    if (surfaces.getSnapshot()) surfaces.close();
    surfaces.openPage('Delegation · ' + node.title, [{id: 'detail', title: node.kind === 'automa' ? 'Worker ' + (node.jobId ?? '') : name(node.ownerId), ...tabContent(body),
      ...(node.kind === 'actor' ? {actions: [{id: 'open', label: 'Open conversation', key: 'o'}]} : node.kind === 'automa' && node.jobId ? {actions: [{id: 'transcript', label: 'Worker transcript', key: 't'}]} : {})}], 'detail', actions);
  };

  const openDelegation = async (id: string, backTo: () => Promise<void>): Promise<boolean> => {
    const node = project().find(item => item.id === id);
    if (!node) return false;
    await openDetail(node, (await costs().catch(() => new Map<string, number>())).get(id), backTo);
    return true;
  };
  surfaces.workNodeOpener = id => openDelegation(id, async () => {});

  /**
   * The detail page of a team post: work (an assignment, report, wait, workers, a worker's result) opens the delegation detail; a message or the person's own text opens
   * its full text as Markdown under a one-line header. Esc closes either.
   */
  const openTeamPost = async (event: TeamEvent): Promise<boolean> => {
    const who = (id: string) => id === 'user' ? 'you' : id === 'automa' ? 'worker ' + (event.worker ?? '') + (event.workerName ? ' · ' + event.workerName : '') : name(id).toLowerCase();
    if (event.kind !== 'message' && event.kind !== 'user' || !event.detail) {
      if (await openDelegation(event.ref, async () => {})) return true;
    }
    const head = `**${who(event.from)}** → ${event.to.length ? event.to.map(id => '**' + who(id) + '**').join(', ') : 'the team'} · ${new Date(event.at).toLocaleTimeString()}`;
    const body = event.detail ?? event.text;
    if (surfaces.getSnapshot()) surfaces.close();
    surfaces.openResult('Team · ' + (event.title ?? event.kind), [head, event.title ? '*' + event.title + '*' : '', body].filter(Boolean).join('\n\n'), undefined, undefined, true);
    return true;
  };
  surfaces.teamPostOpener = openTeamPost;

  /**
   * The detail page of a team actor (a double click on its stage card, Enter on a selected one): its state, the task it was last given, the workers it dispatched
   * (name, title, status, duration), its recent messages in and out with the count per peer, and the footer action `o` that jumps to its own window. A snapshot of the
   * replay point the stage was showing.
   */
  const openTeamActor = async (detail: ActorDetail): Promise<boolean> => {
    const who = (id: string) => id === 'user' ? 'you' : id === 'automa' ? 'worker' : name(id).toLowerCase();
    const body: TabRow[] = [
      row.heading('State'),
      row.field('State', detail.state),
      ...(detail.task ? [row.field('Task', detail.task)] : []),
      row.blank(), row.heading('Workers'),
      ...(detail.jobs.length ? detail.jobs.map(job => row.bullet((job.fork ? '⑂ ' : '◦ ') + job.name + (job.name !== job.title ? ' · ' + job.title : '') + ' · ' + job.status +
        (job.ms !== undefined ? ' · ' + formatDuration(job.ms) : ''))) : [row.text('No workers dispatched.')]),
      row.blank(), row.heading('Messages'),
      ...(detail.peers.length ? detail.peers.map(peer => row.bullet(who(peer.peer) + ' · sent ' + peer.sent + ' · received ' + peer.received)) : [row.text('No messages yet.')]),
      ...(detail.messages.length ? [row.blank(), row.heading('Recent'), ...detail.messages.map(item => row.bullet(new Date(item.at).toLocaleTimeString() + ' · ' + (item.direction === 'in' ? 'from ' : 'to ') +
        who(item.peer) + ' · ' + item.kind + ' · ' + item.text.slice(0, 160)))] : []),
    ];
    const actions: PageActions = {
      onSaveToggles: () => ({}),
      onTabAction: async (_tab, action) => {
        if (action === 'open') {surfaces.requestWindow(detail.id); return {close: true};}
        return {};
      },
    };
    if (surfaces.getSnapshot()) surfaces.close();
    surfaces.openPage('Team · ' + name(detail.id), [{id: 'detail', title: name(detail.id), ...tabContent(body), actions: [{id: 'open', label: 'Open conversation', key: 'o'}]}], 'detail', actions);
    return true;
  };
  surfaces.teamActorOpener = openTeamActor;

  return {
    /** `/tasks` toggles the sidebar; `/tasks sidebar show|hide|toggle` sets it; `/tasks plans` opens the plan switcher; other arguments are not accepted. */
    async command(argument: string): Promise<void> {
      const text = argument.trim();
      const sidebar = /^sidebar(?:\s+(show|hide|toggle))?$/i.exec(text);
      if (text === '' || sidebar) {
        if (!surfaces.requestPlanSidebar((sidebar?.[1]?.toLowerCase() ?? 'toggle') as PlanSidebarMode, 'tasks')) throw new Error(TASKS_NO_TERMINAL);
        return;
      }
      if (/^plans$/i.test(text)) {await surfaces.plansOpener?.(); return;}
      throw new Error(TASKS_USAGE);
    },
    /** `/team` shows the sidebar on the Team tab (a second `/team` on it hides the sidebar); `/team [sidebar] show|hide|toggle` sets it. */
    async team(argument: string): Promise<void> {
      const match = /^(?:sidebar\s*)?(show|hide|toggle)?$/i.exec(argument.trim());
      if (!match) throw new Error(TEAM_USAGE);
      if (!surfaces.requestPlanSidebar((match[1]?.toLowerCase() ?? 'toggle') as PlanSidebarMode, 'team')) throw new Error(TEAM_NO_TERMINAL);
    },
    /** Opens the detail page of one delegation (an activity id, or `<activityId>/<jobId>`), Esc returning through `backTo`; false when the session does not know it. */
    openDelegation,
    /** Whether the session has delegated work the sidebar can draw as the work graph. */
    hasWork(): boolean {return taskGraph(undefined, project(), session) !== undefined;},
    /** The title of one delegation, for links from other pages. */
    titleOf(id: string): string | undefined {
      const node = project().find(item => item.id === id);
      return node ? (node.kind === 'automa' ? (node.jobId ?? 'job') + (node.workerName ? ' · ' + node.workerName : '') + ' · ' : name(node.ownerId) + ' · ') + node.assignment.title : undefined;
    },
  };
}
export type TasksCommand = ReturnType<typeof createTasksCommand>;
