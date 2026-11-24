// The lightbox's pure side: the view (zoom level and centre), its transitions and the card geometry (title border, picture, toolbar,
// path row, close control). `ImageLightbox` draws, routes keys and hit-tests through these, so drawing and hit-testing share one plan.
// Layout idea after dsh-tui's image preview (MIT, https://github.com/ccch1mneyyy/dsh-TUI): a centred card over a backdrop, the title
// in its top border, the picture, a toolbar `Fit 100% - + ← ↑ ↓ →`, then the path of the original; written here for half blocks.
import stringWidth from 'string-width';
import {HALF_BLOCK_GRID, fitScale, placeAtScale, type CellGrid, type Placement} from '../terminal/image-raster.js';

/** 0 is "fit to the card"; the others are output pixels per file pixel (1 is 100%: one half-block pixel per file pixel). */
export type Zoom = 0 | 1 | 2 | 4 | 8;
export const ZOOM_LEVELS: readonly Zoom[] = [1, 2, 4, 8];
export interface LightboxView {readonly zoom: Zoom; readonly cx: number; readonly cy: number}
export const FIT_VIEW: LightboxView = {zoom: 0, cx: 0.5, cy: 0.5};

/** Below this screen size the card is metadata only (no picture): it would be too small to read. */
export const MIN_COLUMNS = 40, MIN_ROWS = 12;
/** Share of the screen the picture may take, and the card's chrome around it: title border, a blank row, toolbar, path row, bottom border. */
export const MAX_SHARE = 0.95, CHROME_ROWS = 5, CHROME_COLS = 4, MIN_CARD_COLUMNS = 40, CAPTION_ROWS = 3;
export const CLOSE_GLYPH = '✕';
export type ButtonId = 'fit' | 'actual' | 'out' | 'in' | 'left' | 'up' | 'down' | 'right';
export interface Button {readonly id: ButtonId; readonly label: string; readonly x0: number; readonly x1: number; readonly disabled: boolean; readonly active: boolean}

export interface CardLayout {
  readonly left: number;
  readonly top: number;
  readonly cardCols: number;
  readonly cardRows: number;
  /** The picture viewport in cells and the screen cell of its top-left corner. */
  readonly imageCols: number;
  readonly imageRows: number;
  readonly imageX: number;
  readonly imageY: number;
  /** The card has room for a picture (a big enough screen); otherwise it shows the facts only. */
  readonly picture: boolean;
  readonly placement?: Placement;
  /** Screen rows: title border, toolbar, path. */
  readonly titleY: number;
  readonly toolbarY: number;
  readonly pathY: number;
  readonly buttons: readonly Button[];
  /** The close control in the title border, in screen cells (`x1` exclusive). */
  readonly close: {readonly y: number; readonly x0: number; readonly x1: number};
  /** The path row's clickable text. */
  readonly path: {readonly y: number; readonly x0: number; readonly x1: number};
  /** Cells the title text may use inside the border. */
  readonly titleColumns: number;
  /** Cells the path text may use. */
  readonly pathColumns: number;
}
export interface CardInput {
  readonly screenCols: number;
  readonly screenRows: number;
  /** The decoded image's file dimensions, once known. */
  readonly image?: {readonly width: number; readonly height: number};
  readonly view: LightboxView;
  /** Cells the title would like, so a small picture never squeezes the file name. */
  readonly titleWidth: number;
  readonly pathLabelWidth: number;
  readonly grid?: CellGrid;
}

const BUTTONS: readonly {readonly id: ButtonId; readonly label: string}[] = [
  {id: 'fit', label: 'Fit'}, {id: 'actual', label: '100%'}, {id: 'out', label: '-'}, {id: 'in', label: '+'},
  {id: 'left', label: '←'}, {id: 'up', label: '↑'}, {id: 'down', label: '↓'}, {id: 'right', label: '→'},
];

export function cardLayout(input: CardInput): CardLayout {
  const {screenCols, screenRows, image, view} = input, grid = input.grid ?? HALF_BLOCK_GRID;
  const picture = screenCols >= MIN_COLUMNS && screenRows >= MIN_ROWS;
  const maxCols = Math.max(1, Math.min(screenCols - 2, Math.floor(screenCols * MAX_SHARE)) - CHROME_COLS);
  const maxRows = Math.max(1, Math.min(screenRows - 2, Math.floor(screenRows * MAX_SHARE)) - CHROME_ROWS);
  let placement: Placement | undefined, imageCols = Math.min(maxCols, 36), imageRows = Math.min(maxRows, 5);
  if (picture && image) {
    const scale = view.zoom === 0 ? fitScale(image.width, image.height, maxCols, maxRows, grid) : view.zoom;
    placement = placeAtScale(image.width, image.height, maxCols, maxRows, scale, view.cx, view.cy, grid);
    imageCols = placement.cols; imageRows = placement.rows;
  }
  const cardCols = Math.max(1, Math.min(screenCols, Math.max(picture ? imageCols + CHROME_COLS : 0, input.titleWidth + CHROME_COLS, MIN_CARD_COLUMNS)));
  const cardRows = Math.max(1, Math.min(screenRows, picture ? imageRows + CHROME_ROWS : CAPTION_ROWS));
  const left = Math.max(0, Math.floor((screenCols - cardCols) / 2)), top = Math.max(0, Math.floor((screenRows - cardRows) / 2));
  const imageX = left + 2 + Math.max(0, Math.floor((cardCols - CHROME_COLS - imageCols) / 2)), imageY = top + 2;
  const toolbarY = top + 2 + (picture ? imageRows : 0), pathY = toolbarY + 1;
  let x = left + 2;
  const pannable = placement?.pannable ?? false;
  const buttons: Button[] = placement ? BUTTONS.map(({id, label}) => {
    const width = stringWidth(label) + 2, x0 = x;
    x += width;
    const disabled = id === 'out' ? view.zoom === 0 : id === 'in' ? view.zoom === 8 : id === 'fit' ? view.zoom === 0 : id === 'actual' ? view.zoom === 1
      : !pannable;
    return {id, label, x0, x1: x0 + width, disabled, active: id === 'fit' ? view.zoom === 0 : id === 'actual' ? view.zoom === 1 : false};
  }) : [];
  const closeWidth = stringWidth(CLOSE_GLYPH) + 2;
  const pathX = left + 2, pathColumns = Math.max(1, cardCols - CHROME_COLS);
  return {
    left, top, cardCols, cardRows, imageCols, imageRows, imageX, imageY, picture, ...(placement ? {placement} : {}),
    titleY: top, toolbarY, pathY, buttons,
    close: {y: top, x0: left + cardCols - 1 - closeWidth, x1: left + cardCols - 1},
    path: {y: pathY, x0: pathX, x1: picture ? pathX + Math.min(pathColumns, input.pathLabelWidth) : pathX},
    titleColumns: Math.max(0, cardCols - 2 - closeWidth - 2), pathColumns,
  };
}

export type ViewCommand =
  | {readonly kind: 'fit'}
  | {readonly kind: 'actual'}
  | {readonly kind: 'in'}
  | {readonly kind: 'out'}
  /** Moves the window over the picture by this many cells (positive x shows more of the right, positive y more of the bottom). */
  | {readonly kind: 'pan'; readonly dx: number; readonly dy: number};

/** One transition: `+` goes to 100% from fit and then doubles, `-` halves back to fit, panning needs the placement to know a cell in file pixels. */
export function stepView(view: LightboxView, command: ViewCommand, size: {readonly width: number; readonly height: number}, placement: Placement | undefined, grid: CellGrid = HALF_BLOCK_GRID): LightboxView {
  if (command.kind === 'fit') return FIT_VIEW;
  if (command.kind === 'actual') return {...view, zoom: 1};
  if (command.kind === 'in') return {...view, zoom: view.zoom === 0 ? 1 : (Math.min(8, view.zoom * 2) as Zoom)};
  if (command.kind === 'out') return view.zoom <= 1 ? FIT_VIEW : {...view, zoom: (view.zoom / 2) as Zoom};
  if (!placement || !placement.pannable) return view;
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  return {zoom: view.zoom, cx: clamp(placement.cx + command.dx * grid.x / placement.scale / size.width), cy: clamp(placement.cy + command.dy * grid.y / placement.scale / size.height)};
}

export const inCard = (layout: CardLayout, x: number, y: number): boolean => x >= layout.left && x < layout.left + layout.cardCols && y >= layout.top && y < layout.top + layout.cardRows;
export const overImage = (layout: CardLayout, x: number, y: number): boolean => layout.picture && x >= layout.imageX && x < layout.imageX + layout.imageCols && y >= layout.imageY && y < layout.imageY + layout.imageRows;
export const overClose = (layout: CardLayout, x: number, y: number): boolean => y === layout.close.y && x >= layout.close.x0 && x < layout.close.x1;
export const overPath = (layout: CardLayout, x: number, y: number): boolean => y === layout.path.y && x >= layout.path.x0 && x < layout.path.x1;
export const buttonAt = (layout: CardLayout, x: number, y: number): Button | undefined => y === layout.toolbarY ? layout.buttons.find(button => x >= button.x0 && x < button.x1) : undefined;

/** `lead — a · b · name` within `max` cells: the name gives way first (shortened in its middle, dropped below 8 cells), then the rest is cut. */
export function fitTitle(lead: string, details: readonly string[], name: string, max: number): string {
  const base = details.length ? `${lead} — ${details.join(' · ')}` : lead;
  const clipEnd = (text: string, width: number): string => stringWidth(text) <= width ? text : width <= 1 ? '' : Array.from(text).reduce((out, char) => stringWidth(out + char) <= width - 1 ? out + char : out, '') + '…';
  if (!name) return clipEnd(base, max);
  const prefix = (details.length ? base : lead + ' — ') + (details.length ? ' · ' : '');
  if (stringWidth(prefix + name) <= max) return prefix + name;
  const room = max - stringWidth(prefix);
  return room >= 8 ? prefix + elideMiddle(name, room) : clipEnd(base, max);
}
/** Keeps the head and the tail of `text` and replaces the middle with `…`. */
export function elideMiddle(text: string, width: number): string {
  if (stringWidth(text) <= width) return text;
  if (width <= 1) return width === 1 ? '…' : '';
  const chars = Array.from(text), head = Math.ceil((width - 1) / 2), tail = width - 1 - head;
  return chars.slice(0, head).join('') + '…' + (tail > 0 ? chars.slice(-tail).join('') : '');
}
/** The title border row: `╭──── title ─── ✕ ╮` of exactly `cardCols` cells, the title centred in the room the close control leaves. */
export function borderTitle(title: string, cardCols: number): {readonly before: string; readonly title: string; readonly after: string} {
  const inner = Math.max(0, cardCols - 2), closeWidth = stringWidth(CLOSE_GLYPH) + 2, fixed = Math.max(0, inner - closeWidth);
  const text = title ? ' ' + title + ' ' : '', fill = Math.max(0, fixed - stringWidth(text)), leftFill = Math.floor(fill / 2);
  return {before: '╭' + '─'.repeat(leftFill), title: text, after: '─'.repeat(fill - leftFill)};
}
