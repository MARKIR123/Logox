import React, {useRef, useState, type ReactElement} from 'react';
import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {Box, Text, useInput} from 'ink';
import type {EnsembleData} from '../../runtime/ensemble-view.js';
import {palette} from '../appearance/theme.js';
import {footerParts, hitFooter, panePadding, panelRows, type FooterAction} from '../components/panel-frame.js';
import {inRegion, usePointer, useMouse} from '../terminal/mouse.js';
import {clipLine} from '../terminal/text.js';
import {ensembleLayout, initialState, stepEnsemble, type EnsembleCommand, type EnsembleEffect, type EnsembleState, type Seg} from './ensemble-layout.js';

function Line({segs}: {segs: readonly Seg[]}) {
  return <Box height={1} flexShrink={0} overflow="hidden"><Text wrap="truncate">{segs.map((seg, index) =>
    <Text key={index} color={seg.color} bold={seg.bold === true} italic={seg.italic === true} {...(seg.bg ? {backgroundColor: seg.bg} : {})}>{seg.text}</Text>)}</Text></Box>;
}
const readTextFile = (path: string): string | undefined => {try {return readFileSync(path, 'utf8');} catch {return undefined;}};
const WHEEL_LINES = 3;

/**
 * /ensemble: one tab per actor; each tab is a single scrolling page (profile, parameters, session figures, prompts) with Tools and Skills sub-pages.
 * Keyboard, mouse and the footer buttons all run the same commands (`stepEnsemble`); editing is delegated to the host (`onEdit`), never done here.
 */
export function EnsemblePage({data, width, height, y = 0, notice = '', home = homedir(), readText = readTextFile, onClose, onModel, onEdit, onNotice}: {
  data: EnsembleData; width: number; height: number; /** Screen row of the page's top rule. */ y?: number; notice?: string; home?: string;
  readText?: (path: string) => string | undefined;
  onClose(): void; onModel(actorId: string): void; onEdit(path: string): void; onNotice?(text: string): void;
}): ReactElement {
  const start = Math.max(0, data.actors.findIndex(actor => actor.id === data.initial));
  const view = useRef<EnsembleState>(initialState(start));
  const [, rerender] = useState(0);
  const pointer = usePointer();
  const plan = ensembleLayout({data, state: view.current, width, height, y, pointer, home, readText, notice});
  view.current = plan.state;
  const latest = useRef(plan); latest.current = plan;

  const apply = (effect: EnsembleEffect | undefined) => {
    if (!effect) return;
    if (effect.kind === 'close') onClose();
    else if (effect.kind === 'model') onModel(effect.actorId);
    else if (effect.kind === 'edit') onEdit(effect.path);
    else onNotice?.(effect.text);
  };
  const run = (command: EnsembleCommand) => {
    const result = stepEnsemble(view.current, command, latest.current, data);
    view.current = result.state;
    rerender(count => count + 1);
    apply(result.effect);
  };

  useInput((input, key) => {
    if (key.eventType === 'release') return;
    if (key.escape) {run({kind: 'back'}); return;}
    if (key.ctrl || key.meta) return;
    if (key.leftArrow || (key.tab && key.shift)) {run({kind: 'tabStep', delta: -1}); return;}
    if (key.rightArrow || key.tab) {run({kind: 'tabStep', delta: 1}); return;}
    if (key.upArrow) {run({kind: 'move', delta: -1}); return;}
    if (key.downArrow) {run({kind: 'move', delta: 1}); return;}
    if (key.pageUp || key.pageDown) {run({kind: 'page', delta: key.pageUp ? -1 : 1}); return;}
    if (key.home || key.end) {run({kind: 'edge', end: Boolean(key.end)}); return;}
    if (key.return) {run({kind: 'open', index: -1}); return;}
    if (input === 'm') {run({kind: 'model'}); return;}
    if (input === 'e') run({kind: 'edit'});
  });

  const actions: readonly FooterAction[] = plan.footer.actions.map(item => ({label: item.label, run: () => run(item.command)}));
  const footerView = footerParts(plan.footer.text, actions, width, y, height);
  const hoveredFooter = hitFooter(footerView, pointer);
  useMouse(event => {
    if (event.x < 0 || event.x >= width || event.y < y || event.y >= y + height) return;
    const wheel = event.action === 'wheel_up' ? -1 : event.action === 'wheel_down' ? 1 : 0;
    if (wheel) {
      const route = latest.current.state.route.kind;
      run({kind: 'scroll', delta: wheel * (route === 'tools' || route === 'skills' ? 1 : WHEEL_LINES)});
      return;
    }
    if (event.action !== 'press' || event.button !== 0) return;
    const clickedFooter = hitFooter(footerView, event);
    if (clickedFooter?.run) {clickedFooter.run(); return;}
    const hit = latest.current.hits.find(candidate => inRegion(event, candidate.region));
    if (!hit) return;
    // A click on a main-page row selects it before it opens, so the cursor follows what was used.
    if (hit.command.kind === 'open' && hit.command.index >= 0) {
      const route = latest.current.state.route.kind;
      view.current = {...view.current, selected: hit.command.index};
      if (route === 'main' || route === 'tools' || route === 'skills') {run(hit.command); return;}
    }
    run(hit.command);
  });

  const padding = panePadding(width), columns = Math.max(1, width - 2 * padding), frame = panelRows(height);
  const rule = <Box height={1} flexShrink={0}><Text color={plan.color} wrap="truncate">{'─'.repeat(width)}</Text></Box>;
  return <Box width={width} height={height} flexShrink={0} overflow="hidden" flexDirection="column">
    {rule}
    <Box height={1} flexShrink={0}><Text wrap="truncate">{plan.tabs.map((seg, index) =>
      <Text key={index} color={seg.color} bold={seg.bold === true}>{seg.text}</Text>)}</Text></Box>
    <Box height={frame.bodyHeight} flexShrink={0} overflow="hidden" flexDirection="column">
      {plan.rows.map((segs, index) => <Line key={index} segs={segs}/>)}
    </Box>
    <Box height={1} flexShrink={0} paddingX={padding}><Text color={palette.muted} wrap="truncate">{footerView.length
      ? footerView.map((part, index) => <Text key={index} {...(part === hoveredFooter ? {color: plan.color, bold: true} : {})}>{part.text}</Text>)
      : clipLine(plan.footer.text, columns)}</Text></Box>
    {height >= 4 && rule}
  </Box>;
}
