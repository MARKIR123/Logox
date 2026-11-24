// Worker thread: resamples, quantises and Sixel-encodes image regions so the render path never pays for it. It keeps the decoded rasters
// it was sent (small LRU) so scrolling, hovering and re-placing a picture send only a region request.
import {parentPort} from 'node:worker_threads';
import type {Crop, Raster, Rgb} from './image-raster.js';
import {encodeSixel, paletteOf, type SharedPalette} from './sixel.js';

export interface WorkerRequest {
  readonly id: number;
  readonly assetId: number;
  readonly asset?: {readonly width: number; readonly height: number; readonly data: Uint8Array};
  readonly crop: Crop;
  readonly outWidth: number;
  readonly outHeight: number;
  readonly background: Rgb;
}
export type WorkerReply = {readonly id: number; readonly data: string} | {readonly id: number; readonly missing: true} | {readonly id: number; readonly error: true};

const assets = new Map<number, Raster>();
/** One palette per picture, built from the whole image the first time and reused for every region and zoom. `builds` counts them (tests). */
const palettes = new Map<number, SharedPalette>();
export const stats = {palettes: 0};
const MAX_ASSET_BYTES = 96 * 1024 * 1024;
function remember(id: number, raster: Raster): void {
  assets.delete(id); assets.set(id, raster);
  let bytes = 0;
  for (const value of assets.values()) bytes += value.data.length;
  while (bytes > MAX_ASSET_BYTES && assets.size > 1) {
    const oldest = assets.keys().next().value as number;
    bytes -= assets.get(oldest)!.data.length; assets.delete(oldest); palettes.delete(oldest);
  }
}
/** The request handler, shared with the in-process fallback. */
export function handle(request: WorkerRequest): WorkerReply {
  try {
    if (request.asset) remember(request.assetId, {width: request.asset.width, height: request.asset.height, data: request.asset.data});
    const raster = assets.get(request.assetId);
    if (!raster) return {id: request.id, missing: true};
    let shared = palettes.get(request.assetId);
    if (!shared) {shared = paletteOf(raster, request.background); palettes.set(request.assetId, shared); stats.palettes++;}
    return {id: request.id, data: encodeSixel(raster, request.crop, request.outWidth, request.outHeight, request.background, shared)};
  } catch {
    return {id: request.id, error: true}; // never echo pixels or diagnostics to the terminal
  }
}
parentPort?.on('message', (request: WorkerRequest) => parentPort?.postMessage(handle(request)));
