/**
 * `/tasks`: the delegation record as a read-only page. A list of every delegation of the session (the current root's tree first, earlier roots below it;
 * one row per Director round, companion activity or Automa job) opens a detail page for the selected row. It is a stack of the existing surfaces like
 * `/anamnesis`: a picker (so keyboard, click, hover and wheel behave as on every list), a page for the detail and the same Esc-back. Nothing here owns state:
 * rows are projected from the runtime snapshot (`src/runtime/delegations.ts`) each time a level opens.
 */
import type {PickerItem, TabRow} from '../runtime/command-surface.js';
import type {RuntimeStore} from '../runtime/store.js';
import {delegationRows, projectDelegations, type Delegation} from '../runtime/delegations.js';
import {readFile} from 'node:fs/promises';
import {row, tabContent} from './tab-rows.js';
import type {CommandSurfaces, PageActions} from './surfaces.js';

export const TASKS_EMPTY_TEXT = 'Nothing has been delegated in this session yet. Companion tasks and Automa jobs appear here as the Director dispatches them.';
export const TASKS_USAGE = 'Usage: /tasks';

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
  return [node.status + stopped, node.waiting?.text, node.durationMs !== undefined ? formatDuration(node.durationMs) : undefined, cost !== undefined ? money(cost) : undefined, deliveryText(node)].filter(Boolean).join(' · ');
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
  const open = async (...args: Parameters<CommandSurfaces['openPicker']>) => {
    if (surfaces.getSnapshot()) surfaces.close();
    await surfaces.openPicker(...args);
  };
  const project = () => projectDelegations({snapshot: store.getSnapshot(), sessionId: session, deliveries: deliveries()});

  const openDetail = async (node: Delegation, cost: number | undefined, backTo: () => Promise<void>) => {
    const result = node.result;
    const body: TabRow[] = [
      row.heading('Assignment'),
      row.field('Owner', node.kind === 'automa' ? 'Automa worker of ' + name(node.ownerId) : name(node.ownerId)),
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
      ...(node.jobId ? [row.field('Worker', node.jobId + (node.route ? ' · ' + node.route + ' route' : '') + (node.model ? ' · ' + node.model : ''))] : []),
      ...(node.batchId ? [row.field('Batch', node.batchId)] : []),
      ...(node.parentId ? [row.field('Parent', node.parentId)] : []),
      ...(result ? [row.blank(), row.heading('Result'), row.field('Summary', result.summary || '(none recorded)'),
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

  const openList = async (focus?: string): Promise<void> => {
    const priced = await costs().catch(() => new Map<string, number>());
    const rows = delegationRows(project());
    const items: PickerItem[] = rows.map(({node, depth}) => ({id: node.id,
      label: '  '.repeat(depth) + (node.kind === 'automa' ? node.jobId + ' · ' : name(node.ownerId) + ' · ') + node.assignment.title,
      description: statusText(node, priced.get(node.id))}));
    await open({title: 'Tasks', description: items.length ? 'Enter opens a row · Esc closes' : '', current: '', ...(focus ? {focus} : {}), items, emptyText: TASKS_EMPTY_TEXT},
      async () => ({items}), async id => {
        const node = project().find(item => item.id === id);
        if (!node) throw new Error('That task no longer exists.');
        await openDetail(node, priced.get(id), async () => {await openList(id);});
        return {};
      });
  };

  return {
    /** `/tasks` opens the page; arguments are not accepted. */
    async command(argument: string): Promise<void> {
      if (argument.trim()) throw new Error(TASKS_USAGE);
      await openList();
    },
    openList,
    /** Opens the detail page of one delegation (an activity id, or `<activityId>/<jobId>`), Esc returning through `backTo`; false when the session does not know it. */
    async openDelegation(id: string, backTo: () => Promise<void>): Promise<boolean> {
      const node = project().find(item => item.id === id);
      if (!node) return false;
      await openDetail(node, (await costs().catch(() => new Map<string, number>())).get(id), backTo);
      return true;
    },
    /** The title of one delegation, for links from other pages. */
    titleOf(id: string): string | undefined {
      const node = project().find(item => item.id === id);
      return node ? (node.kind === 'automa' ? (node.jobId ?? 'job') + ' · ' : name(node.ownerId) + ' · ') + node.assignment.title : undefined;
    },
  };
}
export type TasksCommand = ReturnType<typeof createTasksCommand>;
