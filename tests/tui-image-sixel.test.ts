import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pngjs from 'pngjs';
import {DEFAULT_CELL, IMAGE_PROBE, extractReplies, parseChoice, resolveCellSize, selectProtocol, supportsSixel} from '../src/tui/terminal/image-protocol.js';
import {HALF_BLOCK_GRID, fitThumbnail, parseHex, placeAtScale, fitScale, type Raster} from '../src/tui/terminal/image-raster.js';
import {quantize, sixelData, encodeSixel} from '../src/tui/terminal/sixel.js';
import {imageGraphics} from '../src/tui/terminal/image-graphics.js';
import {clearImages, imageSettled} from '../src/tui/terminal/image-source.js';
import {TerminalPlane} from '../src/tui/terminal/terminal-plane.js';
import type {SceneRow} from '../src/tui/timeline/scene.js';
import {toolFixture} from './tool-fixture.js';
import {decodeSixel} from './sixel-decode.js';
import {waitFor} from './wait-for.js';

const raster = (width: number, height: number, pixel: (x: number, y: number) => readonly [number, number, number, number]): Raster => {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 4);
  return {width, height, data};
};

test('probe replies are parsed and removed from the stream; the protocol follows Device Attributes unless overridden', () => {
  assert.equal(IMAGE_PROBE, '\x1b[16t\x1b[14t\x1b[c', 'cell size, window size, then the Device Attributes barrier');
  const mixed = extractReplies('a\x1b[6;19;10tb\x1b[4;760;1000tc\x1b[?61;4;6;22cd');
  assert.equal(mixed.text, 'abcd');
  assert.deepEqual(mixed.replies, [{kind: 'cell', width: 10, height: 19}, {kind: 'window', width: 1000, height: 760}, {kind: 'attributes', attributes: [61, 4, 6, 22]}]);
  assert.deepEqual(extractReplies('\x1b[A\x1b[<0;3;4M plain'), {text: '\x1b[A\x1b[<0;3;4M plain', replies: []}, 'keys and mouse reports are left alone');
  assert.ok(supportsSixel([62, 4, 22]) && !supportsSixel([62, 22]) && !supportsSixel(undefined), 'Sixel is attribute 4');
  assert.equal(selectProtocol('auto', [61, 4]), 'sixel'); assert.equal(selectProtocol('auto', [62]), 'halfblock'); assert.equal(selectProtocol('auto', undefined), 'halfblock');
  assert.equal(selectProtocol('halfblock', [4]), 'halfblock', 'the override wins'); assert.equal(selectProtocol('sixel', undefined), 'sixel');
  assert.deepEqual([parseChoice('SIXEL'), parseChoice('half-block'), parseChoice('off'), parseChoice('nonsense'), parseChoice(undefined)], ['sixel', 'halfblock', 'halfblock', 'auto', 'auto']);
  assert.deepEqual(resolveCellSize({width: 10, height: 19}, undefined, 80, 24), {width: 10, height: 19});
  assert.deepEqual(resolveCellSize(undefined, {width: 800, height: 480}, 100, 30), {width: 8, height: 16}, 'derived from the text area');
  assert.equal(resolveCellSize(undefined, undefined, 80, 24), undefined); assert.equal(resolveCellSize({width: 0, height: 9999}, undefined, 80, 24), undefined);
  assert.deepEqual(DEFAULT_CELL, {width: 8, height: 16});
});

test('probing: the replies set the protocol and the measured cell size, and never reach the key parser', async () => {
  const written: string[] = [];
  const done = imageGraphics.probe(text => written.push(text), 100, 30, 2000);
  assert.deepEqual(written, [IMAGE_PROBE]);
  assert.equal(imageGraphics.feed('\x1b[6;20;10t'), '');
  assert.equal(imageGraphics.protocol, 'halfblock', 'not decided before the barrier reply');
  assert.equal(imageGraphics.feed('x\x1b[?62;4;22cy'), 'xy');
  await done;
  assert.equal(imageGraphics.protocol, 'sixel'); assert.deepEqual(imageGraphics.cell, {width: 10, height: 20});
  assert.deepEqual(imageGraphics.grid(), {x: 10, y: 20});
  await imageGraphics.probe(text => written.push(text), 100, 30);
  assert.equal(written.length, 1, 'a second probe is a no-op');
  imageGraphics.configure({protocol: 'halfblock'});
  assert.deepEqual(imageGraphics.grid(), HALF_BLOCK_GRID, 'half blocks fit to a 1 by 2 virtual pixel');
});

test('sixel encoder: a tiny image survives a round trip, the palette is capped, and unpainted bands are transparent', () => {
  const picture = raster(7, 8, (x, y) => y < 4 ? [255, 0, 0, 255] : x < 3 ? [0, 255, 0, 255] : [0, 0, 255, 255]);
  const flat = new Uint8Array(7 * 8 * 3);
  for (let i = 0; i < 56; i++) flat.set(picture.data.subarray(i * 4, i * 4 + 3), i * 3);
  const quantized = quantize(flat, 56);
  assert.equal(quantized.palette.length / 3, 3, 'three colours stay three palette entries');
  const text = sixelData(quantized, 7, 8);
  assert.ok(text.startsWith('\x1bP0;1;0q"1;1;7;8#0;2;'), text.slice(0, 40)); assert.ok(text.endsWith('\x1b\\'));
  assert.ok(text.includes('!7'), 'a run of seven equal columns is run-length encoded');
  const back = decodeSixel(encodeSixel(picture, {x: 0, y: 0, width: 7, height: 8}, 7, 8, parseHex('#000000')));
  assert.deepEqual([back.width, back.height], [7, 8]);
  const pixel = (x: number, y: number) => back.pixels[y * 7 + x]!;
  assert.deepEqual(pixel(0, 0), [255, 0, 0]); assert.deepEqual(pixel(6, 3), [255, 0, 0]);
  assert.deepEqual(pixel(1, 5), [0, 255, 0]); assert.deepEqual(pixel(5, 7), [0, 0, 255]);
  assert.ok(back.pixels.every(Boolean), 'every pixel is painted');
  const many = raster(64, 64, (x, y) => [x * 4, y * 4, (x * y) % 256, 255]);
  const flatMany = new Uint8Array(64 * 64 * 3);
  for (let i = 0; i < 4096; i++) flatMany.set(many.data.subarray(i * 4, i * 4 + 3), i * 3);
  assert.ok(quantize(flatMany, 4096).palette.length / 3 <= 256, 'never more than 256 colours');
  const half = encodeSixel(raster(2, 2, (x) => x ? [0, 0, 0, 0] : [9, 9, 250, 255]), {x: 0, y: 0, width: 2, height: 2}, 2, 2, parseHex('#ff0000'));
  assert.deepEqual(decodeSixel(half).pixels[1], [255, 0, 0], 'transparent pixels take the background');
});

test('pixel geometry: a cell is the measured pixel box, so 100% is one image pixel per screen pixel', () => {
  const cell = {x: 8, y: 16};
  const thumb = fitThumbnail(1280, 720, 36, cell);
  assert.deepEqual([thumb.cols, thumb.rows], [36, 10], '288 by 162 pixels in 36 by 10 cells');
  const small = fitThumbnail(100, 50, 36, cell);
  assert.deepEqual([small.cols, small.rows], [13, 3], 'never larger than its own pixels (100 px is 12.5 cells)');
  const actual = placeAtScale(1280, 720, 200, 60, 1, 0.5, 0.5, cell);
  assert.deepEqual([actual.cols, actual.rows, actual.crop.width, actual.crop.height, actual.pannable], [160, 45, 1280, 720, false], '1280 by 720 is 160 by 45 cells: the whole picture, 1:1');
  const fit = fitScale(1280, 720, 100, 30, cell);
  assert.ok(Math.abs(fit - 0.625) < 1e-9, 'fit shrinks only as far as the cell box in pixels requires');
  assert.equal(placeAtScale(1280, 720, 200, 60, 4, 0.5, 0.5, cell).pannable, true);
});

const bands = (): Buffer => pngjs.PNG.sync.write({width: 128, height: 64, data: Buffer.from(raster(128, 64, (x, y) => y < 32 ? [220, 30, 30, 255] : [30, 30, 220, 255]).data)} as never);

test('the plane draws Sixel over a fully visible thumbnail once, erases and redraws it when it moves, and leaves a clipped one as half blocks', async () => {
  clearImages(); imageGraphics.clear();
  const dir = await mkdtemp(join(tmpdir(), 'logox-test-')), file = join(dir, 'bands.png');
  imageGraphics.configure({protocol: 'sixel', cell: {width: 8, height: 16}});
  try {
    await writeFile(file, bands());
    const fixture = toolFixture('Read', {file_path: file}, `[Image file: ${file}, size: 400 bytes, format: image/png. Visual content presented to model.]`);
    fixture.rows();
    assert.equal((await imageSettled(file)).status, 'ready');
    const rows = fixture.rows() as readonly SceneRow[];
    const slots = rows.map((row, index) => row.image ? index : -1).filter(index => index >= 0);
    assert.ok(slots.length >= 4, 'the thumbnail rows are marked as slices of one picture');
    const first = slots[0]!, last = slots.at(-1)!;
    assert.deepEqual(rows[first]!.image!.spec.outWidth, rows[first]!.image!.cols * 8);
    assert.equal(rows[first]!.image!.slots, slots.length);

    const out: string[] = [];
    const plane = new TerminalPlane(text => out.push(text));
    plane.afterInkWrite('\x1b[?1049h');
    const frame = (start: number, height: number) => ({rows: rows.slice(start, start + height), start, width: 100, height, selection: null});
    const sixels = () => out.join('').split('\x1bP0;1;0q').length - 1;
    plane.present(frame(0, rows.length)); plane.flush();
    await waitFor(async () => {plane.flush(); return sixels();}, count => count === 1, {timeoutMs: 10000, label: 'the worker encodes the thumbnail'});
    const text = out.join('');
    assert.ok(text.includes(`\x1b[${first + 1};${rows[first]!.gutterCols + 2 + 1}H\x1b[0m\x1bP0;1;0q`), 'drawn at the picture\'s first cell');
    plane.flush(); plane.flush();
    assert.equal(sixels(), 1, 'an unchanged frame sends nothing again (the pixels are cached and still on screen)');

    out.length = 0;
    plane.present(frame(1, rows.length - 1));
    plane.flush();
    const scrolled = out.join('');
    assert.ok(scrolled.includes('\x1bP0;1;0q'), 'after a scroll the picture is drawn at its new rows');
    const repainted = [...scrolled.matchAll(/\x1b\[(\d+);1H\x1b\[0m\x1b\[2K/g)].map(match => Number(match[1]) - 1);
    assert.ok(repainted.includes(first - 1) || repainted.includes(first), 'the rows it covered are repainted first, which blanks the old pixels');

    out.length = 0;
    plane.present(frame(0, last));
    plane.flush();
    assert.ok(!out.join('').includes('\x1bP0;1;0q'), 'a picture cut by the bottom edge is not drawn as pixels (its half blocks show)');
    assert.ok(/[\x1b]\[\d+;1H\x1b\[0m\x1b\[2K/.test(out.join('')), 'and the rows that held pixels are repainted');

    // The lightbox picture: drawn on request, blanked on removal.
    out.length = 0;
    const image = (await imageSettled(file)) as Extract<Awaited<ReturnType<typeof imageSettled>>, {status: 'ready'}>;
    const spec = {image: image.image, crop: {x: 0, y: 0, width: 128, height: 64}, outWidth: 128, outHeight: 64, bg: '#202020'};
    plane.setOverlay({id: 'lightbox', x: 10, y: 4, cols: 16, rows: 4, spec});
    await waitFor(async () => out.join('').includes('\x1bP0;1;0q'), done => done, {timeoutMs: 10000, label: 'the overlay is encoded and drawn'});
    assert.ok(out.join('').includes('\x1b[5;11H\x1bP0;1;0q'), 'at the overlay rectangle');
    out.length = 0;
    plane.setOverlay(null);
    assert.equal([...out.join('').matchAll(/\x1b\[\d+;11H\x1b\[48;2;32;32;32m\x1b\[16X/g)].length, 4, 'every row of the rectangle is blanked in the background colour');
    plane.dispose();
  } finally {
    imageGraphics.configure({protocol: 'halfblock'}); imageGraphics.dispose();
    await rm(dir, {recursive: true, force: true});
  }
});
