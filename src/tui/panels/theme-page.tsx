import React, {useRef, useState, type ReactElement} from 'react';
import {Box, Text, useInput} from 'ink';
import type {ThemeRow} from '../../runtime/command-surface.js';
import {palette} from '../appearance/theme.js';
import {PanelFrame, footerParts, hitFooter, panelRows, type FooterAction} from '../components/panel-frame.js';
import {inRegion, useMouse, usePointer} from '../terminal/mouse.js';
import {normalizeSelection, stepSelectable, themeLayout, type Area, type ThemeCommand, type ThemeView} from './theme-layout.js';
import type {SampleRow} from './theme-sample.js';

const SAMPLE_WHEEL_ROWS = 3;
const inArea = (area: Area | undefined, x: number, y: number): boolean => area !== undefined && x >= area.x0 && x < area.x1 && y >= area.y0 && y < area.y1;

function Line({row}: {row: SampleRow}) {
  return <Box height={1} flexShrink={0} overflow="hidden"><Text wrap="truncate">{row.map((seg, index) =>
    <Text key={index} color={seg.color} bold={seg.bold === true} italic={seg.italic === true} underline={seg.underline === true} {...(seg.bg ? {backgroundColor: seg.bg} : {})}>{seg.text}</Text>)}</Text></Box>;
}

/** The nearest row that can be chosen at or around `index` (unavailable rows are skipped, searching outward). -1 when nothing can be chosen. */
function nearestUsable(themes: readonly ThemeRow[], index: number): number {
  const target = Math.max(0, Math.min(themes.length - 1, index));
  for (let distance = 0; distance < themes.length; distance++) {
    for (const candidate of [target - distance, target + distance]) if (themes[candidate] && !themes[candidate]!.unavailable) return candidate;
  }
  return -1;
}

/**
 * /theme: the themes on the left and a live sample on the right. The highlighted theme is applied to the whole application as a preview
 * (`onPreview`; nothing is written), Enter or a click chooses it (`onChoose`), and Esc leaves (`onCancel`). Putting the original theme back
 * is the host's job on every way out of the page, so it never depends on a key handler here.
 */
export function ThemePage({themes, current, width, height, y = 0, saving = false, error = '', notice = '', onPreview, onChoose, onCancel}: {
  themes: readonly ThemeRow[]; /** The saved theme (marked in the list). */ current: string;
  width: number; height: number; /** Screen row of the page's top rule. */ y?: number;
  saving?: boolean; error?: string; notice?: string;
  onPreview(name: string): void;
  onChoose(name: string): void;
  onCancel(): void;
}): ReactElement {
  const view = useRef<ThemeView>({selected: normalizeSelection(themes, -1, current), scroll: 0, sampleScroll: 0});
  const [, rerender] = useState(0);
  const pointer = usePointer();
  const plan = themeLayout({themes, current, view: view.current, width, height, y, saving, error: error || notice});
  view.current = {selected: plan.selected, scroll: plan.scroll, sampleScroll: plan.sampleScroll};
  const latest = useRef(plan); latest.current = plan;

  const update = (patch: Partial<ThemeView>) => {view.current = {...view.current, ...patch}; rerender(count => count + 1);};
  /** Highlights a row and previews it; the palette changes before the page redraws. */
  const highlight = (index: number) => {
    const theme = themes[index];
    if (!theme || theme.unavailable) return;
    if (index !== view.current.selected) onPreview(theme.name);
    update({selected: index});
  };
  const run = (command: ThemeCommand): void => {
    if (saving) return;
    const at = view.current.selected;
    switch (command.kind) {
      case 'move': highlight(stepSelectable(themes, at, command.delta)); return;
      case 'page': highlight(nearestUsable(themes, at + command.delta * Math.max(1, latest.current.listRows - 1))); return;
      case 'edge': highlight(nearestUsable(themes, command.to === 'first' ? 0 : themes.length - 1)); return;
      case 'select': highlight(command.index < 0 ? at : command.index); return;
      case 'choose': {
        const theme = themes[command.index < 0 ? at : command.index];
        if (theme && !theme.unavailable) {highlight(command.index < 0 ? at : command.index); onChoose(theme.name);}
        return;
      }
      case 'cancel': onCancel(); return;
    }
  };

  useInput((input, key) => {
    if (key.eventType === 'release' || saving) return;
    if (key.escape) {run({kind: 'cancel'}); return;}
    if (key.ctrl || key.meta) return;
    if (key.upArrow || (key.tab && key.shift)) {run({kind: 'move', delta: -1}); return;}
    if (key.downArrow || key.tab) {run({kind: 'move', delta: 1}); return;}
    if (key.pageUp || key.pageDown) {run({kind: 'page', delta: key.pageUp ? -1 : 1}); return;}
    if (key.home || key.end) {run({kind: 'edge', to: key.home ? 'first' : 'last'}); return;}
    if (key.return || input === ' ') run({kind: 'choose', index: -1});
  });

  const actions: readonly FooterAction[] = error || notice || saving ? [] : plan.footer.actions.map(part => ({label: part.label, run: () => run(part.command)}));
  const footerView = footerParts(plan.footer.text, actions, width, y, height);
  const hoveredFooter = hitFooter(footerView, pointer);
  useMouse(event => {
    if (saving || event.x < 0 || event.x >= width || event.y < y || event.y >= y + height) return;
    const wheel = event.action === 'wheel_up' ? -1 : event.action === 'wheel_down' ? 1 : 0;
    if (wheel) {
      if (inArea(latest.current.sampleArea, event.x, event.y)) update({sampleScroll: Math.max(0, view.current.sampleScroll + wheel * SAMPLE_WHEEL_ROWS)});
      else run({kind: 'move', delta: wheel});
      return;
    }
    const hit = latest.current.hits.find(candidate => inRegion(event, candidate.region));
    // Moving the pointer over a row highlights it, so the whole application previews it before anything is chosen.
    if (event.action === 'move') {if (hit?.command.kind === 'choose') run({kind: 'select', index: hit.command.index}); return;}
    if (event.action !== 'press' || event.button !== 0) return;
    const clickedFooter = hitFooter(footerView, event);
    if (clickedFooter?.run) {clickedFooter.run(); return;}
    if (hit) run(hit.command);
  });

  const frame = panelRows(height);
  return <PanelFrame title="Theme" width={width} height={height} footer={plan.footer.text} parts={footerView} hovered={hoveredFooter} hoverColor={palette.accent} bleed
    header={<Text wrap="truncate">{plan.header.map((seg, index) => <Text key={index} color={seg.color} bold={seg.bold === true}>{seg.text}</Text>)}</Text>}>
    <Box flexDirection="column" height={frame.bodyHeight} flexShrink={0} overflow="hidden">
      {plan.rows.map((row, index) => <Line key={index} row={row}/>)}
    </Box>
  </PanelFrame>;
}
