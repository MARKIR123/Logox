import stringWidth from 'string-width';
import type {PermissionRuleItem, PermissionsPageData} from '../../runtime/command-surface.js';
import {ageLabel, validateRuleInput} from '../../permissions/rule-input.js';
import {palette} from '../appearance/theme.js';
import {safeText, clipLine} from '../terminal/text.js';

/** One styled cell of a page row; the page draws rows and never interprets them. */
export interface EditorCell {readonly text: string; readonly color: string; readonly bold?: boolean; readonly bg?: string}
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

const decisionColor = (decision: PermissionRuleItem['decision']) => decision === 'allow' ? palette.success : decision === 'ask' ? palette.warning : palette.error;
function compactTokens(tokens: number): string {return tokens >= 1000 ? (tokens / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(tokens);}
const faint = () => palette.muted;
export interface EditorView {readonly rows: readonly EditorRow[]; /** Row index that must stay visible. */ readonly focusRow: number; readonly footer: string}

/** Mock section 3: mode selector, a rules list grouped by scope, and this run's approval statistics. */
export function permissionsView(data: PermissionsPageData, ui: PermissionsUi, columns: number, now = Date.now()): EditorView {
  const rows: EditorRow[] = [];
  const shown = ui.draftMode ?? data.mode.current, dirty = ui.draftMode !== undefined && ui.draftMode !== data.mode.current;
  rows.push([{text: 'Mode  ', color: palette.panelLabel}, ...data.mode.options.flatMap((option, index): EditorCell[] => [
    ...(index ? [{text: '   ', color: palette.fg}] : []),
    option.id === shown ? {text: ' ' + option.id + ' ', color: palette.selectionFg, bold: true, bg: palette.selectionBg} : {text: ' ' + option.id + ' ', color: palette.muted},
  ]), ...(dirty ? [{text: '  unsaved', color: palette.warning, bold: true}] : [])]);
  const consequence = data.mode.options.find(option => option.id === shown)?.description ?? '';
  rows.push([{text: '      ' + clipLine(consequence, Math.max(1, columns - 6)), color: palette.muted}]);
  rows.push([]);
  rows.push([{text: 'Rules', color: palette.fg, bold: true}, {text: '  ·  ' + data.rules.length, color: palette.muted}]);
  let focusRow = 0;
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
      rows.push([
        {text: active ? '  ❯ ' : '    ', color: active ? palette.accent : palette.muted},
        {text: rule.decision.padEnd(5), color: decisionColor(rule.decision), bold: true},
        {text: rule.tool + '  ', color: active ? palette.fg : palette.fg, bold: active},
        {text: clipLine(pattern, room), color: active ? palette.fg : palette.muted},
        {text: '  ' + stats, color: faint()},
        ...(confirming ? [{text: '  Delete this rule? y / n', color: palette.warning, bold: true}] : []),
      ]);
    }
  }
  if (data.rules.length) rows.push([{text: '  Deny wins over ask, ask over allow; shell patterns match static token prefixes, paths use * ** ?.', color: faint()}]);
  const form = ui.form;
  if (form) {
    const scopes = scopesFor(data);
    rows.push([]);
    rows.push([{text: 'New rule', color: palette.fg, bold: true}]);
    const field = (at: number, label: string, value: string, choice: boolean): EditorRow => [
      {text: form.field === at ? '  ❯ ' : '    ', color: form.field === at ? palette.accent : palette.muted},
      {text: label.padEnd(9), color: palette.panelLabel},
      choice ? {text: '‹ ' + value + ' ›', color: at === 0 ? decisionColor(DECISIONS[form.decision]!) : palette.fg, bold: true}
        : {text: value + (form.field === at ? '▌' : ''), color: palette.fg, bold: true},
    ];
    rows.push(field(0, 'Decision', DECISIONS[form.decision]!, true));
    rows.push(field(1, 'Tool', form.tool, false));
    rows.push(field(2, 'Pattern', form.pattern, false));
    rows.push(field(3, 'Scope', scopes[form.scope] ?? 'project', true));
    focusRow = rows.length - 4 + form.field;
    if (form.error) {rows.push([{text: '    ✗ ' + form.error, color: palette.error}]); focusRow = rows.length - 1;}
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
