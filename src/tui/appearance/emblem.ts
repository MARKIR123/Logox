import stringWidth from 'string-width';
import {clipLine} from '../terminal/text.js';

/**
 * The LOGOX flower at 26x26, identical to `assets/brand/draft-26.json` (checked by `tests/tui-splash.test.ts`): '.' empty, 'b' Director blue, 'w' bone.
 * Each terminal cell holds two pixels (half blocks), so the emblem is 26 columns by 13 rows with square pixels.
 */
export const EMBLEM_PIXELS: readonly string[] = ["..........................", "............bb............", "...........bbbb...........", "..........bbbbbb..........", ".........bbb..bbb.........", ".........bb....bb.........", "..........b....b..........", "...........b..b...........", "..........................", "....ww......bb......ww....", "...wwww....bbbb....wwww...", "..www..w..bb..bb..w..www..", ".www.....bb.ww.bb.....www.", ".www.....bb.ww.bb.....www.", "..www..w..bb..bb..w..www..", "...wwww....bbbb....wwww...", "....ww......bb......ww....", "..........................", "...........b..b...........", "..........b....b..........", ".........bb....bb.........", ".........bbb..bbb.........", "..........bbbbbb..........", "...........bbbb...........", "............bb............", ".........................."];
export const EMBLEM_WORDMARK = 'L   O   G   O   X';
export const EMBLEM_TAGLINE = 'A terminal coding ensemble';
export const EMBLEM_ETYMOLOGY = 'λόγος · reason, word, account';

export interface SplashSegment {readonly text: string; readonly color?: string; readonly bg?: string; readonly bold?: boolean; readonly italic?: boolean}
export type SplashLine = readonly SplashSegment[];
export interface SplashColors {readonly blue: string; readonly bone: string; readonly title: string; readonly muted: string}

const EMBLEM_WIDTH = 26, EMBLEM_ROWS = 13, GAP = 4;

/** One line per cell row: a half block whose foreground is the top pixel and background the bottom one where both are drawn. */
export function emblemLines(colors: Pick<SplashColors, 'blue' | 'bone'>): SplashLine[] {
  const color = (pixel: string) => pixel === 'b' ? colors.blue : pixel === 'w' ? colors.bone : undefined;
  const lines: SplashLine[] = [];
  for (let row = 0; row < EMBLEM_PIXELS.length; row += 2) {
    const top = EMBLEM_PIXELS[row]!, bottom = EMBLEM_PIXELS[row + 1] ?? '.'.repeat(top.length);
    const segments: SplashSegment[] = [];
    for (let column = 0; column < top.length; column++) {
      const upper = color(top[column]!), lower = color(bottom[column]!);
      const cell: SplashSegment = !upper && !lower ? {text: ' '}
        : upper === lower ? {text: '█', color: upper!}
        : !lower ? {text: '▀', color: upper!}
        : !upper ? {text: '▄', color: lower}
        : {text: '▀', color: upper, bg: lower};
      const previous = segments.at(-1);
      // Merge runs that share styling so a line is a handful of segments, not 26.
      if (previous && previous.color === cell.color && previous.bg === cell.bg) segments[segments.length - 1] = {...previous, text: previous.text + cell.text};
      else segments.push(cell);
    }
    lines.push(segments);
  }
  return lines;
}

/**
 * The welcome splash: the emblem beside the wordmark, motto and session lines when the terminal is wide enough,
 * stacked when it is narrow, and undefined when it does not fit, so the caller shows the plain welcome text instead.
 */
export function splashLines(input: {width: number; height: number; colors: SplashColors; title?: string | undefined; info: readonly string[]}): SplashLine[] | undefined {
  const {width, height, colors} = input;
  const text: SplashLine[] = [
    [{text: EMBLEM_WORDMARK, color: colors.bone, bold: true}],
    [],
    [{text: EMBLEM_TAGLINE, color: colors.bone}],
    [{text: EMBLEM_ETYMOLOGY, color: colors.muted, italic: true}],
    [],
    ...(input.title ? [[{text: input.title, color: colors.title}]] : []),
    ...input.info.map(line => [{text: line, color: colors.muted}]),
  ];
  const emblem = emblemLines(colors);
  const clip = (line: SplashLine, room: number): SplashLine => {
    const out: SplashSegment[] = [];
    let left = room;
    for (const segment of line) {
      if (left <= 0) break;
      const piece = stringWidth(segment.text) > left ? clipLine(segment.text, left) : segment.text;
      out.push({...segment, text: piece});
      left -= stringWidth(piece);
    }
    return out;
  };
  const textWidth = Math.max(...text.map(line => stringWidth(line.map(segment => segment.text).join(''))));
  const margin = 2;
  if (width >= margin + EMBLEM_WIDTH + GAP + Math.min(textWidth, EMBLEM_ETYMOLOGY.length) && height >= EMBLEM_ROWS + 2 && text.length <= EMBLEM_ROWS) {
    const offset = Math.floor((EMBLEM_ROWS - text.length) / 2), room = width - margin - EMBLEM_WIDTH - GAP;
    return [[], ...emblem.map((line, index) => {
      const words = text[index - offset];
      return [{text: ' '.repeat(margin)}, ...line, {text: ' '.repeat(GAP)}, ...(words ? clip(words, room) : [])];
    }), []];
  }
  if (width >= EMBLEM_WIDTH + 2 && height >= EMBLEM_ROWS + text.length + 3) {
    const pad = (cells: number) => ({text: ' '.repeat(Math.max(0, Math.floor((width - cells) / 2)))});
    return [[], ...emblem.map(line => [pad(EMBLEM_WIDTH), ...line]), [],
      ...text.map(line => { const shown = clip(line, width); return [pad(stringWidth(shown.map(segment => segment.text).join(''))), ...shown]; })];
  }
  return undefined;
}
