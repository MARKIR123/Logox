import React, {useRef, useState, type ReactElement} from 'react';
import {Box, Text, useInput} from 'ink';
import {mainAction, type NoticeAction, type PersistentNotice} from '../../runtime/notices.js';
import {palette} from '../appearance/theme.js';
import {PanelFrame, footerParts, hitFooter, panelRows, type FooterAction} from '../components/panel-frame.js';
import {inRegion, useHoverColor, useMouse, usePointer} from '../terminal/mouse.js';
import {noticesLayout, type NoticesCommand, type NoticesView} from './notices-layout.js';

/**
 * The Notices page (`/notices`, the footer's `+N` badge): every persistent notice, pending first. The list is the host's live one, so a pending
 * notice vanishes from here the moment its request is answered. Keyboard, mouse and the footer labels all run the same commands.
 */
export function NoticesPage({notices, width, height, y = 0, onAction, onDismiss, onDismissAll, onClose}: {
  notices: readonly PersistentNotice[]; width: number; height: number; /** Screen row of the page's top rule. */ y?: number;
  /** Runs an action; the host closes the page first. */
  onAction(action: NoticeAction): void;
  onDismiss(id: string): void;
  onDismissAll(): void;
  onClose(): void;
}): ReactElement {
  const view = useRef<NoticesView>({selected: 0, scroll: 0});
  const [, rerender] = useState(0);
  const pointer = usePointer(), hoverColor = useHoverColor(palette.accent);
  const plan = noticesLayout({notices, view: view.current, width, height, y, pointer, hoverColor});
  view.current = {selected: plan.selected, scroll: plan.scroll};
  const latest = useRef({plan, notices}); latest.current = {plan, notices};
  const update = (patch: Partial<NoticesView>) => {view.current = {...view.current, ...patch}; rerender(count => count + 1);};

  const run = (command: NoticesCommand): void => {
    const {notices: list} = latest.current, count = list.length;
    const at = (index: number) => list[index < 0 ? view.current.selected : index];
    switch (command.kind) {
      case 'move': if (count && command.delta) update({selected: (view.current.selected + command.delta + count) % count}); return;
      case 'select': update({selected: Math.max(0, Math.min(count - 1, command.index))}); return;
      case 'open': {
        const notice = at(command.index);
        const action = notice ? (command.part !== undefined ? notice.parts[command.part]?.action : mainAction(notice)) : undefined;
        if (action) onAction(action);
        return;
      }
      case 'dismiss': {const notice = at(command.index); if (notice?.kind === 'read') onDismiss(notice.id); return;}
      case 'dismissAll': onDismissAll(); return;
      case 'close': onClose(); return;
    }
  };

  useInput((input, key) => {
    if (key.eventType === 'release') return;
    const count = latest.current.notices.length;
    if (key.escape) {run({kind: 'close'}); return;}
    if (key.upArrow || (key.tab && key.shift)) {run({kind: 'move', delta: -1}); return;}
    if (key.downArrow || key.tab) {run({kind: 'move', delta: 1}); return;}
    if (key.pageUp || key.pageDown) {update({selected: Math.max(0, Math.min(count - 1, view.current.selected + (key.pageUp ? -1 : 1) * latest.current.plan.listRows))}); return;}
    if (key.home || key.end) {update({selected: key.home ? 0 : Math.max(0, count - 1)}); return;}
    if (key.return) {run({kind: 'open', index: -1}); return;}
    if (key.ctrl || key.meta) return;
    if (input === 'D') {run({kind: 'dismissAll'}); return;}
    if (input === 'd') run({kind: 'dismiss', index: -1});
  });

  const actions: readonly FooterAction[] = plan.footer.actions.map(part => ({label: part.label, run: () => run(part.command)}));
  const footerView = footerParts(plan.footer.text, actions, width, y, height);
  const hoveredFooter = hitFooter(footerView, pointer);
  useMouse(event => {
    if (event.x < 0 || event.x >= width || event.y < y || event.y >= y + height) return;
    const wheel = event.action === 'wheel_up' ? -1 : event.action === 'wheel_down' ? 1 : 0;
    if (wheel) {run({kind: 'move', delta: wheel}); return;}
    if (event.action !== 'press' || event.button !== 0) return;
    const clickedFooter = hitFooter(footerView, event);
    if (clickedFooter?.run) {clickedFooter.run(); return;}
    const hit = latest.current.plan.hits.find(candidate => inRegion(event, candidate.region));
    if (hit) run(hit.command);
  });

  const frame = panelRows(height);
  const unread = notices.filter(notice => notice.kind === 'pending').length;
  return <PanelFrame title="Notices" width={width} height={height} footer={plan.footer.text} parts={footerView} hovered={hoveredFooter} hoverColor={hoverColor} bleed
    header={<Text wrap="truncate"><Text bold color={palette.fg}>Notices</Text>{notices.length ? <Text color={palette.muted}>{' · ' + notices.length + (unread ? ' · ' + unread + ' need you' : '')}</Text> : null}</Text>}>
    <Box flexDirection="column" height={frame.bodyHeight} flexShrink={0} overflow="hidden">
      {plan.rows.map((segs, index) => <Box key={index} height={1} flexShrink={0} overflow="hidden"><Text wrap="truncate">{segs.map((seg, at) =>
        <Text key={at} color={seg.color} bold={seg.bold === true} italic={seg.italic === true} underline={seg.underline === true} {...(seg.bg ? {backgroundColor: seg.bg} : {})}>{seg.text}</Text>)}</Text></Box>)}
    </Box>
  </PanelFrame>;
}
