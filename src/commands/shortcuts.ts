import type {TabRow} from '../runtime/command-surface.js';
import {row} from './tab-rows.js';

/** Every key binding and mouse gesture, grouped; the `Shortcuts` page of /settings is read-only until rebinding exists. */
export const shortcutGroups: readonly {readonly title: string; readonly items: readonly (readonly [keys: string, action: string])[]}[] = [
  {title: 'Composer', items: [
    ['Enter', 'Send (or newline with Enter key: newline)'], ['Shift+Enter, Alt+Enter, Ctrl+J', 'New line'], ['Ctrl+Enter, Ctrl+S', 'Send when Enter key is newline'],
    ['Up / Down', 'Input history at the first / last line'], ['Tab', 'Complete a command or move focus'], ['Ctrl+A / Ctrl+X / Ctrl+C', 'Select all / cut / copy'],
    ['Ctrl+U / Ctrl+K / Ctrl+W', 'Delete to line start / line end / previous word'], ['Ctrl+Left / Ctrl+Right', 'Jump by word'], ['Ctrl+V, Alt+V', 'Paste'],
  ]},
  {title: 'Running work', items: [
    ['Esc', 'Stop the Director loop (after closing menus and selections)'], ['Ctrl+T', 'Send the latest queued message now, or steer with a draft'],
    ['Ctrl+N', 'Select the next card or activity'], ['Ctrl+O', 'Expand or fold the selected card'], ['Ctrl+Enter', 'Open the selected actor window'],
    ['Ctrl+G', 'Next actor window'], ['Esc (actor window)', 'Back to the main window'], ['Ctrl+E', 'Back to the bottom and follow output'],
  ]},
  {title: 'Questions and approvals', items: [
    ['Up / Down, Enter', 'Choose and confirm'], ['y / n', 'Approve once / deny with a note'], ['Ctrl+P', 'Next pending request'],
    ['Ctrl+K', 'Fold or unfold the question panel'], ['Ctrl+X', 'Cancel the focused request'], ['Esc', 'Answer later'],
  ]},
  {title: 'Pages and pickers', items: [
    ['Up / Down, Left / Right', 'Move, change a value'], ['Enter', 'Save or confirm'], ['/', 'Search (in /settings)'], ['Esc', 'Back or discard'],
    ['Tab / Shift+Tab', 'Switch tabs or provider'], ['Ctrl+X', 'Delete the selected item where offered'],
  ]},
  {title: 'Application', items: [['Ctrl+C', 'Copy the selection; twice within 1.5 s to quit'], ['Ctrl+D', 'Quit now']]},
  {title: 'Mouse', items: [
    ['Click', 'Select or activate; cards fold and unfold'], ['Hover', 'Highlight in the window actor colour'], ['Wheel', 'Scroll, or move the selection on pages'],
    ['Double-click an actor card', 'Open that actor window'], ['Drag', 'Select text; it is copied on release'],
  ]},
];

export function shortcutRows(): TabRow[] {
  const rows: TabRow[] = [row.muted('Read-only for now: rebinding keys is planned.'), row.blank()];
  for (const group of shortcutGroups) {
    if (rows.length > 2) rows.push(row.blank());
    rows.push(row.heading(group.title));
    for (const [keys, action] of group.items) rows.push(row.field(keys, action));
  }
  return rows;
}
