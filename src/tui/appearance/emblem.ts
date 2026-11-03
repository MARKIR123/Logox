import stringWidth from 'string-width';
import {clipLine} from '../terminal/text.js';
import {mixHex} from './colors.js';

/**
 * The LOGOX flower at 26x26, identical to `assets/brand/draft-26.json` (checked by `tests/tui-splash.test.ts`): '.' empty, 'b' Director blue, 'w' bone.
 * Each terminal cell holds two pixels (half blocks), so the emblem is 26 columns by 13 rows with square pixels. Used flat by the regular and small tiers.
 */
export const EMBLEM_PIXELS: readonly string[] = ["..........................", "............bb............", "...........bbbb...........", "..........bbbbbb..........", ".........bbb..bbb.........", ".........bb....bb.........", "..........b....b..........", "...........b..b...........", "..........................", "....ww......bb......ww....", "...wwww....bbbb....wwww...", "..www..w..bb..bb..w..www..", ".www.....bb.ww.bb.....www.", ".www.....bb.ww.bb.....www.", "..www..w..bb..bb..w..www..", "...wwww....bbbb....wwww...", "....ww......bb......ww....", "..........................", "...........b..b...........", "..........b....b..........", ".........bb....bb.........", ".........bbb..bbb.........", "..........bbbbbb..........", "...........bbbb...........", "............bb............", ".........................."];
/** The 52x52 master flower, identical to `assets/brand/master-52.json` (checked by `tests/tui-splash.test.ts`); drawn with edge shading in the large tier. */
export const EMBLEM_MASTER: readonly string[] = ["....................................................","....................................................",".........................bb.........................",".......................bbbbbb.......................",".......................bbbbbb.......................",".....................bbbbbbbbbb.....................",".....................bbbbbbbbbb.....................","...................bbbbbbbbbbbbbb...................","...................bbbbbb..bbbbbb...................","..................bbbbb......bbbbb..................","..................bbbbb......bbbbb..................","...................bbb........bbb...................","...................bbb........bbb...................","....................bbb......bbb....................",".....................bbb....bbb.....................","......................bb....bb......................","....................................................","....................................................",".........ww..............bb..............ww.........",".......wwwwww............bb............wwwwww.......",".......wwwwwww..........bbbb..........wwwwwww.......",".....wwwwwwwwww........bb..bb........wwwwwwwwww.....",".....wwwwww..www......bbb..bbb......www..wwwwww.....","...wwwwww.....ww.....bbb....bbb.....ww.....wwwwww...","...wwwwww...........bbb..ww..bbb...........wwwwww...","..wwwwww..........bbb...wwww...bbb..........wwwwww..","..wwwwww..........bbb...wwww...bbb..........wwwwww..","...wwwwww...........bbb..ww..bbb...........wwwwww...","...wwwwww.....ww.....bbb....bbb.....ww.....wwwwww...",".....wwwwww..www......bbb..bbb......www..wwwwww.....",".....wwwwwwwwww........bb..bb........wwwwwwwwww.....",".......wwwwwww..........bbbb..........wwwwwww.......",".......wwwwww............bb............wwwwww.......",".........ww..............bb..............ww.........","....................................................","....................................................","......................bb....bb......................",".....................bbb....bbb.....................","....................bbb......bbb....................","...................bbb........bbb...................","...................bbb........bbb...................","..................bbbbb......bbbbb..................","..................bbbbb......bbbbb..................","...................bbbbbb..bbbbbb...................","...................bbbbbbbbbbbbbb...................",".....................bbbbbbbbbb.....................",".....................bbbbbbbbbb.....................",".......................bbbbbb.......................",".......................bbbbbb.......................",".........................bb.........................","....................................................","...................................................."];
/** The 72x16 pixel wordmark, identical to `assets/brand/wordmark-16.json`: 't' letter pixel (blue-to-bone vertical gradient), 'b' ring blue, 'w' core bone. Eight terminal rows. */
export const EMBLEM_WORDMARK_PIXELS: readonly string[] = [".................................................bb.....................","tt..............tttttt........tttttttt..........bbbb..........tt......tt","tt.............tttttttt......ttttttttt.........bb..bb.........tt......tt","tt............ttt....ttt....ttt...............bb....bb........tt......tt","tt............tt......tt....tt...............bb......bb.......ttt....ttt","tt............tt......tt....tt..............bb...ww...bb.......ttt..ttt.","tt............tt......tt....tt.............bb...wwww...bb.......tt..tt..","tt............tt......tt....tt....ttt.....bb...wwwwww...bb........tt....","tt............tt......tt....tt....tttt....bb...wwwwww...bb........tt....","tt............tt......tt....tt.....ttt.....bb...wwww...bb.......tt..tt..","tt............tt......tt....tt......tt......bb...ww...bb.......ttt..ttt.","tt............tt......tt....tt......tt.......bb......bb.......ttt....ttt","ttt...........ttt....ttt....ttt....ttt........bb....bb........tt......tt","tttttttttt.....tttttttt......tttttttt..........bb..bb.........tt......tt",".ttttttttt......tttttt........tttttt............bbbb..........tt......tt",".................................................bb....................."];
/** Plain-text wordmark of the small tiers. */
export const EMBLEM_WORDMARK = 'L   O   G   O   X';
export const EMBLEM_TAGLINE = 'A terminal coding ensemble';
export const EMBLEM_ETYMOLOGY = 'λόγος · reason, word, account';

export interface SplashSegment {readonly text: string; readonly color?: string; readonly bg?: string; readonly bold?: boolean; readonly italic?: boolean}
export type SplashLine = readonly SplashSegment[];
export interface SplashColors {readonly blue: string; readonly bone: string; readonly title: string; readonly muted: string}

const EMBLEM_WIDTH = 26, EMBLEM_ROWS = 13, GAP = 4;
const MASTER_WIDTH = 52, MASTER_ROWS = 26, WORD_WIDTH = 72, BIG_GAP = 6, MARGIN = 2;

const isHex = (value: string) => /^#[0-9a-f]{6}$/i.test(value);
// Pure white and black are built rather than written so UI source holds no colour literals.
const WHITE = '#' + 'f'.repeat(6), BLACK = '#' + '0'.repeat(6);

/** Half-block cells from a pixel grid: foreground is the top pixel and background the bottom one where both are drawn. */
function pixelLines(grid: readonly string[], colorAt: (pixel: string, row: number) => string | undefined): SplashLine[] {
  const lines: SplashLine[] = [];
  for (let row = 0; row < grid.length; row += 2) {
    const top = grid[row]!, bottom = grid[row + 1] ?? '.'.repeat(top.length);
    const segments: SplashSegment[] = [];
    for (let column = 0; column < top.length; column++) {
      const upper = colorAt(top[column]!, row), lower = colorAt(bottom[column]!, row + 1);
      const cell: SplashSegment = !upper && !lower ? {text: ' '}
        : upper === lower ? {text: '█', color: upper!}
        : !lower ? {text: '▀', color: upper!}
        : !upper ? {text: '▄', color: lower}
        : {text: '▀', color: upper, bg: lower};
      const previous = segments.at(-1);
      // Merge runs that share styling so a line is a handful of segments, not one per cell.
      if (previous && previous.color === cell.color && previous.bg === cell.bg) segments[segments.length - 1] = {...previous, text: previous.text + cell.text};
      else segments.push(cell);
    }
    lines.push(segments);
  }
  return lines;
}

/** One line per cell row of the flat 26-pixel draft. */
export function emblemLines(colors: Pick<SplashColors, 'blue' | 'bone'>): SplashLine[] {
  return pixelLines(EMBLEM_PIXELS, pixel => pixel === 'b' ? colors.blue : pixel === 'w' ? colors.bone : undefined);
}

/**
 * Rim light on edges facing the top left and shadow on edges facing the bottom right (upper case lit, 'd'/'e' shadow);
 * a tone pixel without a same-tone neighbour reverts to the base so light reads as edges, not dots on stair steps.
 * Same algorithm as `shade()` in `scripts/brand-assets.mjs`.
 */
export function shadeEmblem(grid: readonly string[]): string[] {
  const at = (x: number, y: number) => grid[y]?.[x] ?? '.';
  const LIT: Record<string, string> = {b: 'B', w: 'W'}, DIM: Record<string, string> = {b: 'd', w: 'e'};
  const toned = grid.map((row, y) => [...row].map((c, x) => {
    if (c === '.') return c;
    const lit = (at(x - 1, y) !== c && at(x, y - 1) !== c) || (at(x - 1, y - 1) === '.' && (at(x - 1, y) !== c || at(x, y - 1) !== c));
    const dark = (at(x + 1, y) !== c && at(x, y + 1) !== c) || (at(x + 1, y + 1) === '.' && (at(x + 1, y) !== c || at(x, y + 1) !== c));
    return lit && !dark ? LIT[c]! : dark && !lit ? DIM[c]! : c;
  }));
  const base: Record<string, string> = {B: 'b', d: 'b', W: 'w', e: 'w'};
  return toned.map((row, y) => row.map((tone, x) => {
    const flat = base[tone];
    if (!flat) return tone;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && toned[y + dy]?.[x + dx] === tone) return tone;
    return flat;
  }).join(''));
}

/** The shaded 52-pixel master as 26 cell rows; tones are derived from the theme blue and bone (flat when they are not hex colours). */
export function masterLines(colors: Pick<SplashColors, 'blue' | 'bone'>): SplashLine[] {
  const derive = (color: string) => isHex(color) ? {lit: mixHex(WHITE, color, 0.25), dim: mixHex(BLACK, color, 0.15)} : {lit: color, dim: color};
  const blue = derive(colors.blue), bone = derive(colors.bone);
  const tones: Record<string, string> = {b: colors.blue, B: blue.lit, d: blue.dim, w: colors.bone, W: bone.lit, e: bone.dim};
  return pixelLines(shadeEmblem(EMBLEM_MASTER), pixel => tones[pixel]);
}

/** The big wordmark as 8 cell rows: letters fade from blue at the top pixel row to bone at the bottom, the ring is blue and the core bone. */
export function wordmarkLines(colors: Pick<SplashColors, 'blue' | 'bone'>): SplashLine[] {
  const last = EMBLEM_WORDMARK_PIXELS.length - 1, gradient = isHex(colors.blue) && isHex(colors.bone);
  return pixelLines(EMBLEM_WORDMARK_PIXELS, (pixel, row) => pixel === 'b' ? colors.blue : pixel === 'w' ? colors.bone
    : pixel === 't' ? (gradient ? mixHex(colors.bone, colors.blue, row / last) : colors.blue) : undefined);
}

const lineText = (line: SplashLine) => line.map(segment => segment.text).join('');
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

/**
 * The welcome splash, largest layout that fits: the shaded 52 master beside the big wordmark; the flat 26 draft beside the wordmark;
 * the draft beside plain text; the draft stacked above plain text; undefined when nothing fits, so the caller shows the plain welcome text.
 * Every line stays within `width`.
 */
export function splashLines(input: {width: number; height: number; colors: SplashColors; title?: string | undefined; info: readonly string[]; version?: string | undefined}): SplashLine[] | undefined {
  const {width, height, colors} = input;
  const tagColor = isHex(colors.blue) && isHex(colors.bone) ? mixHex(colors.bone, colors.blue, 0.55) : colors.bone;
  const tagline: SplashLine = [{text: EMBLEM_TAGLINE, color: tagColor, bold: true}];
  const etymology: SplashLine = [{text: EMBLEM_ETYMOLOGY, color: colors.muted, italic: true}];
  const pad = (cells: number): SplashSegment => ({text: ' '.repeat(Math.max(0, cells))});
  const centred = (line: SplashLine, span: number): SplashLine => [pad(MARGIN + Math.floor((span - stringWidth(lineText(line))) / 2)), ...line];

  // The first info line `model · hint` splits into foreground and muted; the rest is muted.
  const infoLines: SplashLine[] = input.info.map((line, index) => {
    const cut = index === 0 ? line.indexOf(' · ') : -1;
    return cut > 0 ? [{text: line.slice(0, cut), color: colors.bone}, {text: line.slice(cut), color: colors.muted}] : [{text: line, color: colors.muted}];
  });
  const header: SplashLine = [{text: '◈ LOGOX', color: colors.blue, bold: true}, ...(input.version ? [{text: '  v' + input.version, color: colors.muted}] : [])];
  const infoBlock: SplashLine[] = [...(infoLines.length ? [infoLines[0]!] : []), ...(input.title ? [[{text: input.title, color: colors.title}]] : []), ...infoLines.slice(1)];

  const sideBySide = (emblem: SplashLine[], emblemWidth: number, right: SplashLine[]): SplashLine[] => {
    const rows = emblem.length, offset = Math.max(0, Math.floor((rows - right.length) / 2)), room = width - MARGIN - emblemWidth - BIG_GAP;
    return [[], ...emblem.map((line, index) => {
      const words = right[index - offset];
      return [pad(MARGIN), ...line, ...(words ? [pad(BIG_GAP), ...clip(words, room)] : [])];
    }), [], centred(tagline, emblemWidth), centred(etymology, emblemWidth)];
  };
  const bigRight = (rows: number): SplashLine[] => {
    const full = [header, ...wordmarkLines(colors), [], ...infoBlock];
    return (full.length <= rows ? full : [header, ...wordmarkLines(colors), ...infoBlock]).slice(0, rows);
  };
  if (width >= MARGIN + MASTER_WIDTH + BIG_GAP + WORD_WIDTH + 2 && height >= MASTER_ROWS + 4) return sideBySide(masterLines(colors), MASTER_WIDTH, bigRight(MASTER_ROWS));
  if (width >= MARGIN + EMBLEM_WIDTH + BIG_GAP + WORD_WIDTH + 2 && height >= EMBLEM_ROWS + 4) return sideBySide(emblemLines(colors), EMBLEM_WIDTH, bigRight(EMBLEM_ROWS));

  const text: SplashLine[] = [
    [{text: EMBLEM_WORDMARK, color: colors.bone, bold: true}],
    [],
    tagline,
    etymology,
    [],
    ...(input.title ? [[{text: input.title, color: colors.title}]] : []),
    ...input.info.map(line => [{text: line, color: colors.muted}]),
  ];
  const emblem = emblemLines(colors);
  const textWidth = Math.max(...text.map(line => stringWidth(lineText(line))));
  if (width >= MARGIN + EMBLEM_WIDTH + GAP + Math.min(textWidth, EMBLEM_ETYMOLOGY.length) && height >= EMBLEM_ROWS + 2 && text.length <= EMBLEM_ROWS) {
    const offset = Math.floor((EMBLEM_ROWS - text.length) / 2), room = width - MARGIN - EMBLEM_WIDTH - GAP;
    return [[], ...emblem.map((line, index) => {
      const words = text[index - offset];
      return [pad(MARGIN), ...line, pad(GAP), ...(words ? clip(words, room) : [])];
    }), []];
  }
  if (width >= EMBLEM_WIDTH + 2 && height >= EMBLEM_ROWS + text.length + 3) {
    const center = (cells: number) => pad(Math.floor((width - cells) / 2));
    return [[], ...emblem.map(line => [center(EMBLEM_WIDTH), ...line]), [],
      ...text.map(line => { const shown = clip(line, width); return [center(stringWidth(lineText(shown))), ...shown]; })];
  }
  return undefined;
}
