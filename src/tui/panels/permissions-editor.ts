import stringWidth from 'string-width';
import type {PermissionRuleItem, PermissionsPageData} from '../../runtime/command-surface.js';
import {ageLabel, validateRuleInput} from '../../permissions/rule-input.js';
import {palette} from '../appearance/theme.js';
import {safeText, clipLine} from '../terminal/text.js';

/** One styled cell of a page row; the page draws rows and never interprets them. */
export interface EditorCell {readonly text: string; readonly color: string; readonly bold?: boolean; readonly bg?: string; /** What a click does; cells sharing one object hover together. */ readonly hit?: EditorClick}
/** Pointer intents of the page. Hit regions are derived from the rendered cells, never from separate geometry. */
export type EditorClick =
  | {readonly kind: 'mode'; readonly id: string}
  | {readonly kind: 'save-mode'}
  | {readonly kind: 'rule'; readonly index: number}
  | {readonly kind: 'delete'; readonly index: number}
  | {readonly kind: 'confirm'; readonly yes: boolean}
  | {readonly kind: 'add'}
  | {readonly kind: 'field'; readonly field: number; readonly delta?: number}
  | {readonly kind: 'submit'}
  | {readonly kind: 'cancel'};
export type EditorRow = readonly EditorCell[];
const DECISIONS = ['allow', 'ask', 'deny'] as const;
const SCOPES = ['project', 'user', 'session'] as const;
export interface RuleForm {readonly field: number; readonly decision: number; readonly tool: string; readonly pattern: string; readonly scope: number; readonly error: string}
export interface PermissionsUi {
  readonly draftMode?: string | undefined;
  readonly selected: number;
  /** Rule id waiting for an inline y/n. */
  readonly confirmDelete?: string | undefined;
  readonly form?: RuleForm | undefined;
  readonly error: string;
}
export const initialPermissionsUi: PermissionsUi = {selected: 0, error: ''};
export interface EditorKey {readonly return?: boolean; readonly escape?: boolean; readonly tab?: boolean; readonly shift?: boolean; readonly upArrow?: boolean; readonly downArrow?: boolean;
  readonly leftArrow?: boolean; readonly rightArrow?: boolean; readonly delete?: boolean; readonly backspace?: boolean; readonly ctrl?: boolean; readonly meta?: boolean}
export interface EditorStep {readonly ui: PermissionsUi; /** Action for `onAction` (`set_mode:`, `delete_rule:`, `add_rule:`). */ readonly action?: string; /** The key was consumed (Esc is not when nothing is open). */ readonly handled: boolean}
const cycle = (value: number, length: number, delta: number) => (value + delta + length) % length;
const scopesFor = (data: PermissionsPageData) => SCOPES.filter(scope => scope !== 'user' || data.userScope);
const newForm = (): RuleForm => ({field: 0, decision: 0, tool: '', pattern: '', scope: 0, error: ''});
/** The rule currently selected, clamped to the list. */
export const selectedRule = (data: PermissionsPageData, ui: PermissionsUi): PermissionRuleItem | undefined => data.rules[Math.min(ui.selected, data.rules.length - 1)];
const FIELD_COUNT = 4;

/** Keyboard model of the /permissions page; pure so that every behaviour is testable without a terminal. */
export function reducePermissions(data: PermissionsPageData, ui: PermissionsUi, input: string, key: EditorKey): EditorStep {
  const form = ui.form;
  if (form) {
    const scopes = scopesFor(data);
    if (key.escape) return {ui: {...ui, form: undefined}, handled: true};
    if (key.return) {
      const checked = validateRuleInput({decision: DECISIONS[form.decision]!, tool: form.tool, pattern: form.pattern, scope: scopes[form.scope] ?? 'project'}, data.userScope);
      if (!checked.ok) return {ui: {...ui, form: {...form, error: checked.error}}, handled: true};
      return {ui: {...ui, form: undefined, error: ''}, action: 'add_rule:' + JSON.stringify(checked.rule), handled: true};
    }
    const move = (delta: number): EditorStep => ({ui: {...ui, form: {...form, field: cycle(form.field, FIELD_COUNT, delta), error: ''}}, handled: true});
    if (key.tab) return move(key.shift ? -1 : 1);
    if (key.downArrow) return move(1);
    if (key.upArrow) return move(-1);
    const choice = form.field === 0 || form.field === 3;
    if (choice && (key.leftArrow || key.rightArrow || input === ' ')) {
      const delta = key.leftArrow ? -1 : 1;
      return {ui: {...ui, form: form.field === 0 ? {...form, decision: cycle(form.decision, DECISIONS.length, delta), error: ''} : {...form, scope: cycle(form.scope, scopes.length, delta), error: ''}}, handled: true};
    }
    if (!choice) {
      const name = form.field === 1 ? 'tool' : 'pattern';
      if (key.backspace || key.delete) return {ui: {...ui, form: {...form, [name]: [...form[name]].slice(0, -1).join(''), error: ''}}, handled: true};
      if (input && !key.ctrl && !key.meta && !key.leftArrow && !key.rightArrow) {
        const text = (form[name] + input.replace(/[\r\n\t]/g, '')).slice(0, 2000);
        return {ui: {...ui, form: {...form, [name]: text, error: ''}}, handled: true};
      }
    }
    return {ui, handled: true};
  }
  if (ui.confirmDelete) {
    if (input === 'y' || input === 'Y' || key.return) return {ui: {...ui, confirmDelete: undefined, error: ''}, action: 'delete_rule:' + ui.confirmDelete, handled: true};
    return {ui: {...ui, confirmDelete: undefined}, handled: true};
  }
  const ids = data.mode.options.map(option => option.id), shown = ui.draftMode ?? data.mode.current;
  const step = key.leftArrow ? -1 : key.rightArrow || input === ' ' || input === 'm' || input === 'M' ? 1 : 0;
  if (step && ids.length) {
    const next = ids[cycle(Math.max(0, ids.indexOf(shown)), ids.length, step)]!;
    return {ui: {...ui, draftMode: next === data.mode.current ? undefined : next, error: ''}, handled: true};
  }
  if (key.return) return ui.draftMode && ui.draftMode !== data.mode.current ? {ui, action: 'set_mode:' + ui.draftMode, handled: true} : {ui, handled: true};
  if (key.upArrow || key.downArrow) {
    const last = Math.max(0, data.rules.length - 1);
    return {ui: {...ui, selected: Math.max(0, Math.min(last, Math.min(ui.selected, last) + (key.upArrow ? -1 : 1)))}, handled: true};
  }
  if (input === 'a' || input === 'A') return {ui: {...ui, form: newForm(), error: ''}, handled: true};
  if ((input === 'd' || input === 'D' || key.delete) && data.rules.length) {
    const rule = selectedRule(data, ui)!;
    return {ui: {...ui, confirmDelete: rule.id, error: ''}, handled: true};
  }
  return {ui, handled: false};
}

/** Mouse model of the page: each click maps onto the same transitions the keyboard takes. */
export function reduceClick(data: PermissionsPageData, ui: PermissionsUi, click: EditorClick): EditorStep {
  const none: EditorStep = {ui, handled: true};
  if (click.kind === 'submit') return reducePermissions(data, ui, '', {return: true});
  if (click.kind === 'cancel') return reducePermissions(data, ui, '', {escape: true});
  if (click.kind === 'confirm') return ui.confirmDelete ? reducePermissions(data, ui, click.yes ? 'y' : 'n', {}) : none;
  if (ui.form) {
    if (click.kind !== 'field') return none;
    const form = {...ui.form, field: click.field, error: ''};
    if (!click.delta) return {ui: {...ui, form}, handled: true};
    const scopes = scopesFor(data);
    return {ui: {...ui, form: click.field === 0 ? {...form, decision: cycle(form.decision, DECISIONS.length, click.delta)}
      : click.field === 3 ? {...form, scope: cycle(form.scope, scopes.length, click.delta)} : form}, handled: true};
  }
  const base: PermissionsUi = {...ui, confirmDelete: undefined};
  switch (click.kind) {
    case 'mode': return {ui: {...base, draftMode: click.id === data.mode.current ? undefined : click.id, error: ''}, handled: true};
    case 'save-mode': return reducePermissions(data, base, '', {return: true});
    case 'rule': return {ui: {...base, selected: Math.max(0, Math.min(data.rules.length - 1, click.index))}, handled: true};
    case 'delete': {
      const rule = data.rules[click.index];
      return rule ? {ui: {...base, selected: click.index, confirmDelete: rule.id, error: ''}, handled: true} : none;
    }
    case 'add': return {ui: {...base, form: newForm(), error: ''}, handled: true};
    default: return none;
  }
}

const decisionColor =(decision: PermissionRuleItem['decision']) => decision === 'allow' ? palette.success : decision === 'ask' ? palette.warning : palette.error;
function compactTokens(tokens: number): string {return tokens >= 1000 ? (tokens / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(tokens);}
const faint = () => palette.muted;
export interface EditorView {readonly rows: readonly EditorRow[]; /** Row index that must stay visible. */ readonly focusRow: number; readonly footer: string}

/** Mock section 3: mode selector, a rules list grouped by scope, and this run's approval statistics. */
export function permissionsView(data: PermissionsPageData, ui: PermissionsUi, columns: number, now = Date.now()): EditorView {
  const rows: EditorRow[] = [];
  const shown = ui.draftMode ?? data.mode.current, dirty = ui.draftMode !== undefined && ui.draftMode !== data.mode.current;
  rows.push([{text: 'Mode  ', color: palette.panelLabel}, ...data.mode.options.flatMap((option, index): EditorCell[] => [
    ...(index ? [{text: '   ', color: palette.fg}] : []),
    option.id === shown ? {text: ' ' + option.id + ' ', color: palette.selectionFg, bold: true, bg: palette.selectionBg, hit: {kind: 'mode', id: option.id}} : {text: ' ' + option.id + ' ', color: palette.muted, hit: {kind: 'mode', id: option.id}},
  ]), ...(dirty ? [{text: '  unsaved', color: palette.warning, bold: true, hit: {kind: 'save-mode'} as const}] : [])]);
  const consequence = data.mode.options.find(option => option.id === shown)?.description ?? '';
  rows.push([{text: '      ' + clipLine(consequence, Math.max(1, columns - 6)), color: palette.muted}]);
  rows.push([]);
  rows.push([{text: 'Rules', color: palette.fg, bold: true}, {text: '  ·  ' + data.rules.length, color: palette.muted}]);
  let focusRow = 0;
  rows.push([{text: '  + Add rule', color: palette.accent, hit: {kind: 'add'}}, {text: '  (a)', color: faint()}]);
  if (!data.rules.length) rows.push([{text: '  No rules yet. Press a to add one, or choose "Always allow" on an approval card.', color: palette.muted}]);
  const selectedIndex = Math.min(ui.selected, data.rules.length - 1);
  for (const scope of SCOPES) {
    const group = data.rules.filter(rule => rule.scope === scope);
    if (!group.length) continue;
    rows.push([{text: '  ' + scope, color: palette.panelLabel}]);
    for (const rule of group) {
      const at = data.rules.indexOf(rule), active = at === selectedIndex, stats = rule.hits ? rule.hits + ' hit' + (rule.hits === 1 ? '' : 's') + ' · ' + ageLabel(rule.lastHit, now) : 'no hits';
      const confirming = ui.confirmDelete === rule.id;
      const pattern = safeText(rule.pattern), room = Math.max(8, columns - 4 - 6 - stringWidth(rule.tool) - 2 - stringWidth(stats) - 2);
      if (active) focusRow = rows.length;
      const hit: EditorClick = {kind: 'rule', index: at};
      rows.push([
        {text: active ? '  ❯ ' : '    ', color: active ? palette.accent : palette.muted, hit},
        {text: rule.decision.padEnd(5), color: decisionColor(rule.decision), bold: true, hit},
        {text: rule.tool + '  ', color: palette.fg, bold: active, hit},
        {text: clipLine(pattern, room), color: active ? palette.fg : palette.muted, hit},
        {text: '  ' + stats, color: faint(), hit},
        ...(confirming ? [{text: '  Delete this rule? ', color: palette.warning, bold: true}, {text: 'y', color: palette.warning, bold: true, hit: {kind: 'confirm', yes: true} as const},
          {text: ' / ', color: palette.warning, bold: true}, {text: 'n', color: palette.warning, bold: true, hit: {kind: 'confirm', yes: false} as const}]
          : active ? [{text: '  [Delete]', color: palette.muted, hit: {kind: 'delete', index: at} as const}] : []),
      ]);
    }
  }
  if (data.rules.length) rows.push([{text: '  Deny wins over ask, ask over allow; shell patterns match static token prefixes, paths use * ** ?.', color: faint()}]);
  const form = ui.form;
  if (form) {
    const scopes = scopesFor(data);
    rows.push([]);
    rows.push([{text: 'New rule', color: palette.fg, bold: true}]);
    const field = (at: number, label: string, value: string, choice: boolean): EditorRow => {
      const focus: EditorClick = {kind: 'field', field: at}, color = at === 0 ? decisionColor(DECISIONS[form.decision]!) : palette.fg;
      return [
        {text: form.field === at ? '  ❯ ' : '    ', color: form.field === at ? palette.accent : palette.muted, hit: focus},
        {text: label.padEnd(9), color: palette.panelLabel, hit: focus},
        ...(choice ? [{text: '‹ ', color, bold: true, hit: {kind: 'field', field: at, delta: -1} as const}, {text: value, color, bold: true, hit: {kind: 'field', field: at, delta: 1} as const},
          {text: ' ›', color, bold: true, hit: {kind: 'field', field: at, delta: 1} as const}]
          : [{text: value + (form.field === at ? '▌' : ''), color: palette.fg, bold: true, hit: focus}]),
      ];
    };
    rows.push(field(0, 'Decision', DECISIONS[form.decision]!, true));
    rows.push(field(1, 'Tool', form.tool, false));
    rows.push(field(2, 'Pattern', form.pattern, false));
    rows.push(field(3, 'Scope', scopes[form.scope] ?? 'project', true));
    focusRow = rows.length - 4 + form.field;
    if (form.error) {rows.push([{text: '    ✗ ' + form.error, color: palette.error}]); focusRow = rows.length - 1;}
    rows.push([{text: '    ', color: palette.fg}, {text: '[ Add ]', color: palette.accent, bold: true, hit: {kind: 'submit'}}, {text: '  ', color: palette.fg}, {text: '[ Cancel ]', color: palette.muted, hit: {kind: 'cancel'}}]);
  }
  rows.push([]);
  const s = data.stats;
  rows.push([{text: 'This run', color: palette.fg, bold: true}, {text: '  ·  ' + s.approvals + ' approval' + (s.approvals === 1 ? '' : 's') + '  ·  ' + s.asked + ' asked you  ·  ' + s.reviewed + ' by review model  ·  ' + compactTokens(s.tokens) + ' tokens', color: palette.muted}]);
  if (ui.error) rows.push([{text: '▲ ' + ui.error, color: palette.error}]);
  const footer = form ? 'Tab / ↑↓ Field · ←→ Choose · type to edit · Enter Add · Esc Cancel'
    : ui.confirmDelete ? 'y Delete · any other key Cancel'
    : dirty ? 'Enter Save mode · ←→ Change · Esc Discard'
    : '←→ Mode · ↑↓ Rule · a Add · d / Del Delete · Esc Back';
  return {rows, focusRow, footer};
}
