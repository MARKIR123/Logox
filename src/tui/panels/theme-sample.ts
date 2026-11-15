import stringWidth from 'string-width';
import {themeRevision} from '../../config/theme-palette.js';
import {RuntimeStore} from '../../runtime/store.js';
import {Steps} from '../../runtime/steps.js';
import {palette} from '../appearance/theme.js';
import {faintColor} from '../appearance/colors.js';
import {buildStageRows} from '../timeline/stage.js';
import {decorateRow, presentedSegments, railCell} from '../timeline/row-presentation.js';
import type {SceneRow} from '../timeline/scene.js';
import {clipLine} from '../terminal/text.js';
import {SAMPLE_SESSION as S, sample} from './theme-sample-data.js';

/**
 * The live sample of the /theme page. Most of it is the REAL timeline: a fixed fake session goes through `buildStageRows`, the same
 * builder, tool UIs, diff renderer and actor card the conversation uses, then through the row presentation the screen uses, so the sample
 * cannot drift from the real interface. The few regions the timeline does not own (status marks, effort and permission words, the
 * selection, the question card, the composer) are drawn here straight from the same palette tokens.
 */
export interface SampleSeg {readonly text: string; readonly color: string; readonly bg?: string; readonly bold?: boolean; readonly italic?: boolean; readonly underline?: boolean}
export type SampleRow = readonly SampleSeg[];

/** The fake session as a runtime store: one Director round with four tools, a running companion and a finished dream. */
function sampleStore(now: number): {store: RuntimeStore; open: Record<string, boolean>} {
  const store = new RuntimeStore();
  store.activities.create({sessionId: S, activityId: 'main', ownerId: 'logox', kind: 'director', title: 'Main', status: 'running', stage: 'x', detail: ''});
  store.message(S, 'user', 'user', sample.user, {activityId: 'main', inputKind: 'human'});
  store.message(S, 'logox', 'assistant', sample.reply, {activityId: 'main'});
  let clock = now - 20_000;
  const steps = new Steps(store, {sessionId: S, activityId: 'main', ownerId: 'logox'}, () => clock);
  const tool = (id: string, name: string, args: Record<string, unknown>, result: string, ms: number): string => {
    const messageId = steps.tool({id, name, arguments: JSON.stringify(args)});
    steps.start(messageId); clock += ms; steps.finish(messageId, 'completed', name + '\n' + result);
    return messageId;
  };
  tool('c-glob', 'Glob', {pattern: sample.glob.pattern}, sample.glob.result, 120);
  const edit = tool('c-edit', 'Edit', {file_path: sample.edit.file_path, old_string: sample.edit.old_string, new_string: sample.edit.new_string}, sample.edit.result, 1800);
  const grep = tool('c-grep', 'Grep', sample.grep.args, sample.grep.result, 340);
  const fetched = tool('c-fetch', 'WebFetch', {url: sample.fetch.url}, sample.fetch.result, 900);
  const {owner, task, narration, tool: running, seconds} = sample.companion;
  store.activities.create({sessionId: S, activityId: 'sample-actor', ownerId: owner, kind: 'actor', title: task, taskTitle: task, status: 'running', stage: 'x', detail: ''});
  store.message(S, owner, 'user', 'Do it.', {activityId: 'sample-actor', inputKind: 'director', source: 'logox'});
  store.message(S, owner, 'assistant', '⏵ ' + narration, {activityId: 'sample-actor'});
  const actorSteps = new Steps(store, {sessionId: S, activityId: 'sample-actor', ownerId: owner}, () => now - seconds * 1000);
  const runningId = actorSteps.tool({id: 'c-run', name: running.name, arguments: JSON.stringify(running.args)});
  actorSteps.start(runningId);
  store.activities.create({sessionId: S, activityId: 'sample-dream', ownerId: 'anamnesis', kind: 'anamnesis', title: sample.dream.stage, status: 'completed', stage: sample.dream.stage, detail: sample.dream.detail});
  // Glob stays a folded row; the Edit card, the Grep group (with its card), the fetch card and the Anamnesis card are open so the diff, the path, the highlight, the link and the actor tint show.
  return {store, open: {[edit]: true, [grep + '-group']: true, [grep]: true, [fetched]: true, 'sample-dream': true}};
}

/** The real timeline rows of the fake session at `width`; the running clock reads `sample.companion.seconds`. */
export function sampleScene(width: number, now = Date.now()): readonly SceneRow[] {
  const {store, open} = sampleStore(now);
  return buildStageRows(store.getSnapshot(), S, 'logox', width, open, null).map(row => decorateRow(row, now, false));
}

/** Clips to `width` cells and pads with `fill`, so every sample row is exactly one rectangle. */
export function fitRow(row: SampleRow, width: number, fill?: string): SampleRow {
  const result: SampleSeg[] = [];
  let used = 0;
  for (const seg of row) {
    if (used >= width) break;
    const room = width - used, text = stringWidth(seg.text) <= room ? seg.text : clipLine(seg.text, room);
    if (!text) continue;
    result.push({...seg, text}); used += stringWidth(text);
  }
  if (used < width) result.push({text: ' '.repeat(width - used), color: palette.fg, ...(fill ? {bg: fill} : {})});
  return result;
}

function sceneRows(width: number, now: number): SampleRow[] {
  return sampleScene(width, now).map((row, index): SampleRow => {
    const rail = row.gutterCols > 0 ? railCell(row) : undefined;
    const segs = [...rail ? [rail] : [], ...presentedSegments(row, index, null)];
    return segs.map((seg): SampleSeg => ({text: seg.text, color: seg.color ?? palette.fg, bg: seg.bg ?? row.bg ?? palette.bg,
      ...(seg.bold ? {bold: true} : {}), ...(seg.italic ? {italic: true} : {}), ...(seg.underline ? {underline: true} : {})}));
  });
}

const label = (text: string): SampleSeg => ({text, color: palette.muted, bg: palette.bg});
const word = (text: string, color: string, extra: Partial<SampleSeg> = {}): SampleSeg => ({text, color, bg: palette.bg, ...extra});
/** The regions drawn directly from palette tokens (the timeline has no owner for them). Read per call: tokens change with the preview. */
export function directRows(width: number): SampleRow[] {
  const effort = {off: palette.effortOff, low: palette.effortLow, medium: palette.effortMedium, high: palette.effortHigh, max: palette.effortMax, auto: palette.effortAuto};
  const mode = {default: palette.permissionDefault, auto: palette.permissionAuto, creative: palette.permissionCreative};
  const card = (segs: readonly SampleSeg[]): SampleRow => fitRow(segs.map(seg => ({...seg, bg: palette.cardExpanded})), width, palette.cardExpanded);
  const rule = (): SampleRow => [{text: '─'.repeat(width), color: palette.composerBorder, bg: palette.bg}];
  return [
    [word(sample.marks.success, palette.success), label('  '), word(sample.marks.warning, palette.warning), label('  '), word(sample.marks.error, palette.error)],
    [label('effort '), ...sample.efforts.flatMap((name): SampleSeg[] => [word(name, effort[name], {bold: true}), label(' ')])],
    [label('mode   '), ...sample.modes.flatMap((name): SampleSeg[] => [word(name, mode[name], {bold: true}), label(' ')])],
    [label('select '), {text: ' ' + sample.selection + ' ', color: palette.selectionFg, bg: palette.selectionBg}, label(' text'), word(' · ', faintColor())],
    card([{text: ' Question', color: palette.fg, bold: true}]),
    card([{text: ' ' + sample.prompt, color: palette.question, bold: true}]),
    card([{text: ' secondary text on the card · ↑↓ choose', color: palette.muted}]),
    rule(),
    [{text: '❯ ', color: palette.accent, bg: palette.bg, bold: true}, {text: sample.composer, color: palette.composerFg, bg: palette.bg}],
    rule(),
  ];
}

/** Every row of the sample at `width`, each exactly `width` cells wide on the theme's background. */
export function sampleRows(width: number, now = Date.now()): SampleRow[] {
  // The rows depend only on the width and the palette (every palette or presentation change bumps the theme revision), so hover and wheel redraws reuse them.
  const key = width + ':' + themeRevision();
  if (memo?.key === key) return memo.rows;
  const blank = (): SampleRow => [{text: ' '.repeat(width), color: palette.fg, bg: palette.bg}];
  const rows = [...sceneRows(width, now), blank(), ...directRows(width)].map(row => fitRow(row, width, palette.bg));
  memo = {key, rows};
  return rows;
}
let memo: {key: string; rows: SampleRow[]} | undefined;

/** The plain text of a row, for tests and diagnostics. */
export const rowText = (row: SampleRow): string => row.map(seg => seg.text).join('');
