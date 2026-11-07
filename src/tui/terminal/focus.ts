/** Terminal focus reporting (DECSET 1004): the terminal sends `ESC [ I` when it gains focus and `ESC [ O` when it loses it. */
export const FOCUS_REPORTING_ON = '\x1b[?1004h';
export const FOCUS_REPORTING_OFF = '\x1b[?1004l';
let focused: boolean | undefined;
/** `undefined` until the terminal has reported at least once (no focus reporting): callers treat that as unfocused. */
export function terminalFocus(): boolean | undefined {return focused;}
export function setTerminalFocus(value: boolean | undefined): void {focused = value;}
/** Applies every focus report in `chunk` and returns the chunk without them, so they never reach the key parser. */
export function consumeFocusReports(chunk: string): string {
  return chunk.replace(/\[([IO])/g, (_all, kind: string) => {focused = kind === 'I'; return '';});
}
/**
 * Stateful variant for a chunked stream: a report split across chunks (`ESC` then `[O`, or `ESC [` then `O`) still updates the focus state.
 * The split halves are left in the stream because Ink's own parser re-joins them and drops the complete control sequence.
 */
export class FocusReportFilter {
  private tail = '';
  push(chunk: string): string {
    const split = this.tail === '' ? /^\[([IO])/.exec(chunk) : this.tail === '[' ? /^([IO])/.exec(chunk) : null;
    if (split) focused = split[1] === 'I';
    const cleaned = consumeFocusReports(chunk);
    this.tail = /\[?$/.exec(cleaned)?.[0] ?? '';
    return cleaned;
  }
}
