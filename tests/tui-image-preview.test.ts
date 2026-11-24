import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, utimes, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import jpeg from 'jpeg-js';
import pngjs from 'pngjs';
import {
  HALF_BLOCK_GRID, fitScale, fitThumbnail, flatten, halfBlockBackend, parseHex, placeAtScale, renderCrop, resample, shrinkTo, toHex, type Raster,
} from '../src/tui/terminal/image-raster.js';
import {clearImages, imageSettled, imageState, retryImage} from '../src/tui/terminal/image-source.js';
import {thumbnailRows} from '../src/tui/timeline/image-thumb.js';

const raster = (width: number, height: number, pixel: (x: number, y: number) => readonly [number, number, number, number]): Raster => {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 4);
  return {width, height, data};
};
const png = (image: Raster): Buffer => pngjs.PNG.sync.write({width: image.width, height: image.height, data: Buffer.from(image.data)} as never);
async function withDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'logox-test-'));
  try {return await run(dir);} finally {await rm(dir, {recursive: true, force: true});}
}

test('thumbnail fit: the long edge is capped, the ratio is clamped to [0.25, 4] and the box is never larger than the picture', () => {
  const square = fitThumbnail(1000, 1000, 36);
  assert.deepEqual([square.cols, square.rows, square.cropped], [36, 18, false], 'a square is 36 columns by 18 rows (a cell is two pixels tall)');
  assert.deepEqual(square.crop, {x: 0, y: 0, width: 1000, height: 1000});
  const wide = fitThumbnail(4000, 500, 36);
  assert.equal(wide.cols, 36); assert.equal(wide.rows, 5, 'ratio 8 is clamped to 4: nine pixel rows');
  assert.ok(wide.cropped && wide.crop.x === 0 && wide.crop.y === 0, 'a very wide image keeps its LEFT');
  assert.ok(Math.abs(wide.crop.width / wide.crop.height - 36 / 10) < 0.2, 'the crop has the box aspect');
  const tall = fitThumbnail(500, 4000, 36);
  assert.equal(tall.rows, 18); assert.equal(tall.cols, 9, 'ratio 0.125 is clamped to 0.25');
  assert.ok(tall.cropped && tall.crop.y === 0, 'a very tall image keeps its TOP');
  assert.deepEqual([tall.crop.x, tall.crop.width, tall.crop.height], [0, 500, 2000], 'the whole width and the top 2000 rows');
  const small = fitThumbnail(20, 10, 36);
  assert.deepEqual([small.cols, small.rows], [20, 5], 'a small picture is not upscaled');
  assert.equal(fitThumbnail(1, 1, 36).cols, 1);
  const mild = fitThumbnail(3000, 1000, 36);
  assert.ok(!mild.cropped && mild.cols === 36 && mild.rows === 6, 'ratio 3 is inside the clamp: nothing is cropped away');
});

test('lightbox placement: fits as large as the area allows, centres, and windows a zoomed picture around its centre', () => {
  const scale = fitScale(100, 50, 40, 10);
  assert.equal(scale, 0.4);
  const fit = placeAtScale(100, 50, 40, 10, scale);
  assert.deepEqual([fit.cols, fit.rows, fit.col, fit.row, fit.pannable], [40, 10, 0, 0, false]);
  const tall = placeAtScale(10, 100, 40, 10, fitScale(10, 100, 40, 10));
  assert.deepEqual([tall.cols, tall.rows, tall.col], [2, 10, 19], 'a tall picture is centred in the area');
  const full = placeAtScale(100, 50, 40, 10, 1);
  assert.ok(full.pannable); assert.deepEqual([full.cols, full.rows], [40, 10]);
  assert.deepEqual([full.crop.x, full.crop.width, full.crop.height], [30, 40, 20], 'the window is centred on the image');
  const left = placeAtScale(100, 50, 40, 10, 1, 0, 0);
  assert.deepEqual([left.crop.x, left.crop.y, left.cx], [0, 0, 0.2], 'a centre near the edge is kept inside the picture');
  const small = placeAtScale(8, 4, 40, 10, 1);
  assert.deepEqual([small.cols, small.rows, small.col, small.pannable], [8, 2, 16, false], '100% of a tiny picture is tiny');
});

test('resampling averages every covered pixel (area averaging), weights alpha, and keeps thin lines', () => {
  const checker = raster(2, 2, (x, y) => (x + y) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]);
  const mean = resample(checker, {x: 0, y: 0, width: 2, height: 2}, 1, 1);
  assert.ok(Math.abs(mean.data[0]! - 127.5) <= 1, 'nearest-neighbour would answer 0 or 255');
  const lines = raster(8, 8, x => x === 3 ? [255, 255, 255, 255] : [0, 0, 0, 255]);
  const thin = resample(lines, {x: 0, y: 0, width: 8, height: 8}, 2, 2);
  assert.ok(thin.data[0]! > 0 && thin.data[4]! === 0 || thin.data[0]! === 0 && thin.data[4]! > 0, 'a one-pixel line survives as brightness');
  const clear = raster(2, 1, x => x === 0 ? [255, 0, 0, 255] : [0, 0, 255, 0]);
  const blended = resample(clear, {x: 0, y: 0, width: 2, height: 1}, 1, 1);
  assert.deepEqual([...blended.data], [255, 0, 0, 128], 'a transparent pixel adds no colour, only transparency');
  const partial = resample(raster(2, 1, x => x === 0 ? [0, 0, 0, 255] : [200, 200, 200, 255]), {x: 0.5, y: 0, width: 1, height: 1}, 1, 1);
  assert.ok(Math.abs(partial.data[0]! - 100) <= 1, 'a crop starting mid-pixel weights the partial pixels by coverage');
  assert.deepEqual([...flatten({width: 1, height: 1, data: new Uint8Array([255, 0, 0, 128])}, parseHex('#000000'))], [128, 0, 0]);
  const shrunk = shrinkTo(raster(100, 50, () => [9, 9, 9, 255]), 20);
  assert.deepEqual([shrunk.width, shrunk.height], [20, 10]);
  assert.equal(shrinkTo(checker, 20), checker, 'a picture within the edge is returned as is');
});

test('half-block rendering: the top pixel is the foreground, the bottom pixel the background, equal cells share a run', () => {
  const rgb = new Uint8Array([
    255, 0, 0, 0, 255, 0, // row 0 (top of cell row 0): red, green
    0, 0, 255, 0, 0, 255, // row 1 (bottom): blue, blue
  ]);
  assert.deepEqual(halfBlockBackend.render(rgb, 2, 1), [[{text: '▀', color: '#ff0000', bg: '#0000ff'}, {text: '▀', color: '#00ff00', bg: '#0000ff'}]]);
  const same = new Uint8Array([255, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 255]);
  assert.deepEqual(halfBlockBackend.render(same, 2, 1), [[{text: '▀▀', color: '#ff0000', bg: '#0000ff'}]]);
  assert.equal(toHex(1, 2, 255), '#0102ff'); assert.deepEqual(parseHex('#abc'), {r: 170, g: 187, b: 204});
  assert.deepEqual(HALF_BLOCK_GRID, {x: 1, y: 2});
  const four = raster(2, 4, (x, y) => [y * 60, x * 100, 0, 255]);
  const rows = renderCrop(four, {x: 0, y: 0, width: 2, height: 4}, 2, 2, parseHex('#000000'));
  assert.equal(rows.length, 2); assert.equal(rows[0]![0]!.color, '#000000'); assert.equal(rows[1]![1]!.bg, '#b46400');
});

test('decoding: a synthetic PNG and JPEG become cached rasters off the call, thumbnails come from them, failures are explained', async () => {
  clearImages();
  await withDir(async dir => {
    const picture = raster(4, 4, (x, y) => y < 2 ? [255, 0, 0, 255] : [0, 0, 255, 255]);
    const file = join(dir, 'tiny.png');
    await writeFile(file, png(picture));
    assert.equal(imageState(file).status, 'loading', 'the first call never decodes: it answers loading and starts the work');
    const ready = await imageSettled(file);
    assert.equal(ready.status, 'ready');
    if (ready.status !== 'ready') return;
    assert.deepEqual([ready.image.width, ready.image.height, ready.image.format], [4, 4, 'png']);
    const again = imageState(file);
    assert.ok(again.status === 'ready' && again.image === ready.image, 'later calls hit the cache: no second decode');
    const thumb = thumbnailRows(ready.image, 36, '#000000');
    assert.deepEqual([thumb.cols, thumb.rows.length], [4, 2], 'a 4 by 4 image is 4 columns by 2 rows (never upscaled)');
    assert.deepEqual(thumb.rows[0], [{text: '▀▀▀▀', color: '#ff0000', bg: '#ff0000'}]);
    assert.deepEqual(thumb.rows[1], [{text: '▀▀▀▀', color: '#0000ff', bg: '#0000ff'}]);
    assert.equal(thumbnailRows(ready.image, 36, '#000000'), thumb, 'the rows are memoized per size and background');
    // A rewritten file is a new cache entry (path, modification time and size are the key).
    await writeFile(file, png(raster(6, 2, () => [0, 255, 0, 255])));
    await utimes(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    const changed = await imageSettled(file);
    assert.ok(changed.status === 'ready' && changed.image.width === 6 && changed.image !== ready.image);

    const jpg = join(dir, 'tiny.jpg');
    await writeFile(jpg, jpeg.encode({width: 8, height: 8, data: Buffer.from(raster(8, 8, () => [200, 100, 50, 255]).data)}, 95).data);
    const decoded = await imageSettled(jpg);
    assert.ok(decoded.status === 'ready' && decoded.image.format === 'jpeg' && decoded.image.width === 8);
    if (decoded.status === 'ready') {
      const [r, g, b] = decoded.image.raster.data;
      assert.ok(Math.abs(r! - 200) < 12 && Math.abs(g! - 100) < 12 && Math.abs(b! - 50) < 12);
    }

    const gif = join(dir, 'a.gif');
    await writeFile(gif, Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(40)]));
    const unsupported = await imageSettled(gif);
    assert.ok(unsupported.status === 'failed' && /not supported/.test(unsupported.reason), JSON.stringify(unsupported));
    const broken = join(dir, 'broken.png');
    await writeFile(broken, Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(40)]));
    const bad = await imageSettled(broken);
    assert.ok(bad.status === 'failed' && /cannot decode/.test(bad.reason), JSON.stringify(bad));
    assert.deepEqual(imageState(join(dir, 'missing.png')), {status: 'failed', reason: 'file not found'});
    // A failure is remembered until it is retried.
    retryImage(broken);
    assert.equal(imageState(broken).status, 'loading');
    await imageSettled(broken);
  });
});

test('decoding caps work: a huge declared PNG is refused from its header before any pixels are inflated', async () => {
  clearImages();
  await withDir(async dir => {
    const header = Buffer.alloc(33); Buffer.from('89504e470d0a1a0a', 'hex').copy(header); header.writeUInt32BE(13, 8); header.write('IHDR', 12, 'latin1');
    header.writeUInt32BE(20000, 16); header.writeUInt32BE(20000, 20);
    const file = join(dir, 'huge.png'); await writeFile(file, header);
    const state = await imageSettled(file);
    assert.ok(state.status === 'failed' && /too large/.test(state.reason), JSON.stringify(state));
  });
});
