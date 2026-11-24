// Image decoding for the terminal preview, off the render path: `imageState()` answers at once from a cache keyed by file path,
// modification time and size, and starts a background decode the first time a file is asked for. Subscribers (the app) are told
// when a decode ends so the timeline re-lays out; scrolling never decodes again. PNG and JPEG are decoded (pure JavaScript);
// anything else reports `unsupported`. Decoded pixels are kept at most `RASTER_EDGE` pixels on the long edge, plus a small copy
// (`MIP_EDGE`) that thumbnails are made from.
import {statSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import jpeg from 'jpeg-js';
import pngjs from 'pngjs';
import {shrinkTo, type Raster} from './image-raster.js';

export const MAX_FILE_BYTES = 48 * 1024 * 1024, MAX_PIXELS = 64_000_000, RASTER_EDGE = 2048, MIP_EDGE = 192, CACHE_ENTRIES = 12, CACHE_BYTES = 160 * 1024 * 1024;

export interface DecodedImage {
  /** Size of the file's image, in pixels (the rasters below may be smaller). */
  readonly width: number;
  readonly height: number;
  readonly format: 'png' | 'jpeg';
  /** At most `RASTER_EDGE` on the long edge; what the lightbox draws from. */
  readonly raster: Raster;
  /** At most `MIP_EDGE` on the long edge; what thumbnails draw from. */
  readonly mip: Raster;
}
export type ImageState =
  | {readonly status: 'loading'}
  | {readonly status: 'ready'; readonly image: DecodedImage}
  | {readonly status: 'failed'; readonly reason: string};

interface Entry {state: ImageState; readonly path: string; used: number; bytes: number}
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let revision = 0, clock = 0;

/** Bumped whenever a decode ends or an entry is dropped; layouts that show an image include it in their cache key. */
export const imageRevision = (): number => revision;
export function subscribeImages(listener: () => void): () => void {listeners.add(listener); return () => {listeners.delete(listener);};}
function changed(): void {revision++; for (const listener of [...listeners]) listener();}

const isPng = (bytes: Uint8Array): boolean => bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
const isJpeg = (bytes: Uint8Array): boolean => bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8;

/** Decodes a PNG or JPEG file's bytes (synchronously; callers keep this off the render path). Throws an `Error` whose message is the reason. */
export function decodeImage(bytes: Buffer): DecodedImage {
  let width: number, height: number, data: Uint8Array, format: 'png' | 'jpeg';
  if (isPng(bytes)) {
    if (bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > MAX_PIXELS) throw new Error('too large to preview');
    try {({width, height, data} = pngjs.PNG.sync.read(bytes));} catch {throw new Error('cannot decode PNG');}
    format = 'png';
  } else if (isJpeg(bytes)) {
    try {({width, height, data} = jpeg.decode(bytes, {useTArray: true, formatAsRGBA: true, tolerantDecoding: true, maxResolutionInMP: MAX_PIXELS / 1e6, maxMemoryUsageInMB: 768}));}
    catch (error) {throw new Error(/maxResolution|maxMemory/i.test(String(error)) ? 'too large to preview' : 'cannot decode JPEG');}
    format = 'jpeg';
  } else throw new Error('format not supported (PNG and JPEG only)');
  if (!(width > 0 && height > 0)) throw new Error('empty image');
  const full: Raster = {width, height, data};
  const raster = shrinkTo(full, RASTER_EDGE);
  const mip = Math.max(raster.width, raster.height) > MIP_EDGE ? shrinkTo(raster, MIP_EDGE) : raster;
  return {width, height, format, raster, mip};
}

function evict(): void {
  let bytes = 0;
  for (const entry of entries.values()) bytes += entry.bytes;
  while (entries.size > CACHE_ENTRIES || bytes > CACHE_BYTES) {
    const oldest = [...entries.entries()].filter(([, entry]) => entry.state.status !== 'loading').sort((a, b) => a[1].used - b[1].used)[0];
    if (!oldest) return;
    bytes -= oldest[1].bytes;
    entries.delete(oldest[0]);
  }
}

async function load(key: string, entry: Entry): Promise<void> {
  try {
    await new Promise<void>(resolve => setImmediate(resolve)); // never decode inside the call that asked
    const bytes = await readFile(entry.path);
    if (bytes.length > MAX_FILE_BYTES) throw new Error('too large to preview');
    await new Promise<void>(resolve => setImmediate(resolve));
    const image = decodeImage(bytes);
    entry.state = {status: 'ready', image};
    entry.bytes = image.raster.data.length + image.mip.data.length;
  } catch (error) {
    entry.state = {status: 'failed', reason: error instanceof Error && error.message && !/^(ENOENT|EACCES|EPERM|EISDIR)/.test(error.message) ? error.message : 'cannot read the file'};
  }
  evict();
  if (entries.get(key) === entry) changed();
}

function keyOf(path: string): string | undefined {
  try {const info = statSync(path); return path + '|' + info.mtimeMs + '|' + info.size;} catch {return undefined;}
}

/** The decode state of an image file; starts the decode on the first call for this file version. Never blocks. */
export function imageState(path: string): ImageState {
  const key = keyOf(path);
  if (!key) return {status: 'failed', reason: 'file not found'};
  let entry = entries.get(key);
  if (!entry) {
    entry = {state: {status: 'loading'}, path, used: 0, bytes: 0};
    entries.set(key, entry);
    void load(key, entry);
  }
  entry.used = ++clock;
  return entry.state;
}
/** Forgets a failed decode of this file and tries again. */
export function retryImage(path: string): void {
  const key = keyOf(path), entry = key ? entries.get(key) : undefined;
  if (key && entry?.state.status === 'failed') {entries.delete(key); changed();}
}
/** Resolves once the file's decode has ended (for tests and callers that can wait). */
export async function imageSettled(path: string): Promise<ImageState> {
  for (let state = imageState(path); ; state = imageState(path)) {
    if (state.status !== 'loading') return state;
    await new Promise<void>(resolve => {const stop = subscribeImages(() => {stop(); resolve();});});
  }
}
/** Drops every cached decode (tests). */
export function clearImages(): void {entries.clear(); changed();}

/** Memoized thumbnail-size renders, kept beside the decoded image they came from. */
const derived = new WeakMap<DecodedImage, Map<string, unknown>>();
export function memoFor<T>(image: DecodedImage, key: string, make: () => T): T {
  let map = derived.get(image);
  if (!map) {map = new Map(); derived.set(image, map);}
  if (map.size > 24) map.clear();
  if (!map.has(key)) map.set(key, make());
  return map.get(key) as T;
}
