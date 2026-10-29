import {palette} from '../appearance/theme.js';

/** One fixed-width marker for every boolean / single-choice / multi-choice control. */
export function toggleMarker(checked: boolean): string {
  return checked ? '[■]' : '[ ]';
}

/** Focus wins; committed checks stay white rather than looking focused. */
export function toggleColor(checked: boolean, focused: boolean, disabled = false): string {
  return disabled ? palette.muted : focused ? palette.accent : checked ? palette.checkedFg : palette.muted;
}
