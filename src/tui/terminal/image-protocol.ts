// Terminal image capability: the probe that asks the terminal what it can draw, parsing of its replies (they arrive on stdin, so they
// must be taken out of the key stream), the choice between Sixel and half blocks, and the cell size in pixels.
// Probe order and the 8 x 16 default follow dsh-tui's `ink/terminal-image.js` (MIT, https://github.com/ccch1mneyyy/dsh-TUI).

export type ImageProtocol = 'sixel' | 'halfblock';
export type ProtocolChoice = 'auto' | ImageProtocol;
export interface CellPixels {readonly width: number; readonly height: number}
/** Conventional monospace cell, used when the terminal does not report pixel sizes; a smaller guess only makes a picture smaller, never larger. */
export const DEFAULT_CELL: CellPixels = Object.freeze({width: 8, height: 16});

/**
 * Cell size (`CSI 16 t`), text area size (`CSI 14 t`), then Primary Device Attributes (`CSI c`, answered by every terminal, so it is
 * the barrier: once it replies, the other two have either replied or never will).
 */
export const IMAGE_PROBE = '\x1b[16t\x1b[14t\x1b[c';

export type TerminalReply =
  | {readonly kind: 'attributes'; readonly attributes: readonly number[]}
  | {readonly kind: 'cell'; readonly width: number; readonly height: number}
  | {readonly kind: 'window'; readonly width: number; readonly height: number};

const REPLY = /\x1b\[\?([\d;]*)c|\x1b\[([46]);(\d+);(\d+)t/g;
/** Removes every probe reply from `chunk` and returns them, so none reaches the key parser. */
export function extractReplies(chunk: string): {readonly text: string; readonly replies: readonly TerminalReply[]} {
  if (!chunk.includes('\x1b[')) return {text: chunk, replies: []};
  const replies: TerminalReply[] = [];
  const text = chunk.replace(REPLY, (_all, attributes: string | undefined, kind: string | undefined, height: string | undefined, width: string | undefined) => {
    if (attributes !== undefined) replies.push({kind: 'attributes', attributes: attributes.split(';').filter(Boolean).map(Number)});
    else replies.push({kind: kind === '6' ? 'cell' : 'window', width: Number(width), height: Number(height)});
    return '';
  });
  return {text, replies};
}

/** Sixel is attribute 4 of the Primary Device Attributes reply. */
export const supportsSixel = (attributes: readonly number[] | undefined): boolean => Boolean(attributes?.includes(4));

export function parseChoice(value: string | undefined): ProtocolChoice {
  const text = value?.trim().toLowerCase();
  return text === 'sixel' || text === 'halfblock' ? text : text === 'half-block' || text === 'none' || text === 'off' ? 'halfblock' : 'auto';
}
/** The override wins; `auto` follows the terminal's own report. */
export function selectProtocol(choice: ProtocolChoice, attributes: readonly number[] | undefined): ImageProtocol {
  if (choice !== 'auto') return choice;
  return supportsSixel(attributes) ? 'sixel' : 'halfblock';
}

const plausible = (value: CellPixels | undefined): CellPixels | undefined =>
  value && Number.isFinite(value.width) && Number.isFinite(value.height) && value.width >= 1 && value.height >= 1 && value.width <= 512 && value.height <= 512
    ? {width: Math.round(value.width), height: Math.round(value.height)} : undefined;
/** A direct cell report first, then the text area divided by the grid; undefined when neither is plausible. */
export function resolveCellSize(cell: CellPixels | undefined, window: CellPixels | undefined, columns: number, rows: number): CellPixels | undefined {
  const direct = plausible(cell);
  if (direct) return direct;
  if (!window || columns <= 0 || rows <= 0) return undefined;
  return plausible({width: window.width / columns, height: window.height / rows});
}
