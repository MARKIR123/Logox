import {existsSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {structuredPatch} from 'diff';
import type {Message} from '../../runtime/contracts.js';
import type {ToolRenderContext, ToolUI} from '../ui-types.js';
import {messageToolCall} from '../../tui/timeline/tool-ui.js';
import {cardTitle, diffSummary, failureView, renderToolCard, resultText, type ToolLine, type ToolView} from '../../tui/timeline/tool-card.js';
import {diffLines, type DiffStats} from '../../tui/timeline/tool-code.js';
import {callArgs, formatToolCardTitle} from '../ui-format.js';
import {writeDiff} from '../WriteTool/UI.js';
import {palette} from '../../tui/appearance/theme.js';
import {faintColor} from '../../tui/appearance/colors.js';

/** The edit as a unified patch with real file line numbers: located on disk when the file still holds the new text, otherwise numbered from the snippet. */
function editPatch(path: string, oldText: string, newText: string): {hunks: ReturnType<typeof structuredPatch>['hunks']; offset: number} {
  const name = path || 'file';
  let patch = structuredPatch(name, name, oldText, newText, '', '', {context: 3});
  let offset = 0;
  const resolved = path ? (existsSync(path) ? path : existsSync(resolve(process.cwd(), path)) ? resolve(process.cwd(), path) : undefined) : undefined;
  if (resolved) {
    try {
      const file = readFileSync(resolved, 'utf8').replace(/\r\n/g, '\n');
      const next = newText.replace(/\r\n/g, '\n'), previous = oldText.replace(/\r\n/g, '\n');
      let at = next ? file.indexOf(next) : -1;
      const byNew = at >= 0;
      if (at < 0 && previous) at = file.indexOf(previous);
      if (at >= 0) {
        const before = file.slice(0, at).split('\n');
        const contextBefore = before.slice(Math.max(0, before.length - 4), before.length - 1);
        const after = file.slice(at + (byNew ? next.length : previous.length)).split('\n').slice(1, 4);
        const head = contextBefore.length ? contextBefore.join('\n') + '\n' : '', tail = after.length ? '\n' + after.join('\n') : '';
        const wide = structuredPatch(name, name, head + previous + tail, head + next + tail, '', '', {context: 3});
        if (wide.hunks.length) {patch = wide; offset = Math.max(1, before.length - contextBefore.length) - 1;}
      }
    } catch {}
  }
  return {hunks: patch.hunks, offset};
}

function editDiff(args: Record<string, unknown>): {lines: ToolLine[]; stats: DiffStats} {
  const path = String(args.file_path ?? args.path ?? '');
  const oldText = typeof args.old_string === 'string' ? args.old_string : typeof args.old_text === 'string' ? args.old_text : '';
  const newText = typeof args.new_string === 'string' ? args.new_string : typeof args.new_text === 'string' ? args.new_text : '';
  const {hunks, offset} = editPatch(path, oldText, newText);
  return diffLines(hunks, offset);
}

/** Edit card view: numbered diff hunks separated by `⋯`, `added 3 · removed 1`. */
export function editView(args: Record<string, unknown>): ToolView {
  const {lines, stats} = editDiff(args);
  return {
    summary: diffSummary(stats),
    body: {lines, empty: 'No changes'},
  };
}

/** The file an Edit (or a Write that overwrote a known file, so it has a diff) changes; only these calls can fold into one row. */
export function mergeableEditPath(message: Message): string | undefined {
  if (message.kind !== 'tool') return undefined;
  const call = messageToolCall(message);
  const name = call?.name.toLowerCase();
  if (!call || (name !== 'edit' && name !== 'write')) return undefined;
  const args = callArgs(call);
  const path = String(args.file_path ?? args.path ?? '');
  if (!path) return undefined;
  if (name === 'write' && !writeDiff(args)) return undefined;
  return path;
}

/**
 * Consecutive edits of one file as one card: `Edit(animation.css) ×4 · added 4 · removed 4 · 0.4s`. Counts and time are summed, the mark is red when
 * any call failed (with the failed call's reason); expanded, the body is every edit's hunks in order with a `⋯` between edits, behind the one expander.
 */
export function renderEditRun(context: Omit<ToolRenderContext, 'call'>, run: readonly Message[]): void {
  const first = run[0]!;
  const call = messageToolCall(first);
  if (!call) return;
  const calls = run.map(item => messageToolCall(item));
  const states = run.map(item => item.step?.state);
  const failedAt = run.findIndex(item => item.step?.state === 'failed' || item.step?.state === 'cancelled' || Boolean(item.step?.disposition));
  const running = states.some(state => state === 'running' || state === 'waiting' || state === 'queued');
  const state = running ? 'running' : failedAt >= 0 ? run[failedAt]!.step!.state : 'completed';
  const runningSince = Math.min(...run.map(item => item.step?.state === 'running' ? item.step.runningSince ?? Infinity : Infinity));
  const step = {...first.step!, state, elapsedMs: run.reduce((sum, item) => sum + (item.step?.elapsedMs ?? 0), 0),
    ...(Number.isFinite(runningSince) ? {runningSince} : {}), ...(failedAt >= 0 ? {disposition: run[failedAt]!.step!.disposition} : {})} as NonNullable<Message['step']>;
  if (!Number.isFinite(runningSince)) delete (step as {runningSince?: number}).runningSince;
  const merged: Message = {...first, step, ...(failedAt >= 0 ? {text: run[failedAt]!.text} : {})};
  const args = calls.map(item => item ? callArgs(item) : {});
  renderToolCard({...context, message: merged, call}, {title: cardTitle({...context, message: first, call}, call) + ` ×${run.length}`, handlesFailure: true, view: () => {
    const lines: ToolLine[] = [];
    const stats = {added: 0, removed: 0};
    run.forEach((item, index) => {
      if (item.step?.state === 'failed' || item.step?.state === 'cancelled' || item.step?.disposition) return;
      const part = calls[index]!.name.toLowerCase() === 'write' ? writeDiff(args[index]!) : editDiff(args[index]!);
      if (!part || !part.lines.length) return;
      if (lines.length) lines.push({separator: true, segments: [{text: '    ⋯', color: faintColor()}]});
      lines.push(...part.lines); stats.added += part.stats.added; stats.removed += part.stats.removed;
    });
    const failure = failedAt >= 0 ? failureView(resultText(run[failedAt]!), run[failedAt]!.step?.state === 'cancelled') : undefined;
    const summary = [...failure?.summary ?? [], ...failure?.summary && (stats.added || stats.removed) ? [{text: ' · ', color: palette.muted, separator: true as const}] : [], ...diffSummary(stats)];
    return {summary, body: {lines: lines.length ? lines : failure?.body?.lines ?? [], empty: 'No changes'}};
  }});
}

export const UI: ToolUI = {
  visibility: 'visible',
  title(call) {
    return formatToolCardTitle(call);
  },
  render(context) {
    const call = context.call ?? messageToolCall(context.message);
    if (!call) return;
    renderToolCard(context, {title: cardTitle(context, call), view: () => editView(callArgs(call))});
  },
};
