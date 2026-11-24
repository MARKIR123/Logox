// A small pure-JavaScript Sixel encoder: median-cut quantisation to at most 256 colours and band-by-band run-length encoding.
// Everything here is deterministic and free of I/O so it can run in a worker thread (`sixel-worker.ts`) and be tested on tiny images.
// The overall shape (an image quantised to one palette and emitted band by band with a shared palette) follows the approach of
// dsh-tui's `ink/sixel-codec.js` (MIT, https://github.com/ccch1mneyyy/dsh-TUI), which delegates to native libraries; this is Logox's own code.
import {flatten, resample, shrinkTo, type Crop, type Raster, type Rgb} from './image-raster.js';

export interface Quantized {
  /** Palette entries, three bytes each. */
  readonly palette: Uint8Array;
  /** One palette index per pixel. */
  readonly indices: Uint8Array;
}

/**
 * Median-cut quantisation over a 5-bit-per-channel histogram. Few distinct colours are kept exactly (to the histogram's precision);
 * more are split along their widest channel at the weighted median until `maxColors` boxes exist. Every box is represented by the
 * average of the real pixels in it, and each pixel is mapped through its histogram bin, so there is no per-pixel palette search.
 */
export function buildPalette(rgb: Uint8Array, pixels: number, maxColors = 256): SharedPalette {
  const count = new Uint32Array(32768), sumR = new Float64Array(32768), sumG = new Float64Array(32768), sumB = new Float64Array(32768);
  const binOf = new Uint16Array(pixels);
  for (let pixel = 0; pixel < pixels; pixel++) {
    const r = rgb[pixel * 3]!, g = rgb[pixel * 3 + 1]!, b = rgb[pixel * 3 + 2]!, bin = (r >> 3) << 10 | (g >> 3) << 5 | (b >> 3);
    binOf[pixel] = bin; count[bin]!++; sumR[bin]! += r; sumG[bin]! += g; sumB[bin]! += b;
  }
  const bins: number[] = [];
  for (let bin = 0; bin < 32768; bin++) if (count[bin]) bins.push(bin);
  const channel = (bin: number, axis: number): number => axis === 0 ? bin >> 10 : axis === 1 ? (bin >> 5) & 31 : bin & 31;
  let boxes: number[][] = [bins];
  while (boxes.length < maxColors) {
    let pick = -1, best = 0, axis = 0;
    for (let index = 0; index < boxes.length; index++) {
      const box = boxes[index]!;
      if (box.length < 2) continue;
      for (let a = 0; a < 3; a++) {
        let low = 31, high = 0;
        for (const bin of box) {const v = channel(bin, a); if (v < low) low = v; if (v > high) high = v;}
        const score = (high - low) * Math.sqrt(box.length);
        if (high > low && score > best) {best = score; pick = index; axis = a;}
      }
    }
    if (pick < 0) break;
    const box = boxes[pick]!.sort((a, b) => channel(a, axis) - channel(b, axis));
    let total = 0;
    for (const bin of box) total += count[bin]!;
    let run = 0, cut = 1;
    for (let at = 0; at < box.length - 1; at++) {run += count[box[at]!]!; cut = at + 1; if (run * 2 >= total) break;}
    boxes = [...boxes.slice(0, pick), box.slice(0, cut), box.slice(cut), ...boxes.slice(pick + 1)];
  }
  const palette = new Uint8Array(boxes.length * 3), lookup = new Uint8Array(32768);
  boxes.forEach((box, index) => {
    let n = 0, r = 0, g = 0, b = 0;
    for (const bin of box) {n += count[bin]!; r += sumR[bin]!; g += sumG[bin]!; b += sumB[bin]!; lookup[bin] = index;}
    palette[index * 3] = Math.round(r / n); palette[index * 3 + 1] = Math.round(g / n); palette[index * 3 + 2] = Math.round(b / n);
  });
  // Colours that never occur in the image (resampled regions average into new ones) map to the nearest palette entry.
  const entries = boxes.length;
  for (let bin = 0; bin < 32768; bin++) {
    if (count[bin]) continue;
    const r = ((bin >> 10) << 3) + 4, g = (((bin >> 5) & 31) << 3) + 4, b = ((bin & 31) << 3) + 4;
    let best = 0, distance = Infinity;
    for (let index = 0; index < entries; index++) {
      const dr = palette[index * 3]! - r, dg = palette[index * 3 + 1]! - g, db = palette[index * 3 + 2]! - b, d = dr * dr + dg * dg + db * db;
      if (d < distance) {distance = d; best = index;}
    }
    lookup[bin] = best;
  }
  return {palette, lookup};
}

/** A palette and the 5-bit-per-channel lookup that maps any colour to its entry, built once per image and reused for every region and zoom. */
export interface SharedPalette {readonly palette: Uint8Array; readonly lookup: Uint8Array}
/** Maps every pixel through a palette's lookup (no search, no median cut). */
export function mapPixels(rgb: Uint8Array, pixels: number, shared: SharedPalette): Quantized {
  const indices = new Uint8Array(pixels), {lookup} = shared;
  for (let pixel = 0; pixel < pixels; pixel++) indices[pixel] = lookup[(rgb[pixel * 3]! >> 3) << 10 | (rgb[pixel * 3 + 1]! >> 3) << 5 | (rgb[pixel * 3 + 2]! >> 3)]!;
  return {palette: shared.palette, indices};
}
export function quantize(rgb: Uint8Array, pixels: number, maxColors = 256): Quantized {return mapPixels(rgb, pixels, buildPalette(rgb, pixels, maxColors));}

/** The Sixel data stream for a quantised image: DCS, raster attributes (1:1 pixels), the palette, six-row bands, ST. Unpainted pixels stay transparent (P2 = 1). */
export function sixelData(image: Quantized, width: number, height: number): string {
  const {palette, indices} = image, colors = palette.length / 3;
  const parts: string[] = ['\x1bP0;1;0q"1;1;' + width + ';' + height];
  for (let index = 0; index < colors; index++) {
    parts.push('#' + index + ';2;' + Math.round(palette[index * 3]! * 100 / 255) + ';' + Math.round(palette[index * 3 + 1]! * 100 / 255) + ';' + Math.round(palette[index * 3 + 2]! * 100 / 255));
  }
  const planes: (Uint8Array | undefined)[] = new Array<Uint8Array | undefined>(colors).fill(undefined);
  const seen = new Uint8Array(colors);
  for (let top = 0; top < height; top += 6) {
    const used: number[] = [], bandHeight = Math.min(6, height - top);
    for (let dy = 0; dy < bandHeight; dy++) {
      const base = (top + dy) * width;
      for (let x = 0; x < width; x++) {
        const color = indices[base + x]!;
        let plane = planes[color];
        if (!plane) {plane = new Uint8Array(width); planes[color] = plane;}
        if (!seen[color]) {seen[color] = 1; used.push(color);}
        plane[x] = plane[x]! | (1 << dy);
      }
    }
    used.sort((a, b) => a - b);
    for (const [at, color] of used.entries()) {
      const plane = planes[color]!;
      let end = width;
      while (end > 0 && plane[end - 1] === 0) end--;
      let text = '#' + color;
      for (let x = 0; x < end;) {
        const value = plane[x]!;
        let run = 1;
        while (x + run < end && plane[x + run] === value) run++;
        const char = String.fromCharCode(63 + value);
        text += run > 3 ? '!' + run + char : char.repeat(run);
        x += run;
      }
      parts.push(text, at === used.length - 1 ? '-' : '$');
      plane.fill(0); seen[color] = 0;
    }
  }
  parts.push('\x1b\\');
  return parts.join('');
}

/** The palette of a whole picture (from a copy of at most 1024 px on the long edge), built once and shared by every region and zoom of it. */
export function paletteOf(source: Raster, background: Rgb): SharedPalette {
  const small = shrinkTo(source, 1024);
  return buildPalette(flatten(small, background), small.width * small.height);
}

/**
 * One Sixel image of `crop` of `source` at `outWidth` by `outHeight` pixels (area-averaged), flattened onto `background`. With a shared
 * palette the pixels are only mapped through its lookup; without one a palette is built for this region.
 */
export function encodeSixel(source: Raster, crop: Crop, outWidth: number, outHeight: number, background: Rgb, shared?: SharedPalette): string {
  const small = resample(source, crop, outWidth, outHeight), rgb = flatten(small, background), count = small.width * small.height;
  return sixelData(shared ? mapPixels(rgb, count, shared) : quantize(rgb, count), small.width, small.height);
}
