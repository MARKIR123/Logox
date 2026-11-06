import {useEffect, useMemo, useRef, useState} from 'react';
import {Box, Text, useInput} from 'ink';
import {PanelFrame, footerParts, hitFooter, panePadding} from '../components/panel-frame.js';
import {palette} from '../appearance/theme.js';
import {layoutInput} from '../input/editor.js';
import {clipLine, safeText} from '../terminal/text.js';
import {useHoverColor, useMouse, usePointer} from '../terminal/mouse.js';
import type {ResultLine, ResultTone} from '../../runtime/command-surface.js';

const toneColor = (tone: ResultTone | undefined): string => tone === 'title' ? palette.accent : tone === 'strong' ? palette.strong : tone === 'pass' ? palette.success
  : tone === 'warn' ? palette.warning : tone === 'fail' ? palette.error : tone === 'muted' ? palette.muted : palette.fg;

/** Read-only command output. Copy retains the original text, not its display wraps. */
export function CommandResultPanel({title, text, styled, width, height, onClose, onCopy}: {
  title: string; text: string; styled?: readonly ResultLine[] | undefined; width: number; height: number;
  onClose(): void; onCopy(text: string): void;
}) {
  const columns = Math.max(1, width - 2 * panePadding(width));
  const contentHeight = Math.max(0, height - (height >= 4 ? 4 : 3));
  const lines = useMemo((): readonly {text: string; tone?: ResultTone | undefined}[] => styled
    ? styled.flatMap(line => layoutInput({text: safeText(line.text).replace(/\t/g, '  '), cursor: 0}, columns).lines.map(wrapped => ({text: wrapped.text, tone: line.tone})))
    : layoutInput({text: safeText(text).replace(/\t/g, '  '), cursor: 0}, columns).lines, [text, styled, columns]);
  const [position, setPosition] = useState(0);
  const max = Math.max(0, lines.length - contentHeight), offset = Math.min(max, position);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => {if (copyTimer.current) clearTimeout(copyTimer.current);}, []);
  const copy = () => {
    onCopy(text);
    setCopied(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1800);
  };
  const pointer = usePointer(), hoverColor = useHoverColor(palette.accent);
  const scroll = (amount: number) => setPosition(previous => Math.max(0, Math.min(max, Math.min(max, previous) + amount)));
  useInput((input, key) => {
    if (key.eventType === 'release') return;
    if (key.escape) {onClose(); return;}
    if (key.ctrl && input === 'c') {copy(); return;}
    if (key.ctrl || key.meta) return;
    if (key.upArrow || key.downArrow) scroll(key.upArrow ? -1 : 1);
    if (key.pageUp || key.pageDown) scroll((key.pageUp ? -1 : 1) * Math.max(1, contentHeight));
    if (key.home || key.end) setPosition(key.home ? 0 : max);
  });
  const help = width < 55 ? 'Ctrl+C Copy all · Esc Back' : '↑↓ / PgUp PgDn / Home End Scroll · Ctrl+C Copy all · Esc Back';
  const footer = copied ? 'Copied result · Ctrl+C Copy all · Esc Back' : help;
  const footerView = footerParts(footer, [{label: 'Ctrl+C Copy all', run: copy}, {label: 'Esc Back', run: onClose}], width, 0, height);
  useMouse(event => {
    if (event.action === 'wheel_up') scroll(-3);
    if (event.action === 'wheel_down') scroll(3);
    if (event.action === 'press' && event.button === 0) hitFooter(footerView, event)?.run?.();
  });
  // PanelFrame has three fixed header/footer rows. Tiny terminals retain the essential copy/back hint instead.
  if (height < 3) return <Box width={width} height={height} overflow="hidden" flexDirection="column">
    {height > 1 && <Text color={palette.accent} wrap="truncate">{clipLine(safeText(title), width)}</Text>}
    {height > 0 && <Text color={palette.muted} wrap="truncate">{clipLine(footer, width)}</Text>}
  </Box>;
  return <PanelFrame title={title} width={width} height={height} footer={footer} parts={footerView} hovered={hitFooter(footerView, pointer)} hoverColor={hoverColor}>
    {lines.slice(offset, offset + contentHeight).map((line, index) => <Box key={offset + index} height={1} flexShrink={0} overflow="hidden">
      <Text color={toneColor('tone' in line ? line.tone : undefined)} bold={'tone' in line && (line.tone === 'title' || line.tone === 'strong')} wrap="truncate">{clipLine(line.text, columns) || ' '}</Text>
    </Box>)}
  </PanelFrame>;
}
