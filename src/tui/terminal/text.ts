import stringWidth from 'string-width';
const segmenter = new Intl.Segmenter('zh', {granularity: 'grapheme'});

/** Plain terminal text excludes control sequences; styling belongs to the renderer. */
export function safeText(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}
/** Cells of the elapsed-time slot beside a running node (`2:10`, `12:05`, `1h05`). */
export const CLOCK_WIDTH = 5;
/** `2:10`, `12:05`, `1h05`: at most five cells. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000)), minutes = Math.floor(total / 60), seconds = total % 60;
  if (minutes < 60) return minutes + ':' + String(seconds).padStart(2, '0');
  const hours = Math.floor(minutes / 60);
  return hours >= 100 ? '99h+' : hours + 'h' + String(minutes % 60).padStart(2, '0');
}
export function clipLine(text: string, width: number): string {
  let result = '';
  for (const part of segmenter.segment(safeText(text))) {
    if (stringWidth(result + part.segment) > width) break;
    result += part.segment;
  }
  return result;
}
