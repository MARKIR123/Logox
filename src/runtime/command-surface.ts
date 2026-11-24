import type {SystemPresentation} from './system-events.js';
import type {StatusbarAppearance} from '../config/statusbar-preferences.js';
import type {StageStatus} from './stage-status.js';
import type {EnsembleData} from './ensemble-view.js';

/** The command surface carries public data only; credentials and business callbacks never enter the snapshot. */
export interface PickerItem {readonly id: string; readonly label: string; readonly description?: string | undefined; readonly disabled?: boolean | undefined; readonly deletable?: boolean | undefined; readonly color?: string | undefined; readonly effort?: string | undefined; readonly effortLevels?: readonly string[] | undefined; readonly group?: string | undefined;
  /** A second, muted line under the row (a record's description); rows of such a list take two lines. */
  readonly detail?: string | undefined;
  /** `warning` draws the right-hand text in the warning colour (a value that needs attention). */
  readonly valueTone?: 'warning' | undefined;
  /** A model row: `markKey` (`<provider>/<model>`) names what the marks edit; `marks` are drawn at the end of the row and filtered by the list's filter row. */
  readonly markKey?: string | undefined;
  readonly marks?: ItemMarks | undefined}
/** The tier (1 to 4) and vision mark of a model row; `derived` marks values the runtime guessed (drawn muted) as against values the user set. */
export interface ItemMarks {readonly tier: 1 | 2 | 3 | 4; readonly vision: boolean; readonly derived: {readonly tier: boolean; readonly vision: boolean}}
/** An edit of one model's marks made in a picker: set the tier, set the vision mark, or return to the derived values. */
export type MarkChange = {readonly tier: 1 | 2 | 3 | 4} | {readonly vision: boolean} | {readonly clear: true};
export interface CommandToggle {readonly id: string; readonly label?: string | undefined; readonly enabled: boolean; readonly value?: string | undefined; readonly options?: readonly string[] | undefined}
/** Structured page row. Producers choose the kind; the renderer wraps words with a hanging indent and draws rules to the page width. */
export type TabRow =
  | {readonly kind: 'heading'; readonly text: string}
  | {readonly kind: 'field'; readonly label: string; readonly value: string; readonly tone?: 'muted' | undefined}
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
/** A footer action of a tab: a key press or a click sends `id` through `onTabAction`. */
export interface TabAction {readonly id: string; readonly label: string; readonly key: string}
export interface CommandTab {readonly id: string; readonly title: string; readonly lines: readonly string[]; readonly rows?: readonly TabRow[] | undefined;
  readonly actions?: readonly TabAction[] | undefined;
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
      /** The row highlighted when the list opens, without the `current` mark (a page that reopens on the row it just changed). */
      readonly focus?: string;
      readonly effort?: string; readonly effortLevels?: readonly string[]}
  | {readonly id: string; readonly kind: 'result'; readonly title: string; readonly text: string; readonly lines?: readonly ResultLine[];
      /** The text is Markdown and is laid out as such (`/team` post detail); copy keeps the source text. */
      readonly markdown?: true}
  /** The lightbox over one image file (PNG or JPEG), opened by a click on a preview in the timeline. */
  | {readonly id: string; readonly kind: 'image'; readonly title: string; readonly path: string}
  | {readonly id: string; readonly kind: 'settings'; readonly title: string; readonly items: readonly SettingsItem[]; readonly pages: readonly SettingsPageLink[];
      readonly saving?: boolean; readonly error?: string; readonly sub?: SettingsSubPage;
      /** The /theme page opened from the Theme row; it draws over the settings and Esc returns to them. */
      readonly theme?: ThemePageData}
  | ({readonly id: string; readonly kind: 'theme'; readonly title: string} & ThemePageData)
  | {readonly id: string; readonly kind: 'ensemble'; readonly title: string; readonly data: EnsembleData}
  | {readonly id: string; readonly kind: 'page'; readonly title: string; readonly tabs: readonly CommandTab[]; readonly initialTab: string;
      readonly saving?: boolean; readonly error?: string;
      /** An action waiting for an inline yes/no on this page (for example entering creative mode). */
      readonly confirm?: {readonly tabId: string; readonly action: string; readonly prompt: string}});
/** One row of the /settings page as the renderer sees it (public data only; hooks stay in the application). */
export interface SettingsItem {
  readonly key: string; readonly label: string; readonly description: string; readonly group: string;
  readonly kind: 'boolean' | 'select' | 'number' | 'text';
  readonly options: readonly string[]; readonly labels?: Readonly<Record<string, string>> | undefined;
  readonly min?: number | undefined; readonly max?: number | undefined; readonly step?: number | undefined;
  /** The saved value; the page keeps unsaved drafts itself. */
  readonly value: string | number | boolean;
}
/** A row that opens a sub-page (Theme, Status bar, Permissions, Models & pricing, Shortcuts). `group` places it among the rows of that group; `value` is shown before the arrow. */
export interface SettingsPageLink {readonly id: string; readonly label: string; readonly description: string; readonly group?: string | undefined; readonly value?: string | undefined}
/** One row of the /theme list: a usable theme, or a file that failed to load (`unavailable` carries the reason). */
export interface ThemeRow {readonly name: string; readonly source: 'shipped' | 'user'; readonly unavailable?: string | undefined}
/** Data of the /theme page: the rows, the saved theme (marked in the list) and per-theme background overrides. */
export interface ThemePageData {readonly themes: readonly ThemeRow[]; readonly current: string; readonly backgrounds?: Readonly<Record<string, boolean>> | undefined; readonly saving?: boolean; readonly error?: string}
/** A page opened from /settings; it draws over the settings page and Esc returns to it. */
export interface SettingsSubPage {
  readonly id: string; readonly title: string; readonly tabs: readonly CommandTab[]; readonly initialTab: string;
  readonly saving?: boolean; readonly error?: string; readonly confirm?: {readonly tabId: string; readonly action: string; readonly prompt: string} | undefined;
}
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
