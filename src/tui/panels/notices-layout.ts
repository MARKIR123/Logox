// The Notices page is drawn and hit-tested from this one plan (like /settings): `noticesLayout` returns the styled rows, the regions they were
// built from and the footer hints. Two groups, "Needs you" (pending: open approvals and questions, errors) then "Kept" (read notices), each
// newest first; one notice per row, its clickable parts and its `×` as hit cells, the row itself selects.
import {mainAction, type PersistentNotice} from '../../runtime/notices.js';
import {palette} from '../appearance/theme.js';
import {faintColor, mixHex} from '../appearance/colors.js';
import {clipLine} from '../terminal/text.js';
import type {Pointer, Region} from '../terminal/mouse.js';
import {panePadding, panelRows} from '../components/panel-frame.js';
import {noticeRow} from '../status/notice-line.js';
import type {Seg} from './settings-layout.js';

export type NoticesCommand =
  | {readonly kind: 'move'; readonly delta: number}
  | {readonly kind: 'select'; readonly index: number}
  /** Runs the main action of the notice at `index` (`-1`: the selected one), or the action of one `part` of it. */
  | {readonly kind: 'open'; readonly index: number; readonly part?: number}
  | {readonly kind: 'dismiss'; readonly index: number}
  | {readonly kind: 'dismissAll'}
  | {readonly kind: 'close'};
export interface NoticesHit {readonly region: Region; readonly command: NoticesCommand}
export interface NoticesView {readonly selected: number; readonly scroll: number}
export interface NoticesLayout {
  readonly rows: readonly (readonly Seg[])[];
  readonly hits: readonly NoticesHit[];
  readonly footer: {readonly text: string; readonly actions: readonly {readonly label: string; readonly command: NoticesCommand}[]};
  readonly selected: number; readonly scroll: number; readonly listRows: number;
}
export const EMPTY_TEXT = 'No notices. Open approvals and questions, and results kept for you, show here.';

export function noticesLayout(input: {notices: readonly PersistentNotice[]; view: NoticesView; width: number; height: number; y: number; pointer: Pointer | null; hoverColor: string}): NoticesLayout {
  const {notices, view, width, height, y, pointer, hoverColor} = input;
  const padding = panePadding(width), columns = Math.max(1, width - 2 * padding), frame = panelRows(height);
  const listRows = Math.max(1, frame.bodyHeight), bodyY = y + frame.bodyY, faint = faintColor();
  const selected = Math.max(0, Math.min(notices.length - 1, view.selected));
  const selectedBg = mixHex(hoverColor, palette.bg, 0.12);

  type Line = {readonly kind: 'group'; readonly text: string} | {readonly kind: 'entry'; readonly index: number};
  const lines: Line[] = [];
  notices.forEach((notice, index) => {
    if (index === 0 || notices[index - 1]!.kind !== notice.kind) lines.push({kind: 'group', text: notice.kind === 'pending' ? 'Needs you' : 'Kept until dismissed'});
    lines.push({kind: 'entry', index});
  });
  const selectedLine = Math.max(0, lines.findIndex(line => line.kind === 'entry' && line.index === selected));
  const heading = selectedLine > 0 && lines[selectedLine - 1]?.kind === 'group' ? 1 : 0;
  let scroll = Math.max(0, Math.min(view.scroll, Math.max(0, lines.length - listRows)));
  if (selectedLine - heading < scroll) scroll = selectedLine - heading;
  if (selectedLine >= scroll + listRows) scroll = selectedLine - listRows + 1;
  scroll = Math.max(0, Math.min(scroll, Math.max(0, lines.length - listRows)));

  const rows: Seg[][] = [], hits: NoticesHit[] = [];
  lines.slice(scroll, scroll + listRows).forEach((line, offset) => {
    const rowY = bodyY + offset;
    if (line.kind === 'group') {rows.push([{text: ' '.repeat(padding), color: palette.fg}, {text: clipLine(line.text, columns), color: palette.muted, bold: true}]); return;}
    const notice = notices[line.index]!, isSelected = line.index === selected, bg = isSelected ? selectedBg : undefined;
    // The row is the footer's row: parts and `×` come from the same plan, with room for the marker on the left.
    const room = Math.max(1, columns - 2);
    const first = noticeRow({top: notice, total: 1, width: room, hoverColor});
    const hovered = pointer && pointer.y === rowY
      ? first.regions.find(region => pointer.x >= padding + 2 + region.x0 && pointer.x < padding + 2 + region.x1)?.id : undefined;
    const plan = hovered ? noticeRow({top: notice, total: 1, width: room, hovered, hoverColor}) : first;
    for (const region of plan.regions) {
      const absolute = {y: rowY, x0: padding + 2 + region.x0, x1: padding + 2 + region.x1};
      const effect = plan.effect(region.id);
      if (!effect) continue;
      hits.push({region: absolute, command: effect.kind === 'dismiss' ? {kind: 'dismiss', index: line.index}
        : {kind: 'open', index: line.index, ...(region.id.startsWith('part:') ? {part: Number(region.id.slice(5))} : {})}});
    }
    const marker: Seg = {text: isSelected ? '❯ ' : '  ', color: hoverColor, bold: true, ...(bg ? {bg} : {})};
    rows.push([{text: ' '.repeat(padding), color: palette.fg, ...(bg ? {bg} : {})}, marker,
      ...plan.segments.map((segment): Seg => ({text: segment.text, color: segment.color ?? palette.fg, ...(segment.bold ? {bold: true} : {}), ...(segment.italic ? {italic: true} : {}), ...(segment.underline ? {underline: true} : {}), ...(bg ? {bg} : {})}))]);
    hits.push({region: {y: rowY, x0: 0, x1: width}, command: {kind: 'select', index: line.index}});
  });
  if (!notices.length) rows.push([{text: ' '.repeat(padding), color: palette.fg}, {text: clipLine(EMPTY_TEXT, columns), color: faint, italic: true}]);
  while (rows.length < listRows) rows.push([{text: ' ', color: palette.fg}]);

  const current = notices[selected], readCount = notices.filter(notice => notice.kind === 'read').length;
  const actions: {label: string; command: NoticesCommand}[] = [{label: '↑↓ Select', command: {kind: 'move', delta: 1}}];
  if (current && mainAction(current)) actions.push({label: 'Enter Open', command: {kind: 'open', index: -1}});
  if (current?.kind === 'read') actions.push({label: 'd Dismiss', command: {kind: 'dismiss', index: -1}});
  if (readCount > 1) actions.push({label: 'D Dismiss all', command: {kind: 'dismissAll'}});
  actions.push({label: 'Esc Back', command: {kind: 'close'}});
  // Row hits on the whole row come last so the parts and `×` win.
  const ordered = [...hits.filter(hit => hit.command.kind !== 'select'), ...hits.filter(hit => hit.command.kind === 'select')];
  return {rows, hits: ordered, footer: {text: actions.map(action => action.label).join(' · '), actions}, selected, scroll, listRows};
}
