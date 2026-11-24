// The preview rows of an image in a tool card: a bounded half-block thumbnail (or a loading / failed placeholder in the theme's
// colors) followed by a caption, as one hover and click target that opens the lightbox. The pixels come from the decode cache
// (`terminal/image-source.ts`), so building these rows never decodes, and `imageRevision()` in the layout key refreshes them when
// a decode ends.
import {palette} from '../appearance/theme.js';
import {faintColor} from '../appearance/colors.js';
import {fitThumbnail, parseHex, renderCrop, type ImageRow} from '../terminal/image-raster.js';
import {imageState, memoFor, type DecodedImage} from '../terminal/image-source.js';
import {clipLine} from '../terminal/text.js';
import type {SceneAction, SceneSegment} from './scene.js';
import type {ToolLine} from './tool-card.js';

/** The long edge of a thumbnail, in cells. */
export const THUMB_COLUMNS = 36;
/** Columns kept left of the picture (the hover bar sits in the first). */
const INDENT = 2;
const MIN_WIDTH = 10;
export const imageFoldId = (messageId: string): string => messageId + '-image';
export const isImageFold = (id: string | undefined): boolean => Boolean(id?.endsWith('-image'));

/** The `open_image` action every row of a preview carries; `value` is the file path. */
export const openImageAction = (messageId: string, path: string): SceneAction => ({kind: 'open_image', foldId: imageFoldId(messageId), value: path});
/** The path of the image preview whose fold id is `foldId` among the timeline rows. */
export function imagePathAt(rows: readonly {readonly action?: SceneAction}[], foldId: string | undefined): string | undefined {
  return foldId ? rows.find(row => row.action?.kind === 'open_image' && row.action.foldId === foldId)?.action?.value : undefined;
}

function segmentsOf(rows: readonly ImageRow[], index: number): SceneSegment[] {
  return (rows[index] ?? []).map(run => ({text: run.text, color: run.color, bg: run.bg}));
}
const marker = (hovered: boolean): SceneSegment => ({text: hovered ? '▎ ' : '  ', color: palette.muted});

/** The thumbnail's rows for `image` at `maxLong` cells, composited over `background` (memoized per image, size and background). */
export function thumbnailRows(image: DecodedImage, maxLong: number, background: string): {readonly rows: readonly ImageRow[]; readonly cols: number; readonly cropped: boolean} {
  return memoFor(image, `thumb|${maxLong}|${background}`, () => {
    const fit = fitThumbnail(image.width, image.height, maxLong);
    // The crop is in the file's pixels; the mip is a smaller copy of the same picture.
    const sx = image.mip.width / image.width, sy = image.mip.height / image.height;
    const crop = {x: fit.crop.x * sx, y: fit.crop.y * sy, width: fit.crop.width * sx, height: fit.crop.height * sy};
    return {rows: renderCrop(image.mip, crop, fit.cols, fit.rows, parseHex(background)), cols: fit.cols, cropped: fit.cropped};
  });
}

function box(lines: readonly string[], width: number, color: string): ToolLine[] {
  const inner = Math.max(1, width - 2);
  const edge = (left: string, right: string): ToolLine => ({segments: [marker(false), {text: left + '─'.repeat(inner) + right, color}]});
  return [edge('╭', '╮'), ...lines.map((text): ToolLine => ({segments: [marker(false), {text: '│', color}, {text: clipLine(text, inner).padEnd(inner), color: palette.muted, italic: true}, {text: '│', color}]})), edge('╰', '╯')];
}

/**
 * Preview rows for the image file `path` of tool message `messageId` in a frame `innerWidth` wide: the thumbnail and a caption when
 * decoded, a framed `Loading preview…` while the decode runs, and a clickable `Preview unavailable` with the reason when it failed.
 * Narrow frames get nothing.
 */
export function imageThumbnailLines(path: string, messageId: string, innerWidth: number): ToolLine[] {
  if (innerWidth < MIN_WIDTH + INDENT) return [];
  const state = imageState(path), action = openImageAction(messageId, path), foldId = imageFoldId(messageId), target = {foldId, action};
  const room = innerWidth - INDENT;
  if (state.status === 'loading') return box(['◌ Loading preview…'], Math.min(room, 24), faintColor());
  if (state.status === 'failed') {
    const reason = clipLine(state.reason, Math.max(4, room - 24));
    return [
      {target, paint: ({hovered}) => [marker(hovered), {text: '▲ ', color: palette.warning}, {text: 'Preview unavailable · ' + reason, color: palette.muted}]},
      {target, paint: ({hovered}) => [marker(hovered), {text: 'Click to retry', color: hovered ? palette.fg : faintColor(), italic: true, ...(hovered ? {underline: true} : {})}]},
    ];
  }
  const image = state.image, maxLong = Math.max(4, Math.min(THUMB_COLUMNS, room));
  const rowsAt = (background: string | undefined) => thumbnailRows(image, maxLong, background ?? palette.bg);
  const count = rowsAt(undefined).rows.length;
  const picture: ToolLine[] = Array.from({length: count}, (_, index): ToolLine => ({
    target,
    paint: ({bg, hovered}) => [marker(hovered), ...segmentsOf(rowsAt(bg).rows, index)],
  }));
  const caption: ToolLine = {
    target,
    paint: ({bg, hovered}) => {
      const text = rowsAt(bg).cropped ? 'Click to enlarge · cropped preview' : 'Click to enlarge';
      return [marker(hovered), {text: clipLine(text, Math.max(1, room)), color: hovered ? palette.fg : faintColor(), italic: true, ...(hovered ? {underline: true} : {})}];
    },
  };
  return [...picture, caption];
}
