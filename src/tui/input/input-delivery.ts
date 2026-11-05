import stringWidth from 'string-width';
import {clipLine} from '../terminal/text.js';

/** Most pending rows shown above the composer; older ones stay queued and are hidden. */
export const PENDING_VISIBLE_MAX = 3;
const BADGE = 'Queued · ';
const SEND = 'Send now';
const DISCARD = '×';

export interface PendingRowLayout {
  /** Muted message text (with the target prefix), already clipped to its column. */
  readonly left: string;
  /** Gap between the text and the controls. */
  readonly gap: number;
  readonly badge: string;
  readonly send: {readonly text: string; readonly x0: number; readonly x1: number} | undefined;
  readonly discard: {readonly text: string; readonly x0: number; readonly x1: number} | undefined;
}

/**
 * One pending row: `<text clipped>   Queued · Send now  ×`. Controls drop out as the terminal narrows (badge first, then `×`, then `Send now`)
 * so the text keeps at least a few columns; x ranges are screen columns for mouse hit-testing.
 */
export function pendingRowLayout(width: number, text: string, target?: string): PendingRowLayout {
  const flat = (target ? '→ ' + target + ' · ' : '') + text.replace(/\s*\n\s*/g, ' ↵ ').trim();
  const variants: Array<{badge: string; send: boolean; discard: boolean}> = [
    {badge: BADGE, send: true, discard: true}, {badge: '', send: true, discard: true}, {badge: '', send: true, discard: false},
    {badge: '', send: false, discard: true}, {badge: '', send: false, discard: false},
  ];
  const minText = 6;
  const pick = variants.find(variant => {
    const controls = stringWidth(variant.badge) + (variant.send ? stringWidth(SEND) : 0) + (variant.discard ? (variant.send ? 2 : 0) + stringWidth(DISCARD) : 0);
    return width - controls - (controls ? 2 : 0) >= Math.min(minText, stringWidth(flat))
  }) ?? variants[variants.length - 1]!;
  const sendWidth = pick.send ? stringWidth(SEND) : 0;
  const discardWidth = pick.discard ? stringWidth(DISCARD) : 0;
  const controls = stringWidth(pick.badge) + sendWidth + (pick.discard ? (pick.send ? 2 : 0) + discardWidth : 0);
  const textWidth = Math.max(0, width - controls - (controls ? 2 : 0));
  const left = clipLine(flat, textWidth);
  const gap = Math.max(0, width - stringWidth(left) - controls);
  let x = stringWidth(left) + gap + stringWidth(pick.badge);
  const send = pick.send ? {text: SEND, x0: x, x1: x + sendWidth} : undefined;
  x += sendWidth + (pick.send && pick.discard ? 2 : 0);
  const discard = pick.discard ? {text: DISCARD, x0: x, x1: x + discardWidth} : undefined;
  return {left, gap, badge: pick.badge, send, discard};
}
