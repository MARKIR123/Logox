import type {SystemPresentation} from './system-events.js';
import type {StatusbarAppearance} from '../config/statusbar-preferences.js';
import type {StageStatus} from './stage-status.js';

/** The command surface carries public data only; credentials and business callbacks never enter the snapshot. */
export interface PickerItem {readonly id: string; readonly label: string; readonly description?: string | undefined; readonly disabled?: boolean | undefined; readonly deletable?: boolean | undefined; readonly color?: string | undefined; readonly effort?: string | undefined; readonly effortLevels?: readonly string[] | undefined; readonly group?: string | undefined}
export interface CommandToggle {readonly id: string; readonly label?: string | undefined; readonly enabled: boolean; readonly value?: string | undefined; readonly options?: readonly string[] | undefined}
/** Structured page row. Producers choose the kind; the renderer wraps words with a hanging indent and draws rules to the page width. */
export type TabRow =
  | {readonly kind: 'heading'; readonly text: string}
  | {readonly kind: 'field'; readonly label: string; readonly value: string}
  | {readonly kind: 'text'; readonly text: string; readonly tone?: 'muted' | undefined; readonly indent?: number | undefined}
  | {readonly kind: 'rule'; readonly title?: string | undefined}
  | {readonly kind: 'blank'};
export type TabLine = string | TabRow;
/** One permission rule as the /permissions page shows it. */
export interface PermissionRuleItem {readonly id: string; readonly scope: 'user' | 'project' | 'session'; readonly decision: 'allow' | 'ask' | 'deny';
  readonly tool: string; readonly pattern: string; readonly hits: number; readonly lastHit?: number | undefined}
/** Data of the interactive /permissions page: a mode selector, an editable rule list and this run's approval statistics. */
export interface PermissionsPageData {
  readonly mode: {readonly current: string; readonly options: readonly {readonly id: string; readonly description: string}[]};
  readonly rules: readonly PermissionRuleItem[];
  readonly stats: {readonly approvals: number; readonly asked: number; readonly reviewed: number; readonly tokens: number};
  /** False when the user-global rule file is not wired (tests); the add form then offers only project and session. */
  readonly userScope: boolean;
}
export interface CommandTab {readonly id: string; readonly title: string; readonly lines: readonly string[]; readonly rows?: readonly TabRow[] | undefined;
  /** Interactive permissions page; actions are `set_mode:<id>`, `delete_rule:<id>` and `add_rule:<json>`. */
  readonly permissions?: PermissionsPageData | undefined;
  /** Permission-mode editor: the page cycles a local draft; Enter sends `set_mode:<id>`, Esc discards it. */
  readonly mode?: {readonly current: string; readonly options: readonly {readonly id: string; readonly description: string}[]} | undefined; readonly toggles?: readonly CommandToggle[] | undefined; readonly color?: string | undefined; readonly statusbar?: {readonly appearance: StatusbarAppearance; readonly status: StageStatus} | undefined}
/** Semantic tone of one styled result line; the renderer maps it to palette colours. */
export type ResultTone = 'title' | 'strong' | 'pass' | 'warn' | 'fail' | 'muted';
export interface ResultLine {readonly text: string; readonly tone?: ResultTone | undefined}
export interface CommandOrigin {readonly sessionId: string; readonly ownerId: string}
export type CommandSurface = Partial<CommandOrigin> & (
  | {readonly id: string; readonly kind: 'picker'; readonly title: string; readonly description: string;
      readonly items: readonly PickerItem[]; readonly current: string; readonly status: 'loading' | 'ready' | 'saving'; readonly error: string; readonly deleteLabel?: string; readonly emptyText?: string;
      readonly effort?: string; readonly effortLevels?: readonly string[]}
  | {readonly id: string; readonly kind: 'result'; readonly title: string; readonly text: string; readonly lines?: readonly ResultLine[]}
  | {readonly id: string; readonly kind: 'page'; readonly title: string; readonly tabs: readonly CommandTab[]; readonly initialTab: string;
      readonly saving?: boolean; readonly error?: string;
      /** An action waiting for an inline yes/no on this page (for example entering creative mode). */
      readonly confirm?: {readonly tabId: string; readonly action: string; readonly prompt: string}});
export interface CommandResult {
  readonly message?: string;
  readonly presentation?: SystemPresentation;
  readonly title?: string;
  readonly kind?: 'command_result' | 'command_error';
  /** Tab actions only: ask the page to confirm before running `action` (sent back through `onTabAction`). */
  readonly confirm?: {readonly action: string; readonly prompt: string};
  /** Tab actions only: dismiss the page after the action so the footer receipt is visible. */
  readonly close?: boolean;
}
