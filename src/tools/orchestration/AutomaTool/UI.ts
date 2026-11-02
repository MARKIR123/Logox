import stringWidth from 'string-width';
import type {ToolCall} from '../../../runtime/messages.js';
import type {AutomaJobState, Step} from '../../../runtime/contracts.js';
import {stepElapsed} from '../../../runtime/steps.js';
import type {ToolRenderContext, ToolUI} from '../../ui-types.js';
import {palette} from '../../../tui/appearance/theme.js';
import {SWARM_TIME_WIDTH, swarmElapsed} from '../../../tui/appearance/animation.js';
import {clipLine} from '../../../tui/terminal/text.js';
import {insetFrame, type SceneRow, type SceneSegment} from '../../../tui/timeline/scene.js';
import {connect, seconds} from '../../../tui/timeline/group-row.js';
import {messageToolCall, renderDefaultTool} from '../../../tui/timeline/tool-ui.js';
import {AUTOMA_ANIMATION_FRAMES} from './prompt.js';

const SEP = ' · ';
const LIVE = new Set(['running', 'waiting', 'queued']);
const nouns: Readonly<Record<string, readonly [string, string]>> = {
  'drone swarm': ['drone', 'drones'], 'atelier hands': ['hand', 'hands'], 'runners': ['runner', 'runners'], 'work crew': ['member', 'members'],
};

function clip(text: string, max = 80): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}
function parseArgs(arguments_: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(arguments_);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {return {};}
}
/** One line, decision-relevant first. Never throws on legacy or malformed arguments. */
function automaTitle(call: ToolCall): string {
  const args = parseArgs(call.arguments);
  const jobs = Array.isArray(args.jobs) ? args.jobs : [];
  if (jobs.length === 1) {
    const title = jobs[0] && typeof jobs[0] === 'object' ? (jobs[0] as Record<string, unknown>).title : undefined;
    if (typeof title === 'string' && clip(title)) return 'Automa · ' + clip(title);
  }
  if (jobs.length > 1) return `Automa · ${jobs.length} jobs`;
  if (Array.isArray(args.release) && args.release.length) return 'Automa · release';
  if (typeof args.description === 'string' && clip(args.description)) return 'Automa · ' + clip(args.description);
  return 'Automa';
}

function capitalize(text: string): string {return text ? text[0]!.toUpperCase() + text.slice(1) : text;}
function noun(name: string, count: number): string {
  const pair = nouns[name.toLowerCase()] ?? ['job', 'jobs'];
  return pair[count === 1 ? 0 : 1]!;
}
function fit(text: string, width: number): string {
  if (width <= 0) return '';
  return stringWidth(text) <= width ? text : clipLine(text, Math.max(0, width - 1)).trimEnd() + '…';
}

/** A job still queued or running inside a step that has ended was cut off, whatever the last publication said. */
function effectiveJobs(jobs: readonly AutomaJobState[], step: Step | undefined): readonly AutomaJobState[] {
  if (!step || LIVE.has(step.state)) return jobs;
  return jobs.map(job => job.state === 'queued' || job.state === 'running' ? {...job, state: 'interrupted' as const} : job);
}
const jobStep = (job: AutomaJobState): Step | undefined => job.state === 'running' && job.startedAt !== undefined
  ? {state: 'running', title: job.title, elapsedMs: 0, runningSince: job.startedAt} : undefined;

function renderSwarm(context: ToolRenderContext): void {
  const {builder, message, frame, open, accent} = context;
  const swarm = message.step!.swarm!;
  const step = message.step!;
  const live = LIVE.has(step.state);
  const jobs = effectiveJobs(swarm.jobs, step);
  const returned = jobs.filter(job => job.state !== 'queued' && job.state !== 'running').length;
  const failed = jobs.filter(job => job.state === 'failed').length;
  const denied = jobs.filter(job => job.state === 'denied').length;
  const parentWidth = frame?.innerWidth ?? builder.contentWidth;
  const lead = open ? '▾ ' : '▸ ';
  const summary = [capitalize(swarm.name), `${jobs.length} ${noun(swarm.name, jobs.length)}`, `${returned} returned`,
    ...(failed ? [`${failed} failed`] : []), ...(denied ? [`${denied} denied`] : [])].join(SEP);
  const reserve = SEP.length + 7;
  const text = lead + fit(summary, Math.max(1, parentWidth - 4 - reserve - lead.length));
  const titleSegments: SceneSegment[] = [{text, color: live ? palette.fg : palette.muted, italic: true, selectionKey: message.id + ':title', selectionOffset: 0}];
  const elapsed = stepElapsed(step);
  const jobId = (index: number) => message.id + '-job-' + index;
  const jobOpen = (index: number) => context.isOpen?.(jobId(index)) ?? false;

  builder.pushOrdinaryCard({
    id: message.id, ownerId: message.ownerId, kind: 'Tool', title: text, titleSegments,
    status: live ? '' : elapsed > 0 ? seconds(elapsed) : '', bodyLines: [], open, railColor: accent, expandable: true,
    ...(live ? {step: {state: 'running', title: text, elapsedMs: step.elapsedMs, ...(step.runningSince !== undefined ? {runningSince: step.runningSince} : {})} as Step} : {}),
    ...(frame ? {parentFrame: frame} : {}),
    renderBody(inner) {
      jobs.forEach((job, index) => renderJob(context, job, jobId(index), jobOpen(index), inner));
    },
    renderAfterHeader(headerFrame) {
      // Collapsed only: each running job shows as a `└` row with a live frame and its own clock.
      const indented = insetFrame(insetFrame(headerFrame, headerFrame.bg), headerFrame.bg);
      jobs.forEach((job, index) => {
        const live = jobStep(job);
        if (!live) return;
        const id = jobId(index);
        const room = Math.max(1, indented.innerWidth - 2 - SEP.length - SWARM_TIME_WIDTH);
        const from = builder.rows.length;
        builder.pushFramedLine(id + '-live', accent, [
          {text: AUTOMA_ANIMATION_FRAMES[0]!, color: palette.automa, selectionKey: id + ':swarm_icon', selectionOffset: 0},
          {text: ' ' + fit(job.title, room), color: palette.fg, selectionKey: id + ':job_title', selectionOffset: 0},
          {text: SEP, color: palette.muted, separator: true, selectionKey: id + ':job_sep', selectionOffset: 0},
          {text: swarmElapsed(stepElapsed(live)), color: palette.muted, selectionKey: id + ':swarm_time', selectionOffset: 0},
        ], indented);
        for (let at = from; at < builder.rows.length; at++) {
          const row = builder.rows[at]!;
          const endCol = row.gutterCols + stringWidth(row.text.trimEnd());
          builder.rows[at] = {...row, animation: {step: live, thinking: false, actorColor: palette.automa, frames: AUTOMA_ANIMATION_FRAMES},
            hits: [{startCol: row.gutterCols, endCol, action: {kind: 'toggle_fold', foldId: message.id}}], hover: {foldId: message.id, startCol: row.gutterCols, endCol}} as SceneRow;
        }
        connect(builder.rows, from, indented.leftSegments.length - 1);
      });
    },
  });
}

function renderJob(context: ToolRenderContext, job: AutomaJobState, id: string, open: boolean, parent: NonNullable<ToolRenderContext['frame']>): void {
  const {builder, message, accent} = context;
  const bad = job.state === 'failed' || job.state === 'denied';
  const running = jobStep(job);
  const text = (open ? '▾ ' : '▸ ') + fit(job.title, Math.max(1, parent.innerWidth - 4 - 2 - SEP.length - job.state.length - 8)) + SEP + job.state;
  const color = bad ? palette.error : job.state === 'running' ? palette.fg : palette.muted;
  builder.pushOrdinaryCard({
    id, ownerId: message.ownerId, kind: 'Tool', title: text,
    titleSegments: [{text, color, selectionKey: id + ':title', selectionOffset: 0}],
    status: running ? '' : job.elapsedMs > 0 ? seconds(job.elapsedMs) : '', bodyLines: [], open, railColor: accent, expandable: true,
    ...(running ? {step: running} : {}),
    parentFrame: parent,
    renderBody(inner) {
      job.calls.forEach((call, at) => {
        const glyph = call.state === 'completed' ? '✓' : call.state === 'failed' ? '✗' : '·';
        builder.pushFramedLine(`${id}-call-${at}`, accent, [
          {text: glyph + ' ', color: call.state === 'failed' ? palette.error : palette.muted, selectionKey: `${id}-call-${at}:icon`, selectionOffset: 0},
          {text: fit(call.name + (call.title ? ' ' + call.title : ''), Math.max(1, inner.innerWidth - 2)), color: palette.muted, selectionKey: `${id}-call-${at}:title`, selectionOffset: 0},
        ], inner);
      });
      if (job.receipt?.trim()) builder.pushProse(id + '-receipt', job.receipt, accent, 'body', inner, undefined, palette.muted);
      else if (!job.calls.length) builder.pushProse(id + '-empty', job.state === 'queued' ? 'Waiting for a free slot' : 'No details', accent, 'body', inner, undefined, palette.muted);
    },
  });
}

function titled(context: ToolRenderContext): ToolRenderContext {
  const call = context.call ?? messageToolCall(context.message);
  const step = context.message.step;
  if (!call || !step?.call) return context;
  return {...context, message: {...context.message, step: {...step, title: automaTitle(call)}}};
}

export const UI: ToolUI = {
  visibility: 'visible',
  title: automaTitle,
  render(context) {
    const swarm = context.message.step?.swarm;
    if (swarm && swarm.jobs.length > 0) return renderSwarm(context);
    const titledContext = titled(context);
    renderDefaultTool(titledContext);
  },
};
