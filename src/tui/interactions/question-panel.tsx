import {useEffect, useRef, useState} from 'react';
import {Box, Text, useCursor, useInput, usePaste} from 'ink';
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import {palette} from '../appearance/theme.js';
import {safeText, clipLine} from '../terminal/text.js';
import {useMouse} from '../terminal/mouse.js';
import {toggleColor, toggleMarker} from '../components/toggle-marker.js';
import {graphemes, insert, erase, move, moveToLineEdge, type Draft} from '../input/editor.js';

export interface PanelQuestion {
  readonly question: string;
  readonly header?: string;
  readonly detail?: string;
  readonly link?: string;
  readonly options?: readonly {readonly label: string; readonly description?: string}[];
  readonly multiSelect?: boolean;
  readonly hideCustomInput?: boolean;
  readonly defaultSelected?: readonly string[];
  readonly secret?: boolean;
  readonly inputLabel?: string;
  readonly allowEmpty?: boolean;
}
export interface QuestionSelection {readonly selected: readonly string[]; readonly custom?: string}
export interface QuestionPanelProps {
  readonly question: PanelQuestion;
  readonly position: number;
  readonly total: number;
  readonly answered: number;
  readonly width: number;
  readonly height: number;
  readonly y?: number;
  readonly initialDraft?: QuestionSelection;
  readonly onAnswer: (answer: QuestionSelection) => void;
  readonly onDraftChange?: ((draft: QuestionSelection) => void) | undefined;
  readonly onCancel: () => void;
  readonly onBack?: ((draft: QuestionSelection) => void) | undefined;
  readonly onForward?: ((draft: QuestionSelection) => void) | undefined;
  readonly collapsed?: boolean;
  readonly onToggleFold: () => void;
  readonly readClipboard?: (() => Promise<string | null>) | undefined;
}
interface Segment {text: string; color: string; bold?: boolean}
export interface QuestionRow {segments: readonly Segment[]; action?: 'fold' | 'input' | 'submit' | number}
export interface QuestionRowsInput {
  readonly question: PanelQuestion;
  readonly position: number;
  readonly total: number;
  readonly width: number;
  readonly height: number;
  readonly y: number;
  readonly focus: number;
  readonly checked: readonly number[];
  readonly text: string;
  readonly cursor: number;
  readonly attached?: string | null;
  readonly error?: string;
  readonly bodyOffset?: number;
  readonly canNavigate?: boolean;
  readonly foldAction?: boolean;
  readonly hint?: string;
}

function row(text: string, color: string, action?: QuestionRow['action']): QuestionRow {
  return {segments: [{text, color}], ...(action === undefined ? {} : {action})};
}
function wrapped(text: string, width: number): string[] {
  return wrapAnsi(safeText(text), Math.max(1, width), {hard: true, trim: false}).split('\n');
}

/** Content sections are budgeted before rendering; this function owns no mutable interaction state. */
export function buildQuestionRows(input: QuestionRowsInput): {rows: QuestionRow[]; caret?: {x: number; y: number}; bodyMaxOffset: number} {
  const {question, focus, checked} = input;
  const width = Math.max(1, Math.floor(input.width)), height = Math.max(1, Math.floor(input.height));
  const options = question.options ?? [];
  const hasInput = !question.hideCustomInput || !options.length;
  const title = safeText(question.header ?? 'Question');
  const counter = `${input.position}/${input.total}`;
  const fullTitle = ` ${title} · Question ${counter} `;
  const compactTitle = ` ${title} ${counter} `;
  const heading = stringWidth(fullTitle) + 2 <= width ? fullTitle : stringWidth(compactTitle) + 2 <= width ? compactTitle : ` ${counter} `;
  const header: QuestionRow = {segments: [
    {text: '─', color: palette.line},
    {text: clipLine(heading, Math.max(0, width - 1)), color: palette.accent},
    {text: '─'.repeat(Math.max(0, width - 1 - stringWidth(clipLine(heading, Math.max(0, width - 1))))), color: palette.line},
  ], ...(input.foldAction === false ? {} : {action: 'fold' as const})};
  if (height === 1) return {rows: [row('─'.repeat(width), palette.line)], bodyMaxOffset: 0};
  const body = [question.question, question.detail, question.link].filter((value): value is string => !!value).flatMap(value => wrapped(value, Math.max(1, width - 2)));
  const optionRows = options.map((option, index) => {
    const active = focus === index;
    const color = toggleColor(checked.includes(index), active);
    const marker = `${active ? '❯' : ' '} ${toggleMarker(checked.includes(index))} `;
    return {
      label: wrapped(option.label, Math.max(1, width - 6)).map((line, at) => row(clipLine((at ? '      ' : marker) + line, width), color, index)),
      detail: option.description ? wrapped(option.description, Math.max(1, width - 6)).map(line => row(clipLine('      ' + line, width), color, index)) : [],
    };
  });
  const hint = input.error || input.hint || `${question.multiSelect ? 'Space Toggle · ' : ''}Enter Submit${input.canNavigate ? ' · ←/→ Question' : ''} · Ctrl+K Fold · Esc Cancel`;
  const inputName = question.inputLabel ?? (question.secret ? 'Input' : 'My view');
  const attachment = input.attached ? ` (${safeText(input.attached)})` : '';
  // The input is a one-row, cursor-following viewport. Newlines remain intact in its draft.
  let prefix = `${focus === options.length ? '❯' : ' '} ${inputName}${attachment}: `;
  if (stringWidth(prefix) >= width) prefix = `${focus === options.length ? '❯' : ' '} ${inputName}: `;
  prefix = clipLine(prefix, Math.max(0, width - 1));
  const originalParts = graphemes(input.text);
  const displayParts = originalParts.map(part => question.secret ? '•'.repeat(Array.from(part).length) : part.replace(/\n/g, ' '));
  const cursor = Math.max(0, Math.min(displayParts.length, input.cursor));
  const textBudget = Math.max(0, width - stringWidth(prefix));
  let first = 0;
  while (first < cursor && stringWidth(displayParts.slice(first, cursor).join('')) >= textBudget && textBudget > 0) first++;
  const text = clipLine(displayParts.slice(first).join(''), textBudget);
  const inputRow = row(prefix + text, focus === options.length ? palette.accent : palette.fg, 'input');
  const targetOption = Math.max(0, Math.min(options.length - 1, focus < options.length ? focus : checked[0] ?? 0));

  // Roomy surfaces retain the section rhythm before spending rows on secondary text.
  // Compact surfaces instead spend their budget on controls rather than separators.
  let spacing = true, descriptions = true, detailLimit = Infinity, bodyCount = body.length, optionCount = options.length;
  const selectedStart = () => Math.max(0, Math.min(options.length - optionCount, targetOption - Math.floor(optionCount / 2)));
  const optionBlock = (index: number) => descriptions
    ? [...optionRows[index]!.label, ...optionRows[index]!.detail.slice(0, detailLimit)]
    : [optionRows[index]!.label[0]!];
  const measure = () => 2 + bodyCount + (hasInput ? 1 : 0) + (height >= 4 ? 1 : 0)
    + Array.from({length: optionCount}, (_, index) => optionBlock(selectedStart() + index).length).reduce((sum, length) => sum + length, 0)
    + (spacing ? optionCount + (hasInput ? 1 : 0) + (height >= 4 ? 1 : 0) : 0);
  if (height >= 16 && measure() > height) {
    detailLimit = 1;
    while (measure() > height && bodyCount > 1) bodyCount--;
    if (measure() > height) descriptions = false;
  }
  if (measure() > height) spacing = false;
  if (measure() > height) descriptions = false;
  while (measure() > height && bodyCount > 1) bodyCount--;
  while (measure() > height && optionCount > 1) optionCount--;
  while (measure() > height && bodyCount > 0) bodyCount--;
  if (measure() > height) optionCount = 0;
  const bodyMaxOffset = Math.max(0, body.length - bodyCount);
  const bodyOffset = Math.max(0, Math.min(bodyMaxOffset, input.bodyOffset ?? 0));
  const rows: QuestionRow[] = [header];
  for (const line of body.slice(bodyOffset, bodyOffset + bodyCount)) rows.push(row(clipLine(' ' + line, width), palette.fg));
  const blank = () => {if (spacing) rows.push(row('', palette.muted));};
  for (let index = selectedStart(); index < selectedStart() + optionCount; index++) {blank(); rows.push(...optionBlock(index));}
  let caret: {x: number; y: number} | undefined;
  if (hasInput && rows.length < height - 1) {
    blank();
    if (focus === options.length) caret = {x: Math.min(width - 1, stringWidth(prefix) + stringWidth(displayParts.slice(first, cursor).join(''))), y: Math.max(0, input.y + rows.length)};
    rows.push(inputRow);
  }
  if (height >= 4 && rows.length < height - 1) {blank(); rows.push(row(clipLine(hint, width), input.error ? palette.accent : palette.muted, 'submit'));}
  // A caller may offer fewer rows than the minimum editing surface; never exceed it.
  const trimmed = rows.slice(0, height - 1);
  trimmed.push(row('─'.repeat(width), palette.line));
  return {rows: trimmed, ...(caret && caret.y < input.y + trimmed.length - 1 ? {caret} : {}), bodyMaxOffset};
}

export function AnswerCaret({position}: {position: {x: number; y: number}}): null {
  const {setCursorPosition} = useCursor();
  // Ink consumes the requested caret while committing this render, before layout effects.
  // Register it with the rendered rows rather than leaving the next frame a stale request.
  setCursorPosition({x: Math.max(0, position.x), y: Math.max(0, position.y)});
  return null;
}

interface LocalAnswer {draft: Draft; checked: number[]; focus: number; error: string; bodyOffset: number}
function initialAnswer(question: PanelQuestion, initial?: QuestionSelection): LocalAnswer {
  const options = question.options ?? [];
  const selected = initial?.selected ?? question.defaultSelected ?? [];
  let checked = options.flatMap((option, index) => selected.includes(option.label) ? [index] : []);
  if (!question.multiSelect && options.length && !checked.length) checked = [0];
  const text = initial?.custom ?? '';
  return {draft: {text, cursor: graphemes(text).length}, checked, focus: checked[0] ?? (options.length ? 0 : options.length), error: '', bodyOffset: 0};
}

/** Standalone controller. Production hosts can call the pure planner while retaining keyboard ownership. */
export function QuestionPanel({question, position, total, width, height, y = 0, initialDraft, onAnswer, onDraftChange,
  onCancel, onBack, onForward, collapsed = false, onToggleFold, readClipboard}: QuestionPanelProps) {
  const [local, setLocal] = useState(() => initialAnswer(question, initialDraft));
  const current = useRef(local); current.current = local;
  const identity = useRef({question, position});
  const clipboardEpoch = useRef(0);
  const live = useRef(true);
  const options = question.options ?? [];
  const hasInput = !question.hideCustomInput || !options.length;
  const inputIndex = options.length;
  const selection = (state = current.current): QuestionSelection => ({selected: state.checked.map(index => options[index]!.label),
    ...(state.draft.text || !options.length || question.allowEmpty ? {custom: state.draft.text} : {})});
  const change = (state: LocalAnswer) => {current.current = state; setLocal(state); onDraftChange?.(selection(state));};
  useEffect(() => {
    if (identity.current.question !== question || identity.current.position !== position) {
      clipboardEpoch.current++; live.current = true;
      identity.current = {question, position};
      const next = initialAnswer(question, initialDraft); current.current = next; setLocal(next);
    }
  }, [question, position, initialDraft]);
  useEffect(() => () => {live.current = false; clipboardEpoch.current++;}, []);
  useEffect(() => {if (collapsed) clipboardEpoch.current++;}, [collapsed]);
  const invalidate = () => {clipboardEpoch.current++;};
  const submit = () => {
    const value = selection();
    if (!value.selected.length && !value.custom?.trim() && !question.allowEmpty) {
      change({...current.current, error: 'Type an answer or select an option'}); return;
    }
    invalidate(); onAnswer(value);
  };
  const type = (text: string) => {
    if (!hasInput) return;
    const next = insert(current.current.draft, text);
    if (Array.from(next.text).length > 8000) {change({...current.current, error: 'Answer maximum 8000 characters'}); return;}
    change({...current.current, draft: next, error: ''});
  };
  const focusOption = (index: number, toggle = false) => {
    const state = current.current;
    const checked = question.multiSelect ? toggle ? state.checked.includes(index) ? state.checked.filter(value => value !== index) : [...state.checked, index].sort((a, b) => a - b) : state.checked : [index];
    change({...state, focus: index, checked, error: ''});
  };
  const navigate = (forward: boolean) => {invalidate(); (forward ? onForward : onBack)?.(selection());};
  usePaste(text => {type(text);}, {isActive: !collapsed});
  useInput((text, key) => {
    if (key.eventType === 'release') return;
    if (key.ctrl && text.toLowerCase() === 'k') {invalidate(); onToggleFold(); return;}
    if (collapsed) return;
    if (key.escape) {invalidate(); live.current = false; onCancel(); return;}
    if ((key.ctrl || key.meta) && text.toLowerCase() === 'v' && readClipboard) {
      const epoch = ++clipboardEpoch.current;
      void readClipboard().then(value => {
        if (live.current && epoch === clipboardEpoch.current && value !== null) type(value);
      }).catch(() => {if (live.current && epoch === clipboardEpoch.current) change({...current.current, error: 'Clipboard unavailable'});});
      return;
    }
    if (key.return) {submit(); return;}
    const state = current.current;
    if (key.tab) {
      if (hasInput && state.focus < options.length) change({...state, focus: inputIndex});
      else if (options.length) focusOption(state.checked[0] ?? 0);
      return;
    }
    if (key.upArrow || key.downArrow) {
      const direction = key.downArrow ? 1 : -1;
      if (key.meta) {change({...state, bodyOffset: Math.max(0, Math.min(layout.bodyMaxOffset, state.bodyOffset + direction))}); return;}
      const next = Math.max(0, Math.min(options.length - (hasInput ? 0 : 1), state.focus + direction));
      if (next < options.length) focusOption(next); else change({...state, focus: inputIndex});
      return;
    }
    if (key.leftArrow || key.rightArrow) {
      const forward = !!key.rightArrow;
      if (state.focus < options.length || (forward ? state.draft.cursor === graphemes(state.draft.text).length : state.draft.cursor === 0)) {
        navigate(forward); return;
      }
      change({...state, draft: move(state.draft, forward ? 1 : -1)}); return;
    }
    if (key.home || key.end) {
      change({...state, draft: key.ctrl ? {...state.draft, cursor: key.end ? graphemes(state.draft.text).length : 0} : moveToLineEdge(state.draft, !!key.end, Math.max(1, width - 12))}); return;
    }
    if (key.backspace || key.delete) {change({...state, draft: erase(state.draft, !!key.backspace), error: ''}); return;}
    if (text === ' ' && question.multiSelect && state.focus < options.length) {focusOption(state.focus, true); return;}
    if (text && !key.ctrl && !key.meta && !/\[<\d+;/.test(text)) type(text);
  });
  const state = identity.current.question === question && identity.current.position === position ? local : initialAnswer(question, initialDraft);
  const layout = buildQuestionRows({question, position, total, width, height, y, focus: state.focus, checked: state.checked,
    text: state.draft.text, cursor: state.draft.cursor, attached: !question.multiSelect && state.focus < options.length && state.draft.text ? options[state.focus]?.label ?? null : null,
    error: state.error, bodyOffset: state.bodyOffset, canNavigate: !!onBack || !!onForward});
  useMouse(event => {
    if (event.x < 0 || event.x >= width || event.y < y || event.y >= y + (collapsed ? 1 : layout.rows.length)) return;
    if (event.action === 'wheel_up' || event.action === 'wheel_down') {
      if (!collapsed) change({...current.current, bodyOffset: Math.max(0, Math.min(layout.bodyMaxOffset, current.current.bodyOffset + (event.action === 'wheel_up' ? -1 : 1)))});
      return;
    }
    if (event.action !== 'press' || event.button !== 0) return;
    const action = collapsed ? 'fold' : layout.rows[event.y - y]?.action;
    if (typeof action === 'number') focusOption(action, !!question.multiSelect);
    else if (action === 'fold') {invalidate(); onToggleFold();}
    else if (action === 'submit') submit();
    else if (action === 'input') change({...current.current, focus: inputIndex});
  });
  if (collapsed) return <Text color={palette.muted} wrap="truncate">{clipLine('Waiting for your answer · Ctrl+K Expand', Math.max(1, width))}</Text>;
  return <Box flexDirection="column" width={Math.max(1, width)}>
    {layout.rows.map((line, index) => <Box key={index} height={1} flexShrink={0} width={Math.max(1, width)}>
      <Text wrap="truncate">{line.segments.some(segment => segment.text.length > 0)
        ? line.segments.map((segment, at) => <Text key={at} color={segment.color} bold={!!segment.bold}>{segment.text}</Text>)
        : ' '}</Text>
    </Box>)}
    {layout.caret && <AnswerCaret position={layout.caret}/>}
  </Box>;
}
