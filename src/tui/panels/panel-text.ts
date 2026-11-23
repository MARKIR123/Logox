/**
 * Text helpers shared by the sidebar painters (`team-stage.ts`, `team-sidebar.ts`): the tone names a cell may carry (the painters turn them into palette colours),
 * `fit()` (a width-safe clip with `…`) and `formatTook()` (a compact duration). Nothing here knows about layout or state.
 */
import stringWidth from 'string-width';
import {safeText} from '../terminal/text.js';

/** What a cell is coloured by: a palette role (`owner` takes the colour of the actor the cell names). */
export type FlowTone = 'fg' | 'strong' | 'muted' | 'faint' | 'accent' | 'success' | 'warning' | 'error' | 'owner' | 'line';

const segmenter = new Intl.Segmenter('zh', {granularity: 'grapheme'});
/** `text` cut to at most `width` cells; a cut ends with `…` and never splits a wide character. */
export function fit(text: string, width: number): string {
  const clean = safeText(text).replace(/\s+/g, ' ').trim();
  if (width <= 0) return '';
  if (stringWidth(clean) <= width) return clean;
  let out = '';
  for (const {segment} of segmenter.segment(clean)) {
    if (stringWidth(out + segment) > width - 1) break;
    out += segment;
  }
  return out + '…';
}
/** `45s`, `3m12s`, `2m`, `1h05m`: how long finished work took. */
export function formatTook(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000)), minutes = Math.floor(total / 60), seconds = total % 60;
  if (minutes < 1) return total + 's';
  if (minutes < 60) return minutes + 'm' + (seconds ? String(seconds).padStart(2, '0') + 's' : '');
  return Math.floor(minutes / 60) + 'h' + String(minutes % 60).padStart(2, '0') + 'm';
}
