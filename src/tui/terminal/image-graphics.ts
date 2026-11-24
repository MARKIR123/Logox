// The terminal's image capability and the Sixel encoder behind it, as one process-wide service (like `terminalFocus()`): the probe result,
// the cell size in pixels, the grid renderers fit images to, and a cache of encoded regions filled by a worker thread.
// Callers ask `encoded(spec)`: a cached Sixel string, or undefined while a worker encodes it (listeners are told when it lands).
import {appendFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Worker} from 'node:worker_threads';
import {HALF_BLOCK_GRID, parseHex, type CellGrid, type Crop} from './image-raster.js';
import type {DecodedImage} from './image-source.js';
import {touchImages} from './image-source.js';
import {DEFAULT_CELL, IMAGE_PROBE, extractReplies, parseChoice, resolveCellSize, selectProtocol, type CellPixels, type ImageProtocol, type ProtocolChoice} from './image-protocol.js';
import {handle, type WorkerReply, type WorkerRequest} from './sixel-worker.js';

/** One encoded region: `crop` (file pixels) of `image`, `outWidth` by `outHeight` screen pixels, flattened onto `bg`. */
export interface EncodeSpec {readonly image: DecodedImage; readonly crop: Crop; readonly outWidth: number; readonly outHeight: number; readonly bg: string}
/** What a timeline row says about the picture it belongs to: the plane gathers the rows of one picture into a placement. */
export interface ImageSlot {
  readonly id: string;
  readonly slot: number;
  readonly slots: number;
  /** Columns between the row's content edge and the picture. */
  readonly indent: number;
  readonly cols: number;
  readonly spec: EncodeSpec;
}

const DEBUG = Boolean(process.env['LOGOX_IMAGE_DEBUG']);
/** Timing lines for `LOGOX_IMAGE_DEBUG=1`, appended to `<tmp>/logox-image-debug.log` (never to the terminal). */
export function debugLog(line: string): void {
  if (DEBUG) try {appendFileSync(join(tmpdir(), 'logox-image-debug.log'), new Date().toISOString().slice(11, 23) + ' ' + line + '\n');} catch {/* diagnostics only */}
}
export const IMAGE_DEBUG = DEBUG;
const CACHE_BYTES = 48 * 1024 * 1024, MAX_ENCODED = 6 * 1024 * 1024;

class ImageGraphics {
  private choice: ProtocolChoice = parseChoice(process.env['LOGOX_IMAGE_PROTOCOL']);
  private current: ImageProtocol = 'halfblock';
  private pixels: CellPixels = DEFAULT_CELL;
  private measured = false;
  private readonly cache = new Map<string, string>();
  private cacheBytes = 0;
  private readonly pending = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private ids = new WeakMap<DecodedImage, number>();
  private nextId = 1;
  private worker: Worker | undefined;
  private workerBroken = process.env['LOGOX_IMAGE_WORKER'] === '0';
  private nextRequest = 1;
  private readonly waiting = new Map<number, {key: string; spec: EncodeSpec; retried: boolean; at: number}>();
  private readonly sent = new Set<number>();
  private probed = false;
  private readonly laneBusy = new Map<string, string>();
  private readonly laneNext = new Map<string, {key: string; spec: EncodeSpec}>();
  private readonly laneOf = new Map<string, string>();
  private readonly dropped = new Set<string>();
  private probing: {done(): void; timer: ReturnType<typeof setTimeout>} | undefined;
  private partial: {window?: CellPixels; cell?: CellPixels; columns: number; rows: number} = {columns: 80, rows: 24};

  get protocol(): ImageProtocol {return this.current;}
  /** True when pictures are drawn as Sixel pixels. */
  get active(): boolean {return this.current === 'sixel';}
  get cell(): CellPixels {return this.pixels;}
  get cellMeasured(): boolean {return this.measured;}
  /** Pixels per cell the fit math works in: the real cell for Sixel, a 1 x 2 virtual pixel for half blocks. */
  grid(): CellGrid {return this.current === 'sixel' ? {x: this.pixels.width, y: this.pixels.height} : HALF_BLOCK_GRID;}
  subscribe(listener: () => void): () => void {this.listeners.add(listener); return () => {this.listeners.delete(listener);};}
  private notify(): void {for (const listener of [...this.listeners]) listener();}

  /** Sets the protocol directly (tests, config). */
  configure(options: {readonly choice?: ProtocolChoice; readonly protocol?: ImageProtocol; readonly cell?: CellPixels}): void {
    if (options.choice) this.choice = options.choice;
    const before = this.current + this.pixels.width + 'x' + this.pixels.height;
    if (options.protocol) this.current = options.protocol;
    if (options.cell) {this.pixels = options.cell; this.measured = true;}
    if (before !== this.current + this.pixels.width + 'x' + this.pixels.height) {this.cache.clear(); this.cacheBytes = 0; touchImages(); this.notify();}
  }

  /**
   * Asks the terminal what it can draw (once, at startup). The replies come back on stdin: the caller routes every chunk through
   * `feed()` and forwards the returned text to the key parser, so the probe never disturbs it.
   */
  probe(write: (text: string) => void, columns: number, rows: number, timeoutMs = 700): Promise<void> {
    if (this.probed) return Promise.resolve();
    this.probed = true;
    this.partial = {columns, rows};
    if (this.choice === 'halfblock') return Promise.resolve();
    return new Promise(resolve => {
      const timer = setTimeout(() => this.finishProbe(undefined), timeoutMs);
      timer.unref?.();
      this.probing = {done: resolve, timer};
      write(IMAGE_PROBE);
    });
  }
  /** Takes the probe replies out of a stdin chunk; returns the rest. */
  feed(chunk: string): string {
    const {text, replies} = extractReplies(chunk);
    for (const reply of replies) {
      if (reply.kind === 'cell') this.partial.cell = {width: reply.width, height: reply.height};
      else if (reply.kind === 'window') this.partial.window = {width: reply.width, height: reply.height};
      else this.finishProbe(reply.attributes);
    }
    return text;
  }
  private finishProbe(attributes: readonly number[] | undefined): void {
    const probing = this.probing;
    if (!probing) return;
    this.probing = undefined; clearTimeout(probing.timer);
    const cell = resolveCellSize(this.partial.cell, this.partial.window, this.partial.columns, this.partial.rows);
    this.configure({protocol: selectProtocol(this.choice, attributes), ...(cell ? {cell} : {})});
    probing.done();
  }

  private assetId(image: DecodedImage): number {
    let id = this.ids.get(image);
    if (id === undefined) {id = this.nextId++; this.ids.set(image, id);}
    return id;
  }
  keyOf(spec: EncodeSpec): string {
    const {crop} = spec;
    return [this.assetId(spec.image), Math.round(crop.x * 10), Math.round(crop.y * 10), Math.round(crop.width * 10), Math.round(crop.height * 10), spec.outWidth, spec.outHeight, spec.bg].join('|');
  }
  /** The Sixel stream for `spec` when it is ready; otherwise starts encoding it and returns undefined. */
  encoded(spec: EncodeSpec, lane?: string): string | undefined {
    const key = this.keyOf(spec), known = this.cache.get(key);
    if (known !== undefined) {this.cache.delete(key); this.cache.set(key, known); return known;}
    this.dropped.delete(key);
    if (!this.pending.has(key)) {
      this.pending.add(key);
      if (lane) this.enqueue(lane, key, spec); else this.submit(key, spec);
    }
    return undefined;
  }
  /**
   * Latest wins inside a lane (the lightbox's picture): one encode in flight, a newer request replaces the one waiting instead of queueing
   * behind it, and a result that is no longer wanted is dropped without being cached or announced.
   */
  private enqueue(lane: string, key: string, spec: EncodeSpec): void {
    this.laneOf.set(key, lane);
    if (this.laneBusy.has(lane)) {
      const replaced = this.laneNext.get(lane);
      if (replaced) {this.pending.delete(replaced.key); this.laneOf.delete(replaced.key);}
      this.laneNext.set(lane, {key, spec});
      return;
    }
    this.laneBusy.set(lane, key);
    this.submit(key, spec);
  }
  private advance(key: string): void {
    const lane = this.laneOf.get(key);
    if (!lane) return;
    this.laneOf.delete(key);
    if (this.laneBusy.get(lane) !== key) return;
    this.laneBusy.delete(lane);
    const next = this.laneNext.get(lane);
    if (!next) return;
    this.laneNext.delete(lane); this.laneBusy.set(lane, next.key);
    this.submit(next.key, next.spec);
  }
  /** Forgets what a lane has waiting and drops the result of what it has in flight. */
  cancelLane(lane: string): void {
    const next = this.laneNext.get(lane);
    if (next) {this.pending.delete(next.key); this.laneOf.delete(next.key); this.laneNext.delete(lane);}
    const flying = this.laneBusy.get(lane);
    if (flying) this.dropped.add(flying);
  }
  private store(key: string, data: string): void {
    this.pending.delete(key);
    this.advance(key);
    if (this.dropped.delete(key) || data.length > MAX_ENCODED) return;
    this.cache.set(key, data); this.cacheBytes += data.length;
    while (this.cacheBytes > CACHE_BYTES && this.cache.size > 1) {
      const oldest = this.cache.keys().next().value as string;
      this.cacheBytes -= this.cache.get(oldest)!.length; this.cache.delete(oldest);
    }
    this.notify();
  }
  private request(key: string, spec: EncodeSpec, withAsset: boolean): WorkerRequest {
    const assetId = this.assetId(spec.image), raster = spec.image.raster, id = this.nextRequest++;
    this.waiting.set(id, {key, spec, retried: withAsset, at: performance.now()});
    const scale = raster.width / spec.image.width, sy = raster.height / spec.image.height;
    return {id, assetId, ...(withAsset ? {asset: {width: raster.width, height: raster.height, data: raster.data as Uint8Array}} : {}),
      crop: {x: spec.crop.x * scale, y: spec.crop.y * sy, width: spec.crop.width * scale, height: spec.crop.height * sy},
      outWidth: spec.outWidth, outHeight: spec.outHeight, background: parseHex(spec.bg)};
  }
  private submit(key: string, spec: EncodeSpec): void {
    if (!this.workerBroken && !this.worker) {
      try {
        const worker = new Worker(new URL('./sixel-worker.js', import.meta.url));
        worker.unref();
        worker.on('message', (reply: WorkerReply) => this.reply(reply));
        worker.on('error', () => this.breakWorker());
        worker.on('exit', () => {this.worker = undefined; this.sent.clear();});
        this.worker = worker;
      } catch {this.workerBroken = true;}
    }
    const assetId = this.assetId(spec.image);
    if (this.worker) {
      const first = !this.sent.has(assetId);
      this.sent.add(assetId);
      this.worker.postMessage(this.request(key, spec, first));
      return;
    }
    // No worker thread available: encode in this process, but never inside the call that asked.
    setImmediate(() => this.reply(handle(this.request(key, spec, true))));
  }
  private breakWorker(): void {
    this.workerBroken = true; this.worker = undefined; this.sent.clear();
    for (const [id, item] of [...this.waiting]) {this.waiting.delete(id); this.submit(item.key, item.spec);}
  }
  private reply(reply: WorkerReply): void {
    const item = this.waiting.get(reply.id);
    if (!item) return;
    this.waiting.delete(reply.id);
    if ('data' in reply) {
      if (DEBUG) debugLog(`encode round trip ${Math.round(performance.now() - item.at)} ms, ${reply.data.length} bytes, ${item.spec.outWidth}x${item.spec.outHeight} px`);
      this.store(item.key, reply.data); return;
    }
    if ('missing' in reply && !item.retried && this.worker) {
      // The worker dropped the raster (its own cache limit): send it again with the request.
      this.sent.delete(this.assetId(item.spec.image));
      this.submit(item.key, item.spec);
      return;
    }
    this.pending.delete(item.key); this.dropped.delete(item.key);
    this.advance(item.key);
  }
  /** Stops the worker thread (end of the program or of a test). */
  dispose(): void {void this.worker?.terminate(); this.worker = undefined; this.sent.clear();}
  /** Forgets cached encodings (tests). */
  clear(): void {this.cache.clear(); this.cacheBytes = 0; this.pending.clear(); this.laneBusy.clear(); this.laneNext.clear(); this.laneOf.clear(); this.dropped.clear();}
}

export const imageGraphics = new ImageGraphics();
