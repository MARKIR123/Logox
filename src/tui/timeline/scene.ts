import type {Step} from '../../runtime/contracts.js';
import wrapAnsi from 'wrap-ansi';
import stringWidth from 'string-width';
import {expandedTint, faintColor, quietRail} from '../appearance/colors.js';
import {palette} from '../appearance/theme.js';
import {clipLine, safeText} from '../terminal/text.js';
import {ownerColor, ownerHeader, ownerSurface, type ActorStyle, type ActorStyles} from '../appearance/actor-style.js';
import {cast} from '../../actors/ensemble.js';
import {type Row} from './viewport.js';
import type {ContentCell} from './selection.js';
import {layoutMarkdown} from './markdown.js';
import {stepStatus, stepIcon, thinkingDuration, swarmElapsed} from '../appearance/animation.js';

/** Widest an expanded card body gets, however wide the terminal is. */
export const MAX_BODY_WIDTH = 100;
/** Separator between row parts; always its own muted segment. */
export const SEPARATOR = ' · ';

export interface SceneSegment {
  readonly text: string;
  readonly color?: string;
  readonly bg?: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  /** Marks a ` · ` separator so adjacent segments never merge into it. */
  readonly separator?: true;
  readonly selectionKey?: string;
  readonly selectionOffset?: number;
}

export interface SceneAction {
  readonly kind:
    | 'toggle_fold'
    | 'actor_summary'
    | 'actor_body'
    | 'select_permission'
    | 'confirm_permission'
    | 'select_style'
    | 'focus_custom'
    | 'confirm_style'
    | 'select_answer'
    | 'confirm_answer'
    | 'stop_actor'
    | 'later';
  readonly requestId?: string;
  readonly foldId?: string;
  readonly owner?: string;
  readonly value?: string;
}

export interface SceneRow extends Row {
  readonly color?: string;
  readonly hover?: {readonly foldId: string; readonly startCol: number; readonly endCol: number};
  readonly bg?: string;
  readonly prefixSegments?: readonly SceneSegment[];
  readonly suffixSegments?: readonly SceneSegment[];
  readonly segments?: readonly SceneSegment[];
  readonly action?: SceneAction;
  readonly hits?: readonly {readonly startCol: number; readonly endCol: number; readonly action: SceneAction}[];
  readonly animation?: {readonly step?: Step; readonly thinking?: boolean; readonly highlighted?: boolean; readonly actorBg?: string; readonly actorColor?: string; readonly active?: boolean; readonly open?: boolean; readonly frames?: readonly string[] | undefined};
  readonly controls?: readonly {readonly startCol: number; readonly endCol: number; readonly action: SceneAction; readonly disabled?: boolean}[];
}

function railColorFor(who: string, roles: ActorStyles = cast): string {
  if (who === 'user') return palette.user;
  if (who === 'system') return palette.system;
  if (who === 'logox') return palette.accent;
  return ownerColor(who, roles);
}

function whoName(who: string, roles: ActorStyles = cast): string {
  if (who === 'user') return 'You';
  if (who === 'system') return '';
  if (who === 'logox') return 'Logox';
  if (who === 'anamnesis') return 'Anamnesis';
  return roles[who]?.name ?? who;
}
/** The speaker glyph drawn on the rail of a turn header. */
function whoGlyph(who: string, roles: ActorStyles = cast): string {
  if (who === 'user') return '❯';
  if (who === 'logox') return '◈';
  return roles[who]?.symbol ?? '◇';
}

/** Removes trailing newlines and whitespace-only lines; the indentation of the last real line is kept. */
export function trimTrailingBlankLines(text: string): string {
  return text.replace(/(?:\r?\n[ \t]*)+$/, '').replace(/^[ \t\r\n]+$/, '');
}

/** Reasoning keeps its paragraphs on separate lines but never shows empty rows, at the edges or between paragraphs. */
export function compactParagraphs(text: string): string {
  return text.split(/\r?\n/).filter(line => line.trim()).join('\n');
}

function statusColor(status: string, actorColor = palette.accent): string {
  if (/Awaiting|Waiting/.test(status)) return actorColor;
  if (/Pending review/.test(status)) return palette.dreamText;
  return palette.muted;
}

export interface FrameWrap {
  readonly leftSegments: readonly SceneSegment[];
  readonly rightSegments: readonly SceneSegment[];
  readonly leftCols: number;
  readonly rightCols: number;
  readonly innerWidth: number;
  readonly bg?: string;
  /** Color of the surface owner (the actor whose card hosts these rows, Logox on the timeline); row hover highlights use it. */
  readonly surfaceColor?: string;
}

/** Live activity after the speaker name: spinner, current action and elapsed time (the spinner and clock are drawn by `decorateRow`). */
/** Without `since` the activity is static text (waiting on an answer or approval): no spinner, no clock. */
export interface TurnActivity {readonly label: string; readonly since?: number}

export interface RowBuilder {
  rows: SceneRow[];
  width: number;
  baseGutterCols: number;
  contentWidth: number;
  hoveredFoldId: string | null;
  pushBlank(railColor?: string, frame?: FrameWrap, action?: SceneAction): void;
  pushTurnHeader(id: string, who: string, origin?: string, clock?: string, activity?: TurnActivity): void;
  pushProse(id: string, text: string, railColor: string, tone?: 'body' | 'direction', frame?: FrameWrap, action?: SceneAction, color?: string): void;
  pushMarkdown(id: string, text: string, railColor: string, frame?: FrameWrap): void;
  pushFramedLine(
    id: string,
    railColor: string,
    innerSegments: readonly SceneSegment[],
    frame: FrameWrap,
    action?: SceneAction,
    lineBg?: string,
  ): void;
  pushCardCap(
    id: string,
    edge: 'top' | 'bottom',
    cardBg: string | undefined,
    railColor: string,
    parentFrame?: FrameWrap,
    action?: SceneAction,
  ): void;
  pushCardHeader(id: string, label: readonly SceneSegment[], title: string, status: string, frame: FrameWrap, railColor: string, action: SceneAction, statusTint?: string, textTint?: string, textBold?: boolean): void;
  pushOrdinaryCard(opts: {
    id: string;
    kind: string;
    title: string;
    titleSegments?: readonly SceneSegment[] | undefined;
    summary?: string | undefined;
    faultLabel?: string;
    bodyLines: readonly string[];
    status?: string;
    open: boolean;
    railColor: string;
    parentFrame?: FrameWrap;
    ownerId?: string;
    toneColor?: string;
    step?: Step;
    tokens?: number;
    renderBody?(frame: FrameWrap): void;
    /** Expandable cards (▸/▾ leading glyph in the title) draw no `▮` icon, and the whole header row hovers and toggles. */
    expandable?: boolean;
    /** Rows drawn under a collapsed header (for example the running tools of a group). Their hover and clicks belong to this card. */
    renderAfterHeader?(frame: FrameWrap): void;
  }): void;
}

export function insetFrame(parent: FrameWrap, bg: string | undefined, left = 2, right = left): FrameWrap {
  left = Math.min(left, Math.max(0, parent.innerWidth - 1));
  right = Math.min(right, Math.max(0, parent.innerWidth - left - 1));
  return {
    leftSegments: [...parent.leftSegments, {text: ' '.repeat(left), ...(bg ? {bg} : {})}],
    rightSegments: [{text: ' '.repeat(right), ...(bg ? {bg} : {})}, ...parent.rightSegments],
    leftCols: parent.leftCols + left,
    rightCols: parent.rightCols + right,
    innerWidth: Math.max(1, parent.innerWidth - left - right),
    ...(bg ? {bg} : {}),
    ...(parent.surfaceColor ? {surfaceColor: parent.surfaceColor} : {}),
  };
}

export function insetRailFrame(parent: FrameWrap, railColor: string, bg?: string): FrameWrap {
  const left = 2;
  const frameBg = bg ?? parent.bg;
  return {
    leftSegments: [...parent.leftSegments, {text: '│ ', color: quietRail(railColor), ...(frameBg ? {bg: frameBg} : {})}],
    rightSegments: parent.rightSegments,
    leftCols: parent.leftCols + left,
    rightCols: parent.rightCols,
    innerWidth: Math.max(1, parent.innerWidth - left),
    ...(frameBg ? {bg: frameBg} : {}),
    ...(parent.surfaceColor ? {surfaceColor: parent.surfaceColor} : {}),
  };
}

const segmenter = new Intl.Segmenter('zh', {granularity: 'grapheme'});

// Preserve segment styling while wrapping at display-cell boundaries.
function wrapSegments(segments: readonly SceneSegment[], width: number): SceneSegment[][] {
  const lines: SceneSegment[][] = [[]];
  let used = 0;
  for (const segment of segments) {
    let offset = segment.selectionOffset ?? 0;
    for (const {segment: part} of segmenter.segment(safeText(segment.text))) {
      if (part === '\n' || (used > 0 && used + stringWidth(part) > width)) {
        lines.push([]); used = 0;
        if (part === '\n') continue;
      }
      const line = lines.at(-1)!;
      const last = line.at(-1);
      const value = {...segment, text: part, selectionOffset: offset};
      offset += part.length;
      if (last && last.color === value.color && last.bg === value.bg && last.bold === value.bold && last.italic === value.italic && last.separator === value.separator && last.selectionKey === value.selectionKey) {
        line[line.length - 1] = {...last, text: last.text + part};
      } else line.push(value);
      used += stringWidth(part);
    }
  }
  return lines;
}

/** `surfaceColor` is the owner of the surface being drawn (Logox on the timeline, the actor in its own window); hover highlights use it. */
export function createBuilder(width: number, hoveredFoldId: string | null, roles: ActorStyles = cast, surfaceColor: string = palette.accent): RowBuilder {
  const rows: SceneRow[] = [];
  const baseGutterCols = width >= 6 ? 2 : 0;
  const contentWidth = Math.max(1, width - baseGutterCols);
  const topFrame = (): FrameWrap => ({leftSegments: [], rightSegments: [], leftCols: 0, rightCols: 0, innerWidth: contentWidth, surfaceColor});

  const pushBlank = (railColor = '', frame?: FrameWrap, action?: SceneAction) => {
    const f = frame ?? topFrame();
    rows.push({
      messageId: 'spacer-' + rows.length, line: 0, text: '', railColor,
      gutterCols: railColor ? baseGutterCols + f.leftCols : 0,
      softWrap: false, noSelect: true, tone: 'spacer',
      ...(f.bg ? {bg: f.bg} : {}),
      ...(f.bg || f.leftCols || f.rightCols ? {segments: [
        ...f.leftSegments, {text: ' '.repeat(f.innerWidth), ...(f.bg ? {bg: f.bg} : {})}, ...f.rightSegments,
      ]} : {}),
      ...(action ? {action} : {}),
    });
  };

  const pushFramedLine: RowBuilder['pushFramedLine'] = (id, railColor, innerSegments, frame, action, lineBg) => {
    const bg = lineBg ?? frame.bg;
    const wrapped = wrapSegments(innerSegments, frame.innerWidth);
    let offset = 0;
    for (let index = 0; index < wrapped.length; index++) {
      const inner = wrapped[index]!;
      const used = inner.reduce((sum, s) => sum + stringWidth(s.text), 0);
      const segments = [...frame.leftSegments,
        ...inner.map(s => bg && !s.bg ? {...s, bg} : s),
        {text: ' '.repeat(Math.max(0, frame.innerWidth - used)), ...(bg ? {bg} : {})},
        ...frame.rightSegments];
      const selectionCells: ContentCell[] = [];
      let column = 0;
      for (const [partIndex, segment] of segments.entries()) {
        let fieldOffset = segment.selectionOffset ?? offset;
        const key = segment.selectionKey ?? (partIndex >= frame.leftSegments.length && partIndex < frame.leftSegments.length + inner.length ? id : id + ':frame:' + index);
        for (const {segment: glyph} of segmenter.segment(segment.text)) {
          const width = Math.max(1, stringWidth(glyph));
          selectionCells.push({column, width, key, offset: fieldOffset});
          column += width; fieldOffset += glyph.length;
        }
        if (partIndex >= frame.leftSegments.length && partIndex < frame.leftSegments.length + inner.length) offset += segment.text.length;
      }
      rows.push({
        messageId: id, line: index, text: inner.map(s => s.text).join(''), displayText: segments.map(s => s.text).join(''), selectionCells, railColor,
        gutterCols: baseGutterCols + frame.leftCols, softWrap: index < wrapped.length - 1, noSelect: true, tone: 'body',
        ...(bg ? {bg} : {}), segments, ...(action ? {action} : {}),
      });
    }
  };

  const pushTurnHeader: RowBuilder['pushTurnHeader'] = (id, who, origin = '', clock = '', activity) => {
    const railColor = railColorFor(who, roles);
    const pieces: SceneSegment[] = [{text: whoName(who, roles), color: railColor, bold: true, selectionKey: id + ':name', selectionOffset: 0}];
    if (origin) pieces.push({text: ' · ' + origin, color: palette.muted, selectionKey: id + ':origin'});
    const since = activity?.since;
    if (activity) {
      // The live part (spinner, action, clock) only shows when it fits on the header row; the label is clipped to the room left.
      const fixed = since !== undefined ? 2 + 1 + 1 + SEPARATOR.length + 6 : 2;
      const room = contentWidth - pieces.reduce((sum, p) => sum + stringWidth(p.text), 0) - fixed;
      const label = room >= 4 ? clipLine(activity.label, room) : '';
      if (label && since !== undefined) pieces.push(
        {text: '  ', selectionKey: id + ':activity_gap', selectionOffset: 0},
        {text: '⠋', color: railColor, selectionKey: id + ':activity_icon', selectionOffset: 0},
        {text: ' ' + label, color: palette.muted, selectionKey: id + ':activity', selectionOffset: 0},
        {text: SEPARATOR, color: faintColor(), separator: true, selectionKey: id + ':activity_sep', selectionOffset: 0},
        {text: swarmElapsed(Date.now() - since), color: faintColor(), selectionKey: id + ':activity_time', selectionOffset: 0});
      else if (label) pieces.push({text: '  ' + label, color: palette.muted, selectionKey: id + ':activity', selectionOffset: 0});
    }
    const used = pieces.reduce((sum, s) => sum + stringWidth(s.text), 0);
    if (clock && used + stringWidth(clock) + 2 <= contentWidth) pieces.push({text: ' '.repeat(contentWidth - used - stringWidth(clock)) + clock, color: palette.muted});
    const first = rows.length;
    pushFramedLine(id, railColor, pieces, topFrame());
    rows[first] = {...rows[first]!, railGlyph: whoGlyph(who, roles),
      ...(since !== undefined && pieces.some(p => p.selectionKey === id + ':activity_icon') ? {animation: {step: {title: '', state: 'running', elapsedMs: 0, runningSince: since} as Step, actorColor: railColor}} : {})};
  };

  const pushProse: RowBuilder['pushProse'] = (id, text, railColor, tone = 'body', frame, action, color) => {
    const f = frame ?? topFrame();
    let line = 0;
    let sourceStart = 0;
    const body = text.trim() ? trimTrailingBlankLines(safeText(text)) : safeText(text); // a trailing newline in tool output or notices is not a row; an explicit empty line stays one
    for (const paragraph of body.split('\n')) {
      const wrapped = wrapAnsi(paragraph, f.innerWidth, {hard: true, trim: false}).split('\n');
      for (let index = 0; index < wrapped.length; index++) {
        const value = wrapped[index]!;
        const padTail = Math.max(0, f.innerWidth - stringWidth(value));
        rows.push({
          messageId: id, line: line++, text: value, displayText: f.leftSegments.map(s => s.text).join('') + value + (f.bg || f.rightCols ? ' '.repeat(padTail) + f.rightSegments.map(s => s.text).join('') : ''), railColor, gutterCols: baseGutterCols + f.leftCols,
          softWrap: index < wrapped.length - 1, noSelect: false, tone,
          sourceStart, sourceEnd: sourceStart + value.length,
          ...(color ? {color} : {}),
          ...(f.bg ? {bg: f.bg} : {}),
          ...(f.leftCols ? {prefixSegments: f.leftSegments} : {}),
          ...(f.bg || f.rightCols ? {suffixSegments: [
            {text: ' '.repeat(padTail), ...(f.bg ? {bg: f.bg} : {})}, ...f.rightSegments,
          ]} : {}),
          ...(action ? {action} : {}),
        });
        sourceStart += value.length;
      }
      sourceStart++;
    }
  };

  const pushMarkdown: RowBuilder['pushMarkdown'] = (id, text, railColor, frame) => {
    const f = frame ?? topFrame();
    text = trimTrailingBlankLines(text.replace(/^(?:[ \t]*\r?\n)+/, '')); // leading and trailing blank lines are never content
    if (!text.trim()) return;
    for (const [line, value] of layoutMarkdown(text, f.innerWidth).entries()) {
      rows.push({messageId: id, line, text: value.text, displayText: f.leftSegments.map(s => s.text).join('') + value.text + (f.bg || f.rightCols ? ' '.repeat(Math.max(0, f.innerWidth - stringWidth(value.text))) + f.rightSegments.map(s => s.text).join('') : ''), railColor, gutterCols: baseGutterCols + f.leftCols,
        softWrap: value.softWrap, noSelect: Boolean(value.noSelect), tone: 'body', sourceText: text,
        sourceStart: value.start, sourceEnd: value.end, sourceCells: value.cells,
        ...(value.sourceBlock ? {sourceBlock: value.sourceBlock} : {}),
        ...(f.bg ? {bg: f.bg} : {}),
        ...(f.leftCols ? {prefixSegments: f.leftSegments} : {}),
        ...(f.bg || f.rightCols ? {suffixSegments: [{text: ' '.repeat(Math.max(0, f.innerWidth - stringWidth(value.text))), ...(f.bg ? {bg: f.bg} : {})}, ...f.rightSegments]} : {}),
        segments: [...f.leftSegments, ...value.pieces.map(piece => ({text: piece.text,
          ...(piece.bold ? {bold: true} : {}), ...(piece.italic ? {italic: true} : {}),
          color: piece.muted ? palette.muted : piece.code ? railColor : palette.fg})),
          ...(f.bg || f.rightCols ? [{text: ' '.repeat(Math.max(0, f.innerWidth - stringWidth(value.text)))}, ...f.rightSegments] : [])],
      });
    }
  };

  const pushCardCap: RowBuilder['pushCardCap'] = (id, edge, cardBg, railColor, parentFrame, action) => {
    const pf = parentFrame ?? topFrame();
    // Top ▄ (U+2584, upper half transparent + lower half card color) mirrors bottom ▀ (U+2580, upper half card color + lower half transparent): 0.5 row of padding each side, so the card is exactly 2 rows tall
    const glyph = edge === 'top' ? '▄' : '▀';
    const segment: SceneSegment = !cardBg ? {text: ' '.repeat(pf.innerWidth)} : {text: glyph.repeat(pf.innerWidth), color: cardBg};
    pushFramedLine(id, railColor, [segment], pf, action);
  };

  const pushCardHeader: RowBuilder['pushCardHeader'] = (id, label, title, status, frame, railColor, action, statusTint = palette.muted, textTint = palette.fg, textBold = false) => {
    label = label.map((segment, index) => ({...segment, selectionKey: segment.selectionKey ?? (id + ':label:' + index), selectionOffset: 0}));
    const titleSegment = {text: title, color: textTint, bold: textBold, selectionKey: id + ':title', selectionOffset: 0};
    const statusSegment = {text: status, color: statusTint, selectionKey: id + ':status', selectionOffset: 0};
    const labelW = label.reduce((sum, s) => sum + stringWidth(s.text), 0);
    const statusW = stringWidth(status);
    const titleW = stringWidth(title);
    const separator = title ? ' · ' : '';
    const used = labelW + stringWidth(separator) + titleW;
    if (used + statusW + (status ? 1 : 0) <= frame.innerWidth) {
      pushFramedLine(id, railColor, [
        ...label,
        {text: separator, color: palette.muted},
        titleSegment,
        {text: ' '.repeat(Math.max(0, frame.innerWidth - used - statusW))},
        statusSegment,
      ], frame, action);
      return;
    }
    // Keep identity and status visible; the complete task gets its own wrapped rows.
    const header = [...label];
    if (labelW + statusW + 1 <= frame.innerWidth) {
      header.push({text: ' '.repeat(frame.innerWidth - labelW - statusW)}, statusSegment);
      pushFramedLine(id, railColor, header, frame, action);
    } else {
      pushFramedLine(id, railColor, header, frame, action);
      if (status) pushFramedLine(id + '-status', railColor, [statusSegment], frame, action);
    }
    if (title) pushFramedLine(id + '-task', railColor, [titleSegment], frame, action);
  };

  const pushOrdinaryCard: RowBuilder['pushOrdinaryCard'] = opts => {
    const pf = opts.parentFrame ?? topFrame();
    const isDream = opts.kind === 'Anamnesis';
    const firstRow = rows.length;
    let subFrom = -1, subTo = -1;
    const bright = opts.open || hoveredFoldId === opts.id;
    const simple = opts.kind === 'Thinking' || opts.kind === 'Tool' || opts.kind === 'Task';
    // Background color only ever means "expanded": a faint tint of the surface owner's color. Folded rows never carry one.
    const cardBg = isDream ? (bright ? palette.dreamExpanded : palette.dreamCollapsed) : opts.open && simple ? expandedTint(pf.surfaceColor ?? palette.accent) : pf.bg;
    // Simple cards start right after the rail (header flush, body indented under the title); other cards keep their inset frame.
    const bodyFrame = insetFrame(pf, cardBg, 2, 2 + Math.max(0, pf.innerWidth - 4 - MAX_BODY_WIDTH));
    const frame = simple ? (cardBg && cardBg !== pf.bg ? {...pf, bg: cardBg} : pf) : insetFrame(pf, cardBg);
    const action: SceneAction = {kind: 'toggle_fold', foldId: opts.id};
    if (isDream) {
      pushCardCap(opts.id + '-top', 'top', cardBg, opts.railColor, pf, action);
    }
    // Hover highlights belong to the surface that hosts the row, never to the card's sender or tool owner.
    const highlightColor = isDream ? palette.dreamText : pf.surfaceColor ?? palette.accent;
    const labelColor = opts.toneColor ?? (isDream ? palette.dreamText : bright ? highlightColor : palette.muted);
    const titleColor = opts.toneColor ?? (simple ? hoveredFoldId === opts.id ? highlightColor : opts.open ? palette.fg : palette.muted : isDream ? palette.dreamText : bright ? highlightColor : palette.fg);
    if (simple) {
      const thinking = opts.kind === 'Thinking';
      const terminal = opts.step && ['completed', 'failed', 'cancelled'].includes(opts.step.state);
      const title = thinking ? terminal ? 'Thought for' : 'Thinking...' : opts.title;
      const status = thinking ? (opts.step ? thinkingDuration(opts.step, Date.now()) : '') : opts.step ? stepStatus(opts.step, Date.now()) : opts.status ?? '';
      const live = opts.step?.state === 'running';
      const icon = thinking && opts.step ? stepIcon(opts.step, Date.now(), false) : opts.open && !live ? '▾' : '▮';
      const fault = opts.step?.disposition === 'denied' ? 'Denied' : opts.step?.disposition === 'error' || opts.step?.state === 'failed' ? 'Error' : '';
      const isTool = !thinking;
      const statusText = isTool && status ? status.trim() : status;
      const statusSepText = status ? thinking && terminal ? ' ' : ' · ' : '';
      const isHovered = hoveredFoldId === opts.id;
      const italic = Boolean(opts.titleSegments?.[0]?.italic); // an italic title row carries its separator and elapsed time in italic too
      const italicProp = italic ? {italic: true} : {};
      const separator = (text: string, key: string): SceneSegment => ({text, color: palette.muted, ...italicProp, separator: true, selectionKey: key, selectionOffset: 0});
      // Every ` · ` inside a title becomes its own muted segment so the separator never takes the color of its neighbours.
      const splitSeparators = (s: SceneSegment): SceneSegment[] => {
        const parts = s.text.split(SEPARATOR);
        let consumed = 0;
        return parts.flatMap((text, index): SceneSegment[] => {
          const at = consumed;
          consumed += text.length + SEPARATOR.length;
          const offset = (position: number) => s.selectionOffset === undefined ? {} : {selectionOffset: s.selectionOffset + position};
          const sep: SceneSegment[] = index > 0 ? [{...s, text: SEPARATOR, color: palette.muted, separator: true, ...offset(at - SEPARATOR.length)}] : [];
          return text ? [...sep, {...s, text, ...offset(at)}] : sep;
        });
      };
      const titleSource: readonly SceneSegment[] = opts.titleSegments && opts.titleSegments.length > 0
        ? opts.titleSegments
        : [{text: title, color: titleColor, selectionKey: opts.id + ':title', selectionOffset: 0}];
      const titlePieces: SceneSegment[] = titleSource.flatMap(splitSeparators).map(s => {
        if (s.text === SEPARATOR) return {...s, color: palette.muted};
        const recolor = isHovered && (!s.color || s.color === palette.muted || s.color === titleColor || (opts.expandable && opts.step?.state === 'running' && s.color === palette.fg));
        return recolor ? {...s, color: highlightColor} : s;
      });
      const tokenText = (opts.tokens ?? 0) > 0 ? opts.tokens + ' Tokens' : '';
      const waitingText = opts.step?.state === 'waiting' ? opts.step.waiting ?? 'Waiting' : '';
      const hoverMuted = (color: string) => isHovered && color === palette.muted ? highlightColor : color;
      const pieces: SceneSegment[] = [
        ...(opts.expandable ? [] : [{text: icon + ' ', color: fault ? palette.error : opts.open && !live ? palette.fg : thinking && opts.step && !terminal ? highlightColor : palette.muted, selectionKey: opts.id + ':icon', selectionOffset: 0}]),
        ...titlePieces,
        ...(statusSepText ? [separator(statusSepText, opts.id + ':status_sep')] : []),
        ...(statusText ? [{text: statusText, color: fault ? palette.error : hoverMuted(palette.muted), ...italicProp, selectionKey: opts.id + ':status', selectionOffset: 0}] : []),
        ...(thinking && tokenText ? [separator(SEPARATOR, opts.id + ':tokens_sep'), {text: tokenText, color: hoverMuted(palette.muted), selectionKey: opts.id + ':tokens', selectionOffset: 0}] : []),
        ...(thinking && waitingText ? [separator(SEPARATOR, opts.id + ':waiting_sep'), {text: waitingText, color: hoverMuted(palette.muted), selectionKey: opts.id + ':waiting', selectionOffset: 0}] : []),
        ...((opts.faultLabel ?? fault) ? [{text: '  ' + (opts.faultLabel ?? fault), color: palette.error, bold: true, selectionKey: opts.id + ':fault', selectionOffset: 0}] : []),
      ];
      pushFramedLine(opts.id, opts.railColor, pieces, frame, action);
      if (opts.step) for (let index = firstRow; index < rows.length; index++) {
        const row = rows[index]!;
        const frames = opts.ownerId && roles[opts.ownerId]?.thinkingAnimation ? roles[opts.ownerId]?.thinkingAnimation : undefined;
        rows[index] = {...row, animation: {step: opts.step, thinking, highlighted: hoveredFoldId === opts.id, actorColor: highlightColor, frames}};
      }
      if (!opts.open && opts.renderAfterHeader) {
        subFrom = rows.length;
        opts.renderAfterHeader(frame);
        subTo = rows.length;
      }
    } else pushCardHeader(opts.id, [{text: opts.kind, color: labelColor, bold: isDream}],
      opts.title, opts.status ?? '', frame, opts.railColor, action,
      isDream ? palette.dreamMuted : statusColor(opts.status ?? '', highlightColor), titleColor, false);
    if (opts.open) {
      // Interior blank lines are content (command output); the trailing ones are formatting.
      let bodyEnd = opts.bodyLines.length;
      while (bodyEnd > 0 && !opts.bodyLines[bodyEnd - 1]!.trim()) bodyEnd--;
      const inner = simple ? bodyFrame : frame;
      opts.bodyLines.slice(0, bodyEnd).forEach((text, index) => pushProse(opts.id + '-body-' + index, text, opts.railColor, opts.kind === 'Tool' ? 'direction' : 'body', inner, action, opts.toneColor ?? (isDream ? palette.dreamText : undefined)));
      opts.renderBody?.(inner);
    }
    if (isDream) {
      pushCardCap(opts.id + '-bottom', 'bottom', cardBg, opts.railColor, pf, action);
    }
    for (let index = firstRow; index < rows.length; index++) {
      const row = rows[index]!;
      if (index >= subFrom && index < subTo) {
        rows[index] = {...row, hits: (row.hits ?? []).map(hit => ({...hit, action})), ...(row.hover ? {hover: {...row.hover, foldId: opts.id}} : {})};
        continue;
      }
      const startCol = opts.open || isDream ? baseGutterCols + pf.leftCols : row.gutterCols;
      // The hover and click region runs from the leading glyph to the last non-blank cell of the row.
      const endCol = opts.open || isDream ? width - pf.rightCols : row.gutterCols + stringWidth(row.text.trimEnd());
      rows[index] = {...row, hits: [...row.hits ?? [], {startCol, endCol, action}],
        ...(!opts.open ? {hover: {foldId: opts.id, startCol, endCol}} : {})};
    }
  };

  return {rows, width, baseGutterCols, contentWidth, hoveredFoldId, pushBlank, pushTurnHeader, pushProse, pushMarkdown, pushFramedLine, pushCardCap, pushCardHeader, pushOrdinaryCard};
}

function markHover(rows: SceneRow[], start: number, foldId: string, startCol: number, endCol: number) {
  for (let index = start; index < rows.length; index++) {
    rows[index] = {...rows[index]!, hover: {foldId, startCol, endCol}};
  }
}

export function actionAt(row: SceneRow | undefined, x: number): SceneAction | undefined {
  const control = row?.controls?.find(item => x >= item.startCol && x < item.endCol);
  if (control) return control.disabled ? undefined : control.action;
  if (row?.hits) return row.hits.find(hit => x >= hit.startCol && x < hit.endCol)?.action;
  return row?.action;
}

export function hoveredCardAt(row: SceneRow | undefined, x: number): string | null {
  return row?.hover && x >= row.hover.startCol && x < row.hover.endCol ? row.hover.foldId : null;
}

export function appendActorCard(
  builder: RowBuilder,
  opts: {
    id: string;
    owner: string;
    roles?: ActorStyles;
    task: string;
    status: string;
    open: boolean;
    railColor: string;
    active?: boolean;
    stop?: {readonly disabled: boolean; readonly focused: boolean; readonly hovered: boolean};
    /** `frame` is inset two columns under the symbol; `outer` starts right after the surface rail, where the inner `│` rail of an open card runs. */
    renderBody(frame: FrameWrap, actorColor: string, bodyAction: SceneAction, outer: FrameWrap): void;
  },
) {
  const roles: ActorStyles = opts.roles ?? cast;
  const role: ActorStyle = roles[opts.owner] ?? {symbol: '◇', name: opts.owner, title: opts.owner, color: palette.accent};
  const shortStatus = opts.status.split(' · ')[0]!.replace('Awaiting approval', 'Approval?').replace('Awaiting answer', 'Answer?');
  const firstRow = builder.rows.length;
  const isHovered = builder.hoveredFoldId === opts.id;
  const bright = opts.open || isHovered;
  const cardBg = opts.open ? (opts.owner === 'anamnesis' ? ownerSurface(opts.owner, true, opts.roles) : expandedTint(role.color)) : undefined;
  const outerFrame: FrameWrap = {leftSegments: [], rightSegments: [], leftCols: 0, rightCols: 0, innerWidth: builder.contentWidth, surfaceColor: role.color};
  // The card starts right after the surface rail: the actor symbol sits in the first content column and the inner `│` rail of an open card runs under it.
  const headFrame: FrameWrap = cardBg ? {...outerFrame, bg: cardBg} : outerFrame;
  const frame = insetFrame(outerFrame, cardBg);
  const action: SceneAction = {kind: 'actor_summary', foldId: opts.id, owner: opts.owner};
  builder.pushCardHeader(
    opts.id,
    [
      {text: role.symbol, color: role.color, bold: true, selectionKey: opts.id + ':icon'},
      {text: ' ' + role.name, color: role.color, bold: true, selectionKey: opts.id + ':name'},
    ],
    opts.task,
    shortStatus + (opts.stop ? opts.stop.disabled ? ' · Stopping…' : ' · ■ Stop' : '') + ' ' + (opts.open ? '▾' : '▸'),
    headFrame,
    opts.railColor,
    action,
    statusColor(shortStatus, role.color),
    bright ? role.color : palette.fg,
    false,
  );
  if (opts.stop) {
    const label = opts.stop.disabled ? 'Stopping…' : '■ Stop';
    for (let index = firstRow; index < builder.rows.length; index++) {
      const row = builder.rows[index]!, at = row.text.lastIndexOf(label);
      if (at < 0) continue;
      const startCol = row.gutterCols + stringWidth(row.text.slice(0, at));
      const tint = opts.stop.focused || opts.stop.hovered ? role.color : palette.muted;
      const segments = row.segments?.flatMap(segment => {
        // The status is a dedicated segment; only its stop label uses focus color.
        if (!segment.text.includes(label)) return [segment];
        const split = segment.text.lastIndexOf(label);
        return [{...segment, text: segment.text.slice(0, split)}, {...segment, text: label, color: tint, bold: Boolean(opts.stop?.focused)},
          {...segment, text: segment.text.slice(split + label.length)}];
      });
      builder.rows[index] = {...row, ...(segments ? {segments} : {}), controls: [{startCol, endCol: startCol + stringWidth(label),
        action: {kind: 'stop_actor', foldId: opts.id, owner: opts.owner}, disabled: opts.stop.disabled}]};
    }
  }
  if (opts.open) {
    opts.renderBody(frame, role.color, action, headFrame);
  }
  for (let index = firstRow; index < builder.rows.length; index++) {
    const row = builder.rows[index]!;
    const isCardOuter = row.messageId === opts.id || row.messageId === opts.id + '-top' || row.messageId === opts.id + '-bottom';
    // The card's own header (name, title, status, arrow, stop) highlights in the actor's color, not the hosting surface's.
    const isHeader = isCardOuter || row.messageId === opts.id + '-status' || row.messageId === opts.id + '-task';
    builder.rows[index] = {
      ...row,
      ...(isHeader ? {hoverColor: role.color} : {}),
      hits: [...row.hits ?? [], {startCol: builder.baseGutterCols, endCol: builder.width, action}],
      animation: {
        ...row.animation,
        ...(isCardOuter && cardBg ? {actorBg: cardBg} : {}),
        actorColor: role.color,
        active: isCardOuter ? (opts.active ?? false) : (row.animation?.active ?? false),
        open: opts.open,
        frames: role.thinkingAnimation,
      },
    };
  }
  if (!opts.open) markHover(builder.rows, firstRow, opts.id, builder.baseGutterCols, builder.width);
}
