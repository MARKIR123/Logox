// One focused region at a time: the composer, the timeline (cards and scrolling) or the plan sidebar; a page, picker, login or other
// takeover surface has the screen while it is open and nothing else is focused, then the previous region is back when it closes (the
// state under it is never touched). Every region draws a focus chrome that eases between dim and active (`composer-fade.tsx`; the
// timeline's is the rail brightness in `terminal/terminal-plane.ts`; the sidebar reads `focusRegion(...) === 'sidebar'`).
export type FocusRegion = 'composer' | 'timeline' | 'sidebar';
export interface FocusFacts {
  /** `App`'s keyboard target: `question` and `stop` are controls inside timeline cards. */
  readonly focus: 'input' | 'question' | 'stop' | 'plan';
  /** The timeline was clicked or chosen with Tab while the composer is the keyboard target underneath. */
  readonly timelineChosen: boolean;
  readonly editingCustom: boolean;
  /** A page, picker, login or other surface covers the screen. */
  readonly takeover: boolean;
}
/** The focused region, or `null` while a takeover surface is open. */
export function focusRegion({focus, timelineChosen, editingCustom, takeover}: FocusFacts): FocusRegion | null {
  if (takeover) return null;
  if (focus === 'plan') return 'sidebar';
  if (editingCustom) return 'composer';
  if (focus === 'input') return timelineChosen ? 'timeline' : 'composer';
  return 'timeline';
}
