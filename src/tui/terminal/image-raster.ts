// Pure image geometry and rendering for the terminal: fit rules (thumbnail and lightbox), area-averaging resampling and the
// half-block backend. Nothing here touches the file system, the theme or Ink, so every rule is testable on a synthetic raster.
// A backend turns an RGB pixel grid into rows of coloured cells; a graphics-protocol backend (kitty, sixel) would implement the
// same `ImageBackend` with its own `grid` (pixels per cell) and be chosen by the caller.

/** Straight (non-premultiplied) RGBA, 4 bytes per pixel, row-major. */
export interface Raster {readonly width: number; readonly height: number; readonly data: Uint8Array | Uint8ClampedArray}
/** A rectangle of source pixels; fractional values are fine (the resampler weights partial pixels). */
export interface Crop {readonly x: number; readonly y: number; readonly width: number; readonly height: number}
export interface Rgb {readonly r: number; readonly g: number; readonly b: number}
/** How many image pixels one terminal cell shows (the pixels are assumed square, so a cell about twice as tall as wide gives 1 x 2). */
export interface CellGrid {readonly x: number; readonly y: number}
export const HALF_BLOCK_GRID: CellGrid = {x: 1, y: 2};

/** One run of equal cells: `text` is one glyph repeated, drawn in `color` over `bg`. */
export interface ImageRun {readonly text: string; readonly color: string; readonly bg: string}
export type ImageRow = readonly ImageRun[];
export interface ImageBackend {
  readonly id: string;
  readonly grid: CellGrid;
  /** `rgb` is `cols * grid.x` by `rows * grid.y` pixels, three bytes each. */
  render(rgb: Uint8Array, cols: number, rows: number): ImageRow[];
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

export const THUMB_MIN_RATIO = 0.25, THUMB_MAX_RATIO = 4;
export interface ThumbnailFit {
  readonly cols: number;
  readonly rows: number;
  /** The part of the image the thumbnail shows (the rest is cropped). */
  readonly crop: Crop;
  /** The aspect ratio had to be clamped, so part of the image is cropped away. */
  readonly cropped: boolean;
}
/**
 * The thumbnail box of a lone image: the long edge is `maxLong` cells wide at most, the aspect ratio is clamped to [0.25, 4] (the
 * overflow is cropped, keeping the TOP of very tall images and the LEFT of very wide ones) and the box never exceeds the natural
 * pixel size, so a small image is not blown up.
 */
export function fitThumbnail(width: number, height: number, maxLong: number, grid: CellGrid = HALF_BLOCK_GRID): ThumbnailFit {
  const natural = width / height, ratio = clamp(natural, THUMB_MIN_RATIO, THUMB_MAX_RATIO);
  const limit = Math.max(1, maxLong) * grid.x;
  const box = ratio >= 1 ? {w: limit, h: limit / ratio} : {w: limit * ratio, h: limit};
  const scale = Math.min(1, width / box.w, height / box.h);
  const cols = Math.max(1, Math.round(box.w * scale / grid.x)), rows = Math.max(1, Math.round(box.h * scale / grid.y));
  const target = (cols * grid.x) / (rows * grid.y);
  // The crop has the box's aspect ratio. Only a clamped ratio crops anchor to an edge; otherwise the (rounding) slack is centred.
  const cropWidth = natural > target ? height * target : width, cropHeight = natural > target ? height : width / target;
  const x = natural > THUMB_MAX_RATIO ? 0 : (width - cropWidth) / 2, y = natural < THUMB_MIN_RATIO ? 0 : (height - cropHeight) / 2;
  return {cols, rows, crop: {x: Math.max(0, x), y: Math.max(0, y), width: cropWidth, height: cropHeight}, cropped: natural > THUMB_MAX_RATIO || natural < THUMB_MIN_RATIO};
}

export interface Placement {
  /** Cells the image occupies and where its top-left cell sits inside the area. */
  readonly cols: number;
  readonly rows: number;
  readonly col: number;
  readonly row: number;
  /** The visible part of the image, in source pixels. */
  readonly crop: Crop;
  /** Output pixels per source pixel (1 is the file's own resolution, one source pixel per half-block pixel). */
  readonly scale: number;
  /** The view centre actually used (normalized, 0 to 1), after keeping the picture inside the area. */
  readonly cx: number;
  readonly cy: number;
  /** The image is larger than the area at this scale, so it can be panned. */
  readonly pannable: boolean;
}
/** The scale at which the whole image just fits an area of `areaCols` by `areaRows` cells (it may be above 1: a small image is shown as large as fits). */
export function fitScale(width: number, height: number, areaCols: number, areaRows: number, grid: CellGrid = HALF_BLOCK_GRID): number {
  return Math.min(Math.max(1, areaCols) * grid.x / width, Math.max(1, areaRows) * grid.y / height);
}
/**
 * The image drawn at `scale` output pixels per source pixel inside an area of `areaCols` by `areaRows` cells, around the normalized
 * centre (`cx`, `cy`): smaller than the area it is centred, larger it shows the window around the centre (kept inside the image).
 */
export function placeAtScale(width: number, height: number, areaCols: number, areaRows: number, scale: number, cx = 0.5, cy = 0.5, grid: CellGrid = HALF_BLOCK_GRID): Placement {
  const areaW = Math.max(1, areaCols) * grid.x, areaH = Math.max(1, areaRows) * grid.y;
  const shownW = Math.min(width * scale, areaW), shownH = Math.min(height * scale, areaH);
  const cols = clamp(Math.round(shownW / grid.x), 1, Math.max(1, areaCols)), rows = clamp(Math.round(shownH / grid.y), 1, Math.max(1, areaRows));
  const cropWidth = Math.min(width, cols * grid.x / scale), cropHeight = Math.min(height, rows * grid.y / scale);
  const x = clamp(cx * width - cropWidth / 2, 0, width - cropWidth), y = clamp(cy * height - cropHeight / 2, 0, height - cropHeight);
  return {
    cols, rows, col: Math.max(0, Math.floor((areaCols - cols) / 2)), row: Math.max(0, Math.floor((areaRows - rows) / 2)),
    crop: {x, y, width: cropWidth, height: cropHeight}, scale,
    cx: width > cropWidth ? (x + cropWidth / 2) / width : 0.5, cy: height > cropHeight ? (y + cropHeight / 2) / height : 0.5,
    pannable: width * scale > areaW + 0.5 || height * scale > areaH + 0.5,
  };
}

/**
 * Area-averaging resample of `crop` to `outWidth` by `outHeight` (a box filter: every output pixel is the mean of the source pixels
 * it covers, partial pixels weighted by coverage), so a screenshot shrunk to a thumbnail keeps thin lines and text instead of
 * dropping them as nearest-neighbour sampling does. Colours are averaged premultiplied by alpha; the result is straight RGBA.
 */
export function resample(source: Raster, crop: Crop, outWidth: number, outHeight: number): Raster {
  const outW = Math.max(1, Math.round(outWidth)), outH = Math.max(1, Math.round(outHeight));
  const out = new Uint8ClampedArray(outW * outH * 4), {width, height, data} = source;
  const stepX = crop.width / outW, stepY = crop.height / outH;
  // Per output column: the first source column, how many it spans and the coverage weight of each (shared by every output row).
  const spans: {first: number; weights: number[]}[] = [];
  for (let ox = 0; ox < outW; ox++) {
    const from = crop.x + ox * stepX, to = from + stepX, first = Math.max(0, Math.floor(from)), last = Math.min(width, Math.ceil(to)), weights: number[] = [];
    for (let ix = first; ix < last; ix++) weights.push(Math.max(0, Math.min(to, ix + 1) - Math.max(from, ix)));
    spans.push({first, weights});
  }
  for (let oy = 0; oy < outH; oy++) {
    const from = crop.y + oy * stepY, to = from + stepY, firstRow = Math.max(0, Math.floor(from)), lastRow = Math.min(height, Math.ceil(to));
    for (let ox = 0; ox < outW; ox++) {
      const span = spans[ox]!;
      let r = 0, g = 0, b = 0, a = 0, total = 0;
      for (let iy = firstRow; iy < lastRow; iy++) {
        const wy = Math.max(0, Math.min(to, iy + 1) - Math.max(from, iy));
        if (wy === 0) continue;
        let at = (iy * width + span.first) * 4;
        for (const wx of span.weights) {
          const weight = wx * wy, alpha = data[at + 3]! / 255 * weight;
          r += data[at]! * alpha; g += data[at + 1]! * alpha; b += data[at + 2]! * alpha; a += alpha; total += weight;
          at += 4;
        }
      }
      const index = (oy * outW + ox) * 4;
      if (a > 0) {out[index] = r / a; out[index + 1] = g / a; out[index + 2] = b / a;}
      out[index + 3] = total > 0 ? a / total * 255 : 0;
    }
  }
  return {width: outW, height: outH, data: out};
}

/** Shrinks a raster so its long edge is at most `edge` (the same raster when it already fits). */
export function shrinkTo(source: Raster, edge: number): Raster {
  const long = Math.max(source.width, source.height);
  if (long <= edge) return source;
  const factor = edge / long;
  return resample(source, {x: 0, y: 0, width: source.width, height: source.height}, Math.max(1, Math.round(source.width * factor)), Math.max(1, Math.round(source.height * factor)));
}

/** Composites a raster over a background colour into three bytes per pixel. */
export function flatten(source: Raster, background: Rgb): Uint8Array {
  const out = new Uint8Array(source.width * source.height * 3), {data} = source;
  for (let pixel = 0, count = source.width * source.height; pixel < count; pixel++) {
    const alpha = data[pixel * 4 + 3]! / 255;
    out[pixel * 3] = Math.round(data[pixel * 4]! * alpha + background.r * (1 - alpha));
    out[pixel * 3 + 1] = Math.round(data[pixel * 4 + 1]! * alpha + background.g * (1 - alpha));
    out[pixel * 3 + 2] = Math.round(data[pixel * 4 + 2]! * alpha + background.b * (1 - alpha));
  }
  return out;
}

const hex2 = (value: number): string => value.toString(16).padStart(2, '0');
export const toHex = (r: number, g: number, b: number): string => '#' + hex2(r) + hex2(g) + hex2(b);
/** `#rrggbb` (or `#rgb`) to its channels; black for anything else. */
export function parseHex(color: string): Rgb {
  const text = /^#([\da-f]{3}|[\da-f]{6})/i.exec(color)?.[1];
  if (!text) return {r: 0, g: 0, b: 0};
  const full = text.length === 3 ? [...text].map(char => char + char).join('') : text;
  return {r: parseInt(full.slice(0, 2), 16), g: parseInt(full.slice(2, 4), 16), b: parseInt(full.slice(4, 6), 16)};
}

/** Upper half blocks: the foreground is the cell's top pixel, the background its bottom pixel; equal neighbours share a run. */
export const halfBlockBackend: ImageBackend = {
  id: 'half-block',
  grid: HALF_BLOCK_GRID,
  render(rgb, cols, rows) {
    const result: ImageRow[] = [];
    for (let row = 0; row < rows; row++) {
      const runs: ImageRun[] = [];
      for (let col = 0; col < cols; col++) {
        const top = (row * 2 * cols + col) * 3, bottom = ((row * 2 + 1) * cols + col) * 3;
        const color = toHex(rgb[top]!, rgb[top + 1]!, rgb[top + 2]!), bg = toHex(rgb[bottom]!, rgb[bottom + 1]!, rgb[bottom + 2]!);
        const last = runs.at(-1);
        if (last && last.color === color && last.bg === bg) runs[runs.length - 1] = {...last, text: last.text + '▀'};
        else runs.push({text: '▀', color, bg});
      }
      result.push(runs);
    }
    return result;
  },
};

/** Crop to cells: the rows of `crop` of `source` drawn into `cols` by `rows` cells over `background`. */
export function renderCrop(source: Raster, crop: Crop, cols: number, rows: number, background: Rgb, backend: ImageBackend = halfBlockBackend): ImageRow[] {
  const small = resample(source, crop, cols * backend.grid.x, rows * backend.grid.y);
  return backend.render(flatten(small, background), cols, rows);
}
