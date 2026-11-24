import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import stringWidth from 'string-width';
import pngjs from 'pngjs';
import {RuntimeStore} from '../src/runtime/store.js';
import {Steps} from '../src/runtime/steps.js';
import {CommandSurfaces} from '../src/commands/surfaces.js';
import {App} from '../src/tui/app.js';
import {renderTerminal} from '../src/tui/terminal/terminal.js';
import {buildStageRows} from '../src/tui/timeline/stage.js';
import {actionAt} from '../src/tui/timeline/scene.js';
import {clearImages, imageSettled} from '../src/tui/terminal/image-source.js';
import {FIT_VIEW, borderTitle, buttonAt, cardLayout, elideMiddle, fitTitle, inCard, overClose, overImage, stepView} from '../src/tui/panels/image-lightbox-view.js';
import {TerminalScreen} from './terminal-screen.js';
import {toolFixture, rowText} from './tool-fixture.js';
import {waitFor} from './wait-for.js';

class Input extends PassThrough {isTTY = true; setRawMode(): this {return this;} ref(): this {return this;} unref(): this {return this;}}

/** A 64 by 32 picture: a red upper half over a blue lower half, so every thumbnail cell is a known colour. */
function twoBands(): Buffer {
  const width = 64, height = 32, data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(y < 16 ? [220, 30, 30, 255] : [30, 30, 220, 255], (y * width + x) * 4);
  return pngjs.PNG.sync.write({width, height, data} as never);
}
async function withImage<T>(run: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'logox-test-')), file = join(dir, 'bands.png');
  try {await writeFile(file, twoBands()); return await run(file);} finally {await rm(dir, {recursive: true, force: true});}
}
const readResult = (file: string) => `[Image file: ${file}, size: 400 bytes, format: image/png. Visual content presented to model.]`;

test('Read image row: expanded, it shows a half-block thumbnail that is one hover and click target (and a loading box before the decode ends)', async () => {
  clearImages();
  await withImage(async file => {
    const fixture = toolFixture('Read', {file_path: file}, readResult(file));
    const loading = fixture.rows().map(rowText).join('\n');
    assert.match(loading, /Loading preview…/, 'the decode runs off the render path: the first layout draws a placeholder');
    assert.ok(!/▀/.test(loading));
    assert.equal((await imageSettled(file)).status, 'ready');
    const rows = fixture.rows();
    const picture = rows.filter(row => row.action?.kind === 'open_image');
    assert.ok(picture.length >= 3, 'thumbnail rows plus the caption are clickable rows');
    assert.ok(picture.every(row => row.action?.value === file && row.action.foldId === fixture.id + '-image'));
    assert.ok(picture.every(row => row.hover?.foldId === fixture.id + '-image' && row.hits?.[0]?.action.kind === 'open_image'), 'one hover target for the whole preview, ahead of the card region');
    assert.match(picture.map(rowText).join('\n'), /▀/);
    assert.match(rowText(picture.at(-1)!), /Click to enlarge/);
    const first = picture[0]!, colors = first.segments!.filter(segment => segment.text.includes('▀'));
    assert.equal(colors[0]!.color, '#dc1e1e', 'the upper half of the picture is red'); assert.equal(colors[0]!.bg, '#dc1e1e');
    assert.equal(picture.at(-2)!.segments!.find(segment => segment.text.includes('▀'))!.bg, '#1e1edc', 'the lower half is blue');
    assert.ok(picture.length - 1 <= 18 && picture.every(row => (row.text.length) <= 40), 'long edge about 36 columns');
    const idle = first.text.startsWith('  '), hovered = fixture.rows({}, fixture.id + '-image').filter(row => row.action?.kind === 'open_image');
    assert.ok(idle && hovered[0]!.text.startsWith('▎ '), 'hover draws a bar beside the picture');
    assert.equal(actionAt(first, first.gutterCols + 4)?.kind, 'open_image');
    // The Path/Format/Dimensions details are still there below the preview.
    assert.match(rows.map(rowText).join('\n'), /Dimensions\s+64 × 32 pixels/);
    const closed = fixture.rows({[fixture.id]: false}).map(rowText).join('\n');
    assert.ok(!/▀|Loading preview/.test(closed), 'folded rows show no preview');
  });
});

test('Read image row: a file that cannot be decoded shows why and a retry target', async () => {
  clearImages();
  const dir = await mkdtemp(join(tmpdir(), 'logox-test-')), file = join(dir, 'x.png');
  try {
    await writeFile(file, Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(40)]));
    const fixture = toolFixture('Read', {file_path: file}, readResult(file));
    await imageSettled(file);
    const rows = fixture.rows(), text = rows.map(rowText).join('\n');
    assert.match(text, /Preview unavailable · cannot decode PNG/); assert.match(text, /Click to retry/);
    assert.equal(rows.filter(row => row.action?.kind === 'open_image').length, 2);
  } finally {await rm(dir, {recursive: true, force: true});}
});

test('lightbox geometry: a centred card, the close control in the title border, buttons, fit and zoom transitions', () => {
  const image = {width: 400, height: 200};
  const fit = cardLayout({screenCols: 100, screenRows: 40, image, view: FIT_VIEW, titleWidth: 50, pathLabelWidth: 30});
  assert.ok(fit.picture && fit.placement);
  assert.equal(fit.imageCols, 91, 'the picture takes at most 95% of the width minus the chrome');
  assert.ok(fit.cardCols <= 100 && fit.left === Math.floor((100 - fit.cardCols) / 2) && fit.top === Math.floor((40 - fit.cardRows) / 2), 'centred');
  assert.ok(overClose(fit, fit.close.x0, fit.close.y) && !overClose(fit, fit.close.x1, fit.close.y));
  assert.equal(fit.close.y, fit.top); assert.equal(fit.close.x1, fit.left + fit.cardCols - 1, 'it sits just left of the corner');
  assert.deepEqual(fit.buttons.map(button => button.label), ['Fit', '100%', '-', '+', '←', '↑', '↓', '→']);
  assert.ok(fit.buttons[0]!.disabled && fit.buttons[0]!.active, 'already fit'); assert.ok(fit.buttons[4]!.disabled, 'arrows need a zoomed picture');
  assert.equal(buttonAt(fit, fit.buttons[3]!.x0, fit.toolbarY)?.id, 'in');
  assert.ok(overImage(fit, fit.imageX, fit.imageY) && !overImage(fit, fit.imageX - 1, fit.imageY));
  assert.ok(inCard(fit, fit.left, fit.top) && !inCard(fit, fit.left - 1, fit.top), 'everything outside the card is the backdrop');
  assert.ok(fit.pathY === fit.toolbarY + 1 && fit.cardRows === fit.imageRows + 5);

  const actual = stepView(FIT_VIEW, {kind: 'in'}, image, fit.placement);
  assert.equal(actual.zoom, 1, '+ from fit goes to 100%');
  const zoomed = cardLayout({screenCols: 100, screenRows: 40, image, view: actual, titleWidth: 50, pathLabelWidth: 30});
  assert.ok(zoomed.placement!.pannable === false || zoomed.placement!.scale === 1);
  const eight = stepView(stepView(stepView(actual, {kind: 'in'}, image, zoomed.placement), {kind: 'in'}, image, zoomed.placement), {kind: 'in'}, image, zoomed.placement);
  assert.equal(eight.zoom, 8, 'levels 1, 2, 4, 8 and no further');
  assert.equal(stepView(eight, {kind: 'in'}, image, zoomed.placement).zoom, 8);
  assert.equal(stepView(eight, {kind: 'out'}, image, zoomed.placement).zoom, 4);
  assert.deepEqual(stepView(actual, {kind: 'out'}, image, zoomed.placement), FIT_VIEW, '- from 100% returns to fit');
  const big = cardLayout({screenCols: 100, screenRows: 40, image: {width: 4000, height: 3000}, view: {zoom: 2, cx: 0.5, cy: 0.5}, titleWidth: 10, pathLabelWidth: 10});
  assert.ok(big.placement!.pannable && big.buttons.slice(4).every(button => !button.disabled));
  const panned = stepView({zoom: 2, cx: 0.5, cy: 0.5}, {kind: 'pan', dx: 10, dy: 0}, {width: 4000, height: 3000}, big.placement);
  assert.ok(panned.cx > 0.5 && panned.cy === 0.5, 'panning right moves the window right');
  assert.equal(stepView(FIT_VIEW, {kind: 'pan', dx: 10, dy: 0}, image, fit.placement), FIT_VIEW, 'a picture that fits cannot be panned');
  const narrower = cardLayout({screenCols: 70, screenRows: 30, image, view: FIT_VIEW, titleWidth: 50, pathLabelWidth: 30});
  assert.ok(narrower.imageCols < fit.imageCols, 're-fits when the terminal shrinks');
  const tiny = cardLayout({screenCols: 30, screenRows: 8, image, view: FIT_VIEW, titleWidth: 50, pathLabelWidth: 30});
  assert.ok(!tiny.picture && tiny.cardRows === 3 && tiny.buttons.length === 0, 'too small for a picture: metadata only');
  assert.equal(fitTitle('Image', ['PNG', '64×32', '400 B'], 'bands.png', 60), 'Image — PNG · 64×32 · 400 B · bands.png');
  const squeezed = fitTitle('Image', ['PNG', '64×32'], 'a-very-long-name-for-an-image-file.png', 30);
  assert.ok(stringWidth(squeezed) <= 30 && squeezed.startsWith('Image — PNG · 64×32 · ') && squeezed.includes('…'), 'the name is shortened in its middle first: ' + squeezed);
  const dropped = fitTitle('Image', ['PNG', '64×32'], 'abc.png', 17);
  assert.ok(stringWidth(dropped) <= 17 && dropped.startsWith('Image — PNG'), 'the name is dropped before the facts are cut: ' + dropped);
  const middle = elideMiddle('C:/very/long/path/to/file.png', 12);
  assert.ok(stringWidth(middle) === 12 && middle.startsWith('C:/') && middle.endsWith('ile.png') === false && middle.endsWith('.png') && middle.includes('…'), middle);
  const head = borderTitle('Image — PNG', 40);
  assert.equal((head.before + head.title + head.after).length + 3 + 1, 40, 'border row plus ` ✕ ` and the corner is exactly the card width');
});

class Screen {
  constructor(readonly output: TerminalScreen) {}
  get text(): string {return this.output.lines.join('\n');}
  find(pattern: RegExp): {x: number; y: number} | undefined {
    for (const [y, line] of this.output.lines.entries()) {const match = pattern.exec(line); if (match) return {x: match.index, y};}
    return undefined;
  }
}

test('App: clicking an expanded image thumbnail opens the lightbox; Esc, the backdrop and the close control each return to the timeline', async () => {
  clearImages();
  await withImage(async file => {
    const store = new RuntimeStore(), surfaces = new CommandSurfaces(() => {});
    store.activities.create({sessionId: 's', activityId: 'main', ownerId: 'logox', kind: 'director', title: 'Main', status: 'running', stage: 'x', detail: ''});
    store.message('s', 'user', 'user', 'Look at it.', {activityId: 'main', inputKind: 'human'});
    const steps = new Steps(store, {sessionId: 's', activityId: 'main', ownerId: 'logox'});
    const id = steps.tool({id: 'c1', name: 'Read', arguments: JSON.stringify({file_path: file})});
    steps.start(id); steps.finish(id, 'completed', 'Read\n' + readResult(file));
    const input = new Input(), output = new TerminalScreen(), screen = new Screen(output);
    output.columns = 100; output.rows = 40;
    const instance = renderTerminal(<App stage sessionId="s" store={store} surfaces={surfaces} onSubmit={async () => {}} onCancel={() => {}} onClose={async () => {}}/>,
      {stdout: output, stdin: input, stderr: output, interactive: true, alternateScreen: true, incrementalRendering: true, patchConsole: false, exitOnCtrlC: false});
    const settle = async (ms = 80) => {await delay(ms); await instance.waitUntilRenderFlush();};
    const key = async (text: string) => {input.write(text); await settle();};
    const click = async (x: number, y: number) => {await key(`\x1b[<0;${x + 1};${y + 1}M`); await key(`\x1b[<0;${x + 1};${y + 1}m`);};
    const move = async (x: number, y: number) => key(`\x1b[<35;${x + 1};${y + 1}M`);
    try {
      await settle(200);
      const header = await waitFor(async () => {await settle(); return screen.find(/Read\b.*bands\.png|bands\.png/);}, found => Boolean(found), {timeoutMs: 8000, label: 'the Read row'});
      await click(header!.x + 4, header!.y);
      const thumb = await waitFor(async () => {await settle(); return screen.find(/▀/);}, found => Boolean(found), {timeoutMs: 8000, label: 'the thumbnail'});
      assert.match(screen.text, /Click to enlarge/);
      await move(thumb!.x + 4, thumb!.y);
      await waitFor(async () => {await settle(); return screen.text;}, text => /▎/.test(text), {timeoutMs: 8000, label: 'the hover bar'});
      const open = async () => {
        const where = screen.find(/▀/)!;
        await click(where.x + 4, where.y);
        await waitFor(async () => {await settle(); return surfaces.getSnapshot()?.kind;}, kind => kind === 'image', {timeoutMs: 8000, label: 'the lightbox surface'});
        await waitFor(async () => {await settle(); return screen.text;}, text => /✕/.test(text) && /Open original/.test(text), {timeoutMs: 8000, label: 'the lightbox card'});
      };
      await open();
      const card = screen.text;
      assert.match(card, /Image — PNG · 64×32 · /); assert.match(card, /bands\.png/); assert.match(card, /Fit.*100%/);
      assert.ok(!/Click to enlarge/.test(card), 'the timeline is hidden behind the overlay');
      assert.equal((surfaces.getSnapshot() as {path: string}).path, file);

      await key('\x1b');
      assert.equal(surfaces.getSnapshot(), null, 'Esc closes'); await waitFor(async () => {await settle(); return screen.text;}, text => /Click to enlarge/.test(text), {timeoutMs: 8000, label: 'the timeline returns'});

      await open();
      await click(0, 0);
      assert.equal(surfaces.getSnapshot(), null, 'a click on the backdrop closes'); await waitFor(async () => {await settle(); return screen.text;}, text => /Click to enlarge/.test(text), {timeoutMs: 8000, label: 'the timeline returns'});

      await open();
      const inside = screen.find(/▀/)!;
      await click(inside.x + 2, inside.y);
      assert.equal(surfaces.getSnapshot()?.kind, 'image', 'a click on the picture does not close');
      const close = screen.find(/✕/)!;
      await move(close.x, close.y);
      await click(close.x, close.y);
      assert.equal(surfaces.getSnapshot(), null, 'the close control closes'); await waitFor(async () => {await settle(); return screen.text;}, text => /Click to enlarge/.test(text), {timeoutMs: 8000, label: 'the timeline returns'});

      await open();
      const before = screen.text.match(/·\s*\d+%/);
      await key('1');
      await waitFor(async () => {await settle(); return screen.text;}, text => /100%/.test(text.split('\n')[screen.find(/✕/)!.y]!), {timeoutMs: 8000, label: '100% in the title'});
      assert.equal(before, null, 'fit shows no percentage in the title');
      await key('0');
      await waitFor(async () => {await settle(); return screen.text;}, text => !/100%/.test(text.split('\n')[screen.find(/✕/)!.y]!), {timeoutMs: 8000, label: 'fit again'});
      await key('q'); assert.equal(surfaces.getSnapshot(), null);
    } finally {instance.unmount(); await instance.waitUntilExit(); input.destroy(); output.destroy();}
  });
});
