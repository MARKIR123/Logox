import {statSync} from 'node:fs';
import {basename} from 'node:path';
import {useMemo, useRef, useState, useSyncExternalStore, type ReactNode} from 'react';
import {Box, Text, useInput} from 'ink';
import stringWidth from 'string-width';
import {palette} from '../appearance/theme.js';
import {faintColor} from '../appearance/colors.js';
import {openInEditor} from '../../commands/editor.js';
import {formatByteSize} from '../../tools/ui-format.js';
import {safeText} from '../terminal/text.js';
import {useHoverColor, useMouse, usePointer} from '../terminal/mouse.js';
import {parseHex, renderCrop, type ImageRow} from '../terminal/image-raster.js';
import {imageRevision, imageState, retryImage, subscribeImages} from '../terminal/image-source.js';
import {
  CLOSE_GLYPH, FIT_VIEW, borderTitle, buttonAt, cardLayout, elideMiddle, fitTitle, inCard, overClose, overImage, overPath, stepView,
  type CardLayout, type LightboxView, type ViewCommand,
} from './image-lightbox-view.js';

interface Piece {readonly text: string; readonly color?: string; readonly bg?: string; readonly bold?: boolean; readonly underline?: boolean; readonly italic?: boolean}

/**
 * The image lightbox: a centred card over a backdrop showing one image file as large as fits (fitted again whenever the terminal
 * resizes), its facts in the top border, a toolbar (`Fit`, `100%`, `-`, `+`, arrows) and the path of the original, which opens in
 * the system viewer. Esc, a click on the backdrop or the `✕` control close it. The wheel and `+` / `-` zoom, arrows and dragging pan a
 * zoomed picture, `0` fits it again and `1` shows it at 100%.
 */
export function ImageLightbox({path, width, height, onClose}: {path: string; width: number; height: number; onClose(): void}) {
  useSyncExternalStore(subscribeImages, imageRevision);
  const state = imageState(path);
  const image = state.status === 'ready' ? state.image : undefined;
  const [view, setView] = useState<LightboxView>(FIT_VIEW);
  const [opening, setOpening] = useState<'idle' | 'opening' | 'failed'>('idle');
  const bytes = useMemo(() => {try {return statSync(path).size;} catch {return undefined;}}, [path, image]);
  const name = safeText(basename(path));
  const details = (zoomed: boolean) => [image ? image.format.toUpperCase() : '', image ? `${image.width}×${image.height}` : '',
    bytes !== undefined ? formatByteSize(bytes) : '', zoomed && view.zoom ? `${view.zoom * 100}%` : ''].filter(Boolean);
  const pathLabel = 'Open original: ';
  const wanted = stringWidth(fitTitle('Image', details(true), name, 1000));
  const layout = cardLayout({screenCols: width, screenRows: height, ...(image ? {image: {width: image.width, height: image.height}} : {}), view, titleWidth: wanted,
    pathLabelWidth: stringWidth(pathLabel + elideMiddle(path, 1000))});
  const latest = useRef({view, layout, image});
  latest.current = {view, layout, image};
  const drag = useRef<{x: number; y: number; view: LightboxView; layout: CardLayout} | null>(null);
  const pointer = usePointer(), hoverColor = useHoverColor(palette.accent);

  const apply = (command: ViewCommand) => {
    const {view: current, layout: card, image: picture} = latest.current;
    if (picture) setView(stepView(current, command, picture, card.placement));
  };
  const pan = (dx: number, dy: number) => {
    const {layout: card} = latest.current;
    apply({kind: 'pan', dx: dx * Math.max(1, Math.round(card.imageCols / 4)), dy: dy * Math.max(1, Math.round(card.imageRows / 4))});
  };
  const retry = () => {if (state.status === 'failed') retryImage(path);};
  const openOriginal = () => {
    if (opening === 'opening') return;
    setOpening('opening');
    // An empty environment skips $VISUAL / $EDITOR: an image belongs in the system viewer, not a text editor.
    void openInEditor(path, {env: {}}).then(result => setOpening(result.ok ? 'idle' : 'failed'), () => setOpening('failed'));
  };
  const run = (id: string) => {
    if (id === 'fit') apply({kind: 'fit'}); else if (id === 'actual') apply({kind: 'actual'}); else if (id === 'out') apply({kind: 'out'}); else if (id === 'in') apply({kind: 'in'});
    else if (id === 'left') pan(-1, 0); else if (id === 'right') pan(1, 0); else if (id === 'up') pan(0, -1); else if (id === 'down') pan(0, 1);
  };

  useInput((input, key) => {
    if (key.eventType === 'release') return;
    if (key.escape || (!key.ctrl && !key.meta && input === 'q')) {onClose(); return;}
    if (key.ctrl || key.meta) return;
    if (input === 'r') retry();
    else if (input === 'o') openOriginal();
    else if (input === '+' || input === '=') run('in');
    else if (input === '-' || input === '_') run('out');
    else if (input === '0') run('fit');
    else if (input === '1') run('actual');
    else if (key.leftArrow) pan(-1, 0);
    else if (key.rightArrow) pan(1, 0);
    else if (key.upArrow) pan(0, -1);
    else if (key.downArrow) pan(0, 1);
  });

  useMouse(event => {
    const {layout: card, view: current, image: picture} = latest.current;
    if (event.action === 'wheel_up' || event.action === 'wheel_down') {
      if (picture && inCard(card, event.x, event.y)) apply({kind: event.action === 'wheel_up' ? 'in' : 'out'});
      return;
    }
    if (event.action === 'drag') {
      const start = drag.current;
      if (start && picture) setView(stepView(start.view, {kind: 'pan', dx: start.x - event.x, dy: start.y - event.y}, picture, start.layout.placement));
      return;
    }
    if (event.action === 'release') {drag.current = null; return;}
    if (event.action !== 'press' || event.button !== 0) return;
    if (!inCard(card, event.x, event.y)) {onClose(); return;} // the backdrop
    if (overClose(card, event.x, event.y)) {onClose(); return;}
    const button = buttonAt(card, event.x, event.y);
    if (button) {if (!button.disabled) run(button.id); return;}
    if (overPath(card, event.x, event.y)) {openOriginal(); return;}
    if (overImage(card, event.x, event.y)) {
      if (state.status === 'failed') retry(); else drag.current = {x: event.x, y: event.y, view: current, layout: card};
    }
  });

  const surface = palette.surface, edge = palette.line, quiet = faintColor();
  const title = fitTitle('Image', details(true), name, layout.titleColumns);
  const head = borderTitle(title, layout.cardCols);
  const closeHover = pointer !== null && overClose(layout, pointer.x, pointer.y);
  const pixels = useMemo((): readonly ImageRow[] => {
    if (!image || !layout.placement) return [];
    const {placement} = layout, sx = image.raster.width / image.width, sy = image.raster.height / image.height;
    return renderCrop(image.raster, {x: placement.crop.x * sx, y: placement.crop.y * sy, width: placement.crop.width * sx, height: placement.crop.height * sy},
      placement.cols, placement.rows, parseHex(surface));
  }, [image, layout.placement?.crop.x, layout.placement?.crop.y, layout.placement?.crop.width, layout.placement?.crop.height, layout.placement?.cols, layout.placement?.rows, surface]);

  const inner = layout.cardCols - 2;
  const line = (key: string, pieces: readonly Piece[], used: number) => <Box key={key} height={1} flexShrink={0}><Text wrap="truncate">
    <Text>{' '.repeat(layout.left)}</Text>
    <Text color={edge} backgroundColor={surface}>│</Text>
    {pieces.map((piece, at) => <Text key={at} {...(piece.color ? {color: piece.color} : {})} backgroundColor={piece.bg ?? surface} bold={Boolean(piece.bold)} underline={Boolean(piece.underline)} italic={Boolean(piece.italic)}>{piece.text}</Text>)}
    <Text backgroundColor={surface}>{' '.repeat(Math.max(0, inner - used))}</Text>
    <Text color={edge} backgroundColor={surface}>│</Text>
  </Text></Box>;
  const text = (key: string, content: string, piece: Omit<Piece, 'text'> = {}) => line(key, [{text: ' ' + content, ...piece}], 1 + stringWidth(content));
  const centred = (key: string, content: string, piece: Omit<Piece, 'text'>) => {
    const clipped = elideMiddle(content, Math.max(1, inner - 2)), lead = Math.max(0, Math.floor((inner - stringWidth(clipped)) / 2));
    return line(key, [{text: ' '.repeat(lead) + clipped, ...piece}], lead + stringWidth(clipped));
  };

  const rows: ReactNode[] = [];
  for (let index = 0; index < layout.top; index++) rows.push(<Box key={'b' + index} height={1} flexShrink={0}><Text> </Text></Box>);
  rows.push(<Box key="title" height={1} flexShrink={0}><Text wrap="truncate">
    <Text>{' '.repeat(layout.left)}</Text>
    <Text color={edge} backgroundColor={surface}>{head.before}</Text><Text bold color={palette.fg} backgroundColor={surface}>{head.title}</Text><Text color={edge} backgroundColor={surface}>{head.after}</Text>
    <Text color={closeHover ? hoverColor : palette.muted} bold={closeHover} backgroundColor={surface}>{' ' + CLOSE_GLYPH + ' '}</Text>
    <Text color={edge} backgroundColor={surface}>╮</Text>
  </Text></Box>);
  const reasonOpen = opening === 'failed' ? 'Could not open the file' : opening === 'opening' ? 'Opening…' : '';
  const pathText = pathLabel + elideMiddle(path, Math.max(1, layout.pathColumns - stringWidth(pathLabel)));
  const hoverPath = pointer !== null && overPath(layout, pointer.x, pointer.y);
  const pathRow = line('path', [{text: ' '}, reasonOpen ? {text: reasonOpen, color: opening === 'failed' ? palette.error : palette.muted} : {text: pathText, color: hoverPath ? hoverColor : quiet, underline: true}], 1 + stringWidth(reasonOpen || pathText));
  if (!layout.picture) {
    const facts = state.status === 'failed' ? 'Cannot show this image · ' + state.reason : [...details(false)].join(' · ') || 'Loading image…';
    rows.push(text('facts', facts, {color: state.status === 'failed' ? palette.warning : palette.muted}));
  } else {
    rows.push(line('pad', [], 0));
    if (image && layout.placement) {
      const lead = Math.max(0, layout.imageX - layout.left - 2);
      pixels.forEach((runs, index) => rows.push(line('p' + index, [{text: ' '.repeat(1 + lead)}, ...runs.map(run => ({text: run.text, color: run.color, bg: run.bg}))], 1 + lead + layout.imageCols)));
    } else {
      const middle = Math.floor(layout.imageRows / 2);
      for (let index = 0; index < layout.imageRows; index++) {
        if (state.status === 'failed' && index === middle - 1) rows.push(centred('f' + index, '▲ Cannot show this image · ' + state.reason, {color: palette.warning}));
        else if (state.status === 'failed' && index === middle) rows.push(centred('f' + index, 'Click or press R to retry', {color: quiet, italic: true}));
        else if (state.status === 'loading' && index === middle) rows.push(centred('f' + index, '◌ Loading image…', {color: palette.muted, italic: true}));
        else rows.push(line('f' + index, [], 0));
      }
    }
    const toolbar: Piece[] = [{text: ' '}];
    let used = 1;
    for (const button of layout.buttons) {
      const hovered = !button.disabled && pointer !== null && pointer.y === layout.toolbarY && pointer.x >= button.x0 && pointer.x < button.x1;
      toolbar.push({text: ' ' + button.label + ' ', color: button.disabled ? palette.muted : hovered ? hoverColor : button.active ? palette.fg : palette.accent, bold: button.active || hovered, underline: button.active});
      used += stringWidth(button.label) + 2;
    }
    rows.push(line('toolbar', toolbar, used));
  }
  if (layout.picture) rows.push(pathRow);
  rows.push(<Box key="bottom" height={1} flexShrink={0}><Text wrap="truncate">
    <Text>{' '.repeat(layout.left)}</Text><Text color={edge} backgroundColor={surface}>{'╰' + '─'.repeat(inner) + '╯'}</Text></Text></Box>);
  return <Box width={width} height={height} flexShrink={0} overflow="hidden" flexDirection="column">{rows}</Box>;
}
