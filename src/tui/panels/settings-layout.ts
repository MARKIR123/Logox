import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import type {SettingsItem, SettingsPageLink} from '../../runtime/command-surface.js';
import {palette} from '../appearance/theme.js';
import {faintColor, mixHex} from '../appearance/colors.js';
import {clipLine} from '../terminal/text.js';
import {inRegion, type Pointer, type Region} from '../terminal/mouse.js';
import {panePadding, panelRows} from '../components/panel-frame.js';

/** The /settings page is drawn and hit-tested from this one plan: `settingsLayout` returns the styled rows and the regions they were built from. */
export type DraftValue = string | number | boolean;
export interface SettingsEntry {
  readonly kind: 'item' | 'page';
  readonly key: string; readonly label: string; readonly description: string; readonly group: string;
  readonly item?: SettingsItem;
}
export interface Seg {readonly text: string; readonly color: string; readonly bold?: boolean; readonly italic?: boolean; readonly bg?: string}
export type SettingsCommand =
  | {readonly kind: 'move'; readonly delta: number}
  | {readonly kind: 'select'; readonly index: number}
  | {readonly kind: 'change'; readonly index: number; readonly delta: -1 | 1}
  | {readonly kind: 'toggle'; readonly index: number}
  | {readonly kind: 'edit'; readonly index: number}
  | {readonly kind: 'open'; readonly index: number}
  | {readonly kind: 'search'}
  | {readonly kind: 'searchDone'}
  | {readonly kind: 'searchClear'}
  | {readonly kind: 'save'}
  | {readonly kind: 'discard'}
  | {readonly kind: 'confirm'; readonly yes: boolean};
export interface SettingsHit {readonly region: Region; readonly command: SettingsCommand}
export interface SettingsView {
  readonly drafts: Readonly<Record<string, DraftValue>>;
  readonly query: string; readonly searching: boolean;
  readonly selected: number; readonly scroll: number;
  /** Text being typed into a `text` row, when one is being edited. */
  readonly editing?: string | undefined;
  readonly confirming: boolean; readonly saving: boolean; readonly error: string; readonly notice: string;
}
export interface SettingsLayout {
  readonly entries: readonly SettingsEntry[];
  readonly dirty: number;
  /** Header row (title row of the frame) and its right-hand part. */
  readonly header: readonly Seg[];
  readonly rows: readonly (readonly Seg[])[];
  readonly hits: readonly SettingsHit[];
  readonly footer: {readonly text: string; readonly actions: readonly {readonly label: string; readonly command: SettingsCommand}[]};
  /** Normalised selection and scroll (the page stores them). */
  readonly selected: number; readonly scroll: number;
  readonly listRows: number;
}

export const widthTiers = {full: 100, arrows: 70} as const;
const ARROWS_ALWAYS = (columns: number) => columns >= widthTiers.arrows;

export function entryValue(entry: SettingsEntry, drafts: Readonly<Record<string, DraftValue>>): DraftValue | undefined {
  return entry.item ? (Object.hasOwn(drafts, entry.key) ? drafts[entry.key]! : entry.item.value) : undefined;
}
export function isDirty(entry: SettingsEntry, drafts: Readonly<Record<string, DraftValue>>): boolean {
  return Boolean(entry.item) && Object.hasOwn(drafts, entry.key) && drafts[entry.key] !== entry.item!.value;
}
/** Drafts that differ from the saved values, by key. */
export function changedDrafts(items: readonly SettingsItem[], drafts: Readonly<Record<string, DraftValue>>): Record<string, DraftValue> {
  const changed: Record<string, DraftValue> = {};
  for (const item of items) if (Object.hasOwn(drafts, item.key) && drafts[item.key] !== item.value) changed[item.key] = drafts[item.key]!;
  return changed;
}
export function valueText(item: SettingsItem, value: DraftValue): string {
  if (typeof value === 'boolean') return value ? '[✓]' : '[ ]';
  if (item.kind === 'text') return String(value);
  return item.labels?.[String(value)] ?? String(value);
}
/** The next draft for a step through a select, number or boolean row; selects wrap around, numbers stop at their bounds. */
export function stepValue(item: SettingsItem, value: DraftValue, delta: -1 | 1): DraftValue {
  if (item.kind === 'boolean') return delta > 0;
  if (item.kind === 'number') {
    const step = item.step ?? 1, min = item.min ?? -Infinity, max = item.max ?? Infinity;
    return Math.min(max, Math.max(min, Number(value) + delta * step));
  }
  if (item.kind === 'select' && item.options.length) {
    const at = item.options.indexOf(String(value));
    return item.options[(at + delta + item.options.length * 2) % item.options.length]!;
  }
  return value;
}
/** Entries in page order, filtered by `query` (every word must appear in the label, description or group). */
export function settingsEntries(items: readonly SettingsItem[], pages: readonly SettingsPageLink[], query: string): SettingsEntry[] {
  const all: SettingsEntry[] = [
    ...items.map(item => ({kind: 'item' as const, key: item.key, label: item.label, description: item.description, group: item.group, item})),
    ...pages.map(page => ({kind: 'page' as const, key: 'page:' + page.id, label: page.label, description: page.description, group: 'Pages'})),
  ];
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length ? all.filter(entry => words.every(word => (entry.label + ' ' + entry.description + ' ' + entry.group).toLowerCase().includes(word))) : all;
}

type HintPart = {readonly label: string; readonly command: SettingsCommand};
/** Footer hints for the selected entry; every label is a button. `index: -1` means the selected entry. */
function hintParts(entry: SettingsEntry | undefined, searching: boolean): HintPart[] {
  if (searching) return [{label: 'Enter done', command: {kind: 'searchDone'}}, {label: 'Esc clear', command: {kind: 'searchClear'}}];
  const parts: HintPart[] = [{label: '↑↓ choose', command: {kind: 'move', delta: 1}}];
  if (entry?.kind === 'page') parts.push({label: 'Enter open', command: {kind: 'open', index: -1}}, {label: 'Ctrl+S save', command: {kind: 'save'}});
  else if (entry?.item?.kind === 'text') parts.push({label: 'Enter edit', command: {kind: 'edit', index: -1}}, {label: 'Ctrl+S save', command: {kind: 'save'}});
  else parts.push({label: '←→ change', command: {kind: 'change', index: -1, delta: 1}}, {label: 'Enter save', command: {kind: 'save'}});
  parts.push({label: '/ search', command: {kind: 'search'}}, {label: 'Esc discard', command: {kind: 'discard'}});
  return parts;
}

/** The plan: styled body rows, header, footer and every click region, in screen cells for a page whose top rule is at row `y`. */
export function settingsLayout(input: {
  items: readonly SettingsItem[]; pages: readonly SettingsPageLink[]; view: SettingsView;
  width: number; height: number; y: number; pointer: Pointer | null; hoverColor: string;
}): SettingsLayout {
  const {items, pages, view, width, height, y, pointer, hoverColor} = input;
  const padding = panePadding(width), columns = Math.max(1, width - 2 * padding), frame = panelRows(height);
  const entries = settingsEntries(items, pages, view.query);
  const selected = Math.max(0, Math.min(entries.length - 1, view.selected)), entry = entries[selected];
  const dirty = items.filter(item => Object.hasOwn(view.drafts, item.key) && view.drafts[item.key] !== item.value).length;
  // One description row on a short page, two (wrapped) when the page is tall enough.
  const descriptionRows = frame.bodyHeight >= 12 ? 2 : frame.bodyHeight >= 4 ? 1 : 0, showDescription = descriptionRows > 0, listRows = Math.max(1, frame.bodyHeight - descriptionRows);
  const bodyY = y + frame.bodyY, faint = faintColor(), selectedBg = mixHex(hoverColor, palette.bg, 0.12);
  const hits: SettingsHit[] = [], rowWide: SettingsHit[] = [];

  // Group headings and entries in one list of body rows.
  type Line = {readonly kind: 'group'; readonly text: string} | {readonly kind: 'entry'; readonly index: number};
  const lines: Line[] = [];
  entries.forEach((item, index) => {
    if (index === 0 || entries[index - 1]!.group !== item.group) lines.push({kind: 'group', text: groupLabel(item.group)});
    lines.push({kind: 'entry', index});
  });
  const selectedLine = Math.max(0, lines.findIndex(line => line.kind === 'entry' && line.index === selected));
  const heading = selectedLine > 0 && lines[selectedLine - 1]?.kind === 'group' ? 1 : 0;
  let scroll = Math.max(0, Math.min(view.scroll, Math.max(0, lines.length - listRows)));
  if (selectedLine - heading < scroll) scroll = selectedLine - heading;
  if (selectedLine >= scroll + listRows) scroll = selectedLine - listRows + 1;
  scroll = Math.max(0, Math.min(scroll, Math.max(0, lines.length - listRows)));

  const arrows = ARROWS_ALWAYS(columns);
  const rows: Seg[][] = [];
  const pad = (text: string, bg?: string): Seg => ({text, color: palette.fg, ...(bg ? {bg} : {})});
  lines.slice(scroll, scroll + listRows).forEach((line, offset) => {
    const rowY = bodyY + offset;
    if (line.kind === 'group') {
      rows.push([pad(' '.repeat(padding)), {text: clipLine(line.text, columns), color: palette.muted, bold: true}]);
      return;
    }
    const index = line.index, current = entries[index]!, isSelected = index === selected, bg = isSelected ? selectedBg : undefined;
    const rowHover = !isSelected && pointer !== null && pointer.y === rowY && pointer.x >= 0 && pointer.x < width;
    const labelColor = isSelected ? palette.fg : rowHover ? hoverColor : palette.muted;
    const marker: Seg = {text: isSelected ? '❯ ' : '  ', color: hoverColor, bold: true, ...(bg ? {bg} : {})};
    // Value block on the right.
    const value = entryValue(current, view.drafts);
    const segs: Seg[] = [];
    let valueWidth = 0;
    const regionFor = (x0: number, x1: number): Region => ({y: rowY, x0, x1});
    const over = (region: Region) => inRegion(pointer, region);
    const right = padding + columns;
    if (current.kind === 'page') {
      valueWidth = 1;
      const region = regionFor(right - 1, right);
      segs.push({text: '›', color: isSelected ? hoverColor : over(region) ? hoverColor : palette.muted, bold: isSelected || over(region), ...(bg ? {bg} : {})});
    } else {
      const item = current.item!, dirtyRow = isDirty(current, view.drafts);
      const valueColor = dirtyRow ? palette.warning : palette.fg;
      if (item.kind === 'boolean') {
        valueWidth = 3;
        const region = regionFor(right - 3, right), hot = over(region);
        segs.push({text: valueText(item, value!), color: hot ? hoverColor : dirtyRow ? palette.warning : isSelected ? hoverColor : palette.fg, bold: isSelected || hot, ...(bg ? {bg} : {})});
        hits.push({region, command: {kind: 'toggle', index}});
      } else if (item.kind === 'text') {
        const editing = isSelected && view.editing !== undefined;
        const raw = editing ? view.editing! : String(value ?? '');
        const shown = editing ? raw + '▌' : raw || '(none)';
        const room = Math.max(4, Math.floor(columns / 2));
        const text = clipLine(shown, room);
        valueWidth = stringWidth(text);
        const region = regionFor(right - valueWidth, right);
        segs.push({text, color: editing ? hoverColor : !raw ? faint : dirtyRow ? palette.warning : palette.fg, bold: isSelected, italic: !raw && !editing, ...(bg ? {bg} : {})});
        hits.push({region, command: {kind: 'edit', index}});
      } else {
        const text = valueText(item, value!);
        const withArrows = arrows || isSelected;
        const valueW = stringWidth(text);
        valueWidth = valueW + (withArrows ? 4 : 0);
        const x0 = right - valueWidth;
        if (withArrows) {
          const dec = regionFor(x0, x0 + 1), inc = regionFor(right - 1, right);
          const hotDec = over(dec), hotInc = over(inc);
          segs.push({text: '‹', color: hotDec ? hoverColor : isSelected ? hoverColor : palette.muted, bold: isSelected || hotDec, ...(bg ? {bg} : {})});
          segs.push({text: ' ' + text + ' ', color: valueColor, bold: isSelected, ...(bg ? {bg} : {})});
          segs.push({text: '›', color: hotInc ? hoverColor : isSelected ? hoverColor : palette.muted, bold: isSelected || hotInc, ...(bg ? {bg} : {})});
          hits.push({region: dec, command: {kind: 'change', index, delta: -1}}, {region: inc, command: {kind: 'change', index, delta: 1}});
        } else segs.push({text, color: valueColor, ...(bg ? {bg} : {})});
      }
    }
    const labelRoom = Math.max(1, columns - 2 - valueWidth - 2);
    const label = clipLine(current.label, labelRoom);
    const gap = Math.max(1, columns - 2 - stringWidth(label) - valueWidth);
    rows.push([pad(' '.repeat(padding), bg), marker, {text: label, color: labelColor, bold: isSelected || rowHover, ...(bg ? {bg} : {})}, pad(' '.repeat(gap), bg), ...segs,
      pad(' '.repeat(padding), bg)]);
    rowWide.push({region: regionFor(0, width), command: current.kind === 'page' ? {kind: 'open', index} : {kind: 'select', index}});
  });
  while (rows.length < listRows) rows.push([pad(' ')]);

  // Description row (or the discard question) under the list.
  const descriptionY = bodyY + listRows;
  const footerActions: {label: string; command: SettingsCommand}[] = [];
  const extraHits: SettingsHit[] = [];
  if (showDescription) {
    if (view.confirming) {
      const prompt = 'Discard ' + dirty + ' unsaved ' + (dirty === 1 ? 'change' : 'changes') + '?  ';
      const yes = 'y Discard', no = 'n Keep editing', sep = ' · ';
      let x = padding + stringWidth(prompt);
      const yesRegion = {y: descriptionY, x0: x, x1: x + stringWidth(yes)}; x += stringWidth(yes) + stringWidth(sep);
      const noRegion = {y: descriptionY, x0: x, x1: x + stringWidth(no)};
      extraHits.push({region: yesRegion, command: {kind: 'confirm', yes: true}}, {region: noRegion, command: {kind: 'confirm', yes: false}});
      rows.push([pad(' '.repeat(padding)), {text: prompt, color: palette.warning, bold: true},
        {text: yes, color: inRegion(pointer, yesRegion) ? hoverColor : palette.warning, bold: true}, {text: sep, color: faint},
        {text: no, color: inRegion(pointer, noRegion) ? hoverColor : palette.muted, bold: inRegion(pointer, noRegion)}]);
    } else {
      const text = entry?.description ?? (entries.length ? '' : 'No setting matches "' + view.query + '".');
      const wrapped = wrapAnsi(text, columns, {hard: true, trim: true}).split(String.fromCharCode(10));
      const shown = wrapped.slice(0, descriptionRows);
      if (wrapped.length > descriptionRows) shown[descriptionRows - 1] = clipLine(shown[descriptionRows - 1]! + '…', columns);
      for (const line of shown) rows.push([pad(' '.repeat(padding)), {text: line, color: faint, italic: true}]);
    }
    while (rows.length < listRows + descriptionRows) rows.push([pad(' ')]);
  }

  const hints = view.confirming ? [{label: 'y Discard', command: {kind: 'confirm', yes: true} as SettingsCommand}, {label: 'n Keep editing', command: {kind: 'confirm', yes: false} as SettingsCommand}]
    : hintParts(entry, view.searching);
  const hintText = hints.map(part => part.label).join(' · ');
  footerActions.push(...hints.map(part => ({label: part.label, command: part.command})));
  const footerText = view.saving ? 'Saving…' : view.error || view.notice || hintText;

  // Header: `Settings · N unsaved` on the left, the search control on the right.
  const header: Seg[] = [{text: 'Settings', color: palette.fg, bold: true}];
  if (dirty > 0) header.push({text: ' · ', color: faint}, {text: dirty + ' unsaved', color: palette.warning, bold: true});
  const total = items.length + pages.length;
  if (columns >= widthTiers.arrows) {
    const searchText = view.searching || view.query ? '/' + view.query + (view.searching ? '▌' : '') : '/ search';
    const count = view.query ? '  ' + entries.length + '/' + total : '';
    const used = header.reduce((sum, seg) => sum + stringWidth(seg.text), 0), tail = clipLine(searchText + count, Math.max(0, columns - used - 2));
    const region = {y: y + 1, x0: padding + columns - stringWidth(tail), x1: padding + columns};
    header.push({text: ' '.repeat(Math.max(1, columns - used - stringWidth(tail))), color: palette.fg},
      {text: tail, color: view.searching || view.query ? hoverColor : inRegion(pointer, region) ? hoverColor : palette.muted, bold: Boolean(view.query) || view.searching || inRegion(pointer, region)});
    extraHits.push({region, command: {kind: 'search'}});
  }
  return {entries, dirty, header, rows, hits: [...extraHits, ...hits, ...rowWide], footer: {text: footerText, actions: footerActions}, selected, scroll, listRows};
}
export function groupLabel(group: string): string {return group.charAt(0).toUpperCase() + group.slice(1);}
