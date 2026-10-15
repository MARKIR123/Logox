/** 命令界面只传公开数据；认证与业务回调不进入快照。 */
export interface PickerItem {readonly id: string; readonly label: string; readonly description?: string; readonly disabled?: boolean; readonly deletable?: boolean; readonly color?: string}
export interface CommandToggle {readonly id: string; readonly label?: string; readonly enabled: boolean}
export interface CommandTab {readonly id: string; readonly title: string; readonly lines: readonly string[]; readonly toggles?: readonly CommandToggle[]; readonly color?: string}
export type CommandSurface =
  | {readonly id: string; readonly kind: 'picker'; readonly title: string; readonly description: string;
      readonly items: readonly PickerItem[]; readonly current: string; readonly status: 'loading' | 'ready' | 'saving'; readonly error: string; readonly deleteLabel?: string}
  | {readonly id: string; readonly kind: 'page'; readonly title: string; readonly tabs: readonly CommandTab[]; readonly initialTab: string;
      readonly saving?: boolean; readonly error?: string};
export interface CommandResult {readonly message?: string}
