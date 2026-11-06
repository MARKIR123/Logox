import React, {useRef, useState, type ReactElement} from 'react';
import {Box, Text, useInput} from 'ink';
import type {CommandToggle, SettingsItem, SettingsPageLink, SettingsSubPage} from '../../runtime/command-surface.js';
import type {StatusbarAppearance} from '../../config/statusbar-preferences.js';
import {palette} from '../appearance/theme.js';
import {PanelFrame, footerParts, hitFooter, panelRows, type FooterAction} from '../components/panel-frame.js';
import {inRegion, useHoverColor, useMouse, usePointer} from '../terminal/mouse.js';
import {changedDrafts, settingsLayout, stepValue, type DraftValue, type Seg, type SettingsCommand, type SettingsView} from './settings-layout.js';
import {TabbedPage} from './tabbed-page.js';

const TEXT_LIMIT = 64;
const initialView: SettingsView = {drafts: {}, query: '', searching: false, selected: 0, scroll: 0, editing: undefined, confirming: false, saving: false, error: '', notice: ''};

function Line({segs}: {segs: readonly Seg[]}) {
  return <Box height={1} flexShrink={0} overflow="hidden"><Text wrap="truncate">{segs.map((seg, index) =>
    <Text key={index} color={seg.color} bold={seg.bold === true} italic={seg.italic === true} {...(seg.bg ? {backgroundColor: seg.bg} : {})}>{seg.text}</Text>)}</Text></Box>;
}

/**
 * /settings: data-driven rows grouped on one page, values on the right, a description for the selected row, a search box and sub-pages.
 * Drafts stay in the page until Enter; the host receives only the changed values. Keyboard, mouse and the footer buttons all run the same commands.
 */
export function SettingsPage({items, pages, width, height, y = 0, saving = false, error = '', notice = '', sub, onSave, onPreview, onDiscard, onOpenPage, onCloseSub, onSubSave, onSubAction}: {
  items: readonly SettingsItem[]; pages: readonly SettingsPageLink[]; width: number; height: number; /** Screen row of the page's top rule. */ y?: number;
  saving?: boolean; error?: string; notice?: string;
  /** The sub-page open over the settings; the settings keep their drafts underneath. */
  sub?: SettingsSubPage | undefined;
  onSave(changes: Record<string, DraftValue>): void;
  onPreview?(key: string, value: DraftValue): void;
  onDiscard(): void;
  onOpenPage(id: string): void;
  onCloseSub(): void;
  onSubSave?(tabId: string, items: readonly CommandToggle[], appearance?: StatusbarAppearance): void | Promise<void>;
  onSubAction?(tabId: string, action: string): void;
}): ReactElement {
  const view = useRef<SettingsView>(initialView);
  const [, rerender] = useState(0);
  const pointer = usePointer(), hoverColor = useHoverColor(palette.accent);
  const update = (patch: Partial<SettingsView>) => {view.current = {...view.current, ...patch}; rerender(count => count + 1);};
  const plan = settingsLayout({items, pages, view: {...view.current, saving, error, notice}, width, height, y, pointer, hoverColor});
  // Selection and scroll are normalised by the plan; keep them so the next event starts from what is drawn.
  view.current = {...view.current, selected: plan.selected, scroll: plan.scroll};
  const latest = useRef(plan); latest.current = plan;
  const entryAt = (index: number) => latest.current.entries[index < 0 ? view.current.selected : index];

  const setDraft = (key: string, value: DraftValue) => {
    view.current = {...view.current, drafts: {...view.current.drafts, [key]: value}};
    onPreview?.(key, value);
    rerender(count => count + 1);
  };
  const commitEdit = () => {
    const entry = entryAt(-1);
    if (entry?.item && view.current.editing !== undefined) setDraft(entry.key, view.current.editing);
    update({editing: undefined});
  };
  const save = () => {
    if (saving) return;
    if (view.current.editing !== undefined) commitEdit();
    const changes = changedDrafts(items, view.current.drafts);
    if (Object.keys(changes).length === 0) onDiscard(); else onSave(changes);
  };
  const run = (command: SettingsCommand): void => {
    if (saving || sub) return;
    const count = latest.current.entries.length;
    const select = (index: number) => update({selected: Math.max(0, Math.min(count - 1, index)), editing: undefined});
    switch (command.kind) {
      case 'move': if (command.delta !== 0 && count) select((view.current.selected + command.delta + count) % count); return;
      case 'select': if (view.current.editing !== undefined && command.index !== view.current.selected) commitEdit(); select(command.index); return;
      case 'change': case 'toggle': {
        const index = command.index < 0 ? view.current.selected : command.index, entry = entryAt(index);
        if (index !== view.current.selected) select(index);
        if (!entry?.item || entry.item.kind === 'text') return;
        const current = Object.hasOwn(view.current.drafts, entry.key) ? view.current.drafts[entry.key]! : entry.item.value;
        setDraft(entry.key, stepValue(entry.item, current, command.kind === 'toggle' ? (current === true ? -1 : 1) : command.delta));
        return;
      }
      case 'edit': {
        const index = command.index < 0 ? view.current.selected : command.index, entry = entryAt(index);
        if (!entry?.item || entry.item.kind !== 'text') return;
        const current = Object.hasOwn(view.current.drafts, entry.key) ? view.current.drafts[entry.key]! : entry.item.value;
        update({selected: index, editing: String(current)});
        return;
      }
      case 'open': {
        const entry = entryAt(command.index);
        if (entry?.kind === 'page') {update({selected: command.index < 0 ? view.current.selected : command.index}); onOpenPage(entry.key.slice('page:'.length));}
        return;
      }
      case 'search': update({searching: true, editing: undefined}); return;
      case 'searchDone': update({searching: false}); return;
      case 'searchClear': update({searching: false, query: '', selected: 0, scroll: 0}); return;
      case 'save': save(); return;
      case 'discard':
        if (view.current.query) update({query: '', searching: false, selected: 0, scroll: 0});
        else if (latest.current.dirty > 0) update({confirming: true});
        else onDiscard();
        return;
      case 'confirm': if (command.yes) onDiscard(); else update({confirming: false}); return;
    }
  };

  useInput((input, key) => {
    if (key.eventType === 'release' || sub || saving) return;
    const state = view.current;
    if (state.confirming) {
      if (input === 'y' || input === 'Y') run({kind: 'confirm', yes: true});
      else if (input === 'n' || input === 'N' || key.escape) run({kind: 'confirm', yes: false});
      return;
    }
    if (state.editing !== undefined) {
      if (key.return) commitEdit();
      else if (key.escape) update({editing: undefined});
      else if (key.backspace || key.delete) update({editing: [...state.editing].slice(0, -1).join('')});
      else if (key.ctrl && input === 'u') update({editing: ''});
      else if (key.ctrl && input === 's') save();
      else if (input && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(input)) update({editing: [...state.editing + input].slice(0, TEXT_LIMIT).join('')});
      return;
    }
    if (state.searching) {
      if (key.escape) run({kind: 'searchClear'});
      else if (key.return || key.downArrow || key.upArrow) {update({searching: false}); if (key.upArrow || key.downArrow) run({kind: 'move', delta: key.upArrow ? -1 : 1});}
      else if (key.backspace || key.delete) update({query: [...state.query].slice(0, -1).join(''), selected: 0, scroll: 0});
      else if (key.ctrl && input === 'u') update({query: '', selected: 0, scroll: 0});
      else if (input && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(input)) update({query: state.query + input, selected: 0, scroll: 0});
      return;
    }
    const count = latest.current.entries.length;
    if (key.escape) {run({kind: 'discard'}); return;}
    if (key.ctrl && input === 's') {save(); return;}
    if (key.ctrl) return;
    if (key.upArrow || (key.tab && key.shift)) {run({kind: 'move', delta: -1}); return;}
    if (key.downArrow || key.tab) {run({kind: 'move', delta: 1}); return;}
    if (key.pageUp || key.pageDown) {update({selected: Math.max(0, Math.min(count - 1, state.selected + (key.pageUp ? -1 : 1) * latest.current.listRows))}); return;}
    if (key.home || key.end) {update({selected: key.home ? 0 : Math.max(0, count - 1)}); return;}
    if (key.leftArrow || key.rightArrow) {run({kind: 'change', index: -1, delta: key.leftArrow ? -1 : 1}); return;}
    if (input === '/') {run({kind: 'search'}); return;}
    const entry = entryAt(-1);
    if (input === ' ') {
      if (entry?.kind === 'page') run({kind: 'open', index: -1});
      else if (entry?.item?.kind === 'text') run({kind: 'edit', index: -1});
      else if (entry?.item?.kind === 'boolean') run({kind: 'toggle', index: -1});
      else run({kind: 'change', index: -1, delta: 1});
      return;
    }
    if (key.return) {
      if (entry?.kind === 'page') run({kind: 'open', index: -1});
      else if (entry?.item?.kind === 'text') run({kind: 'edit', index: -1});
      else save();
    }
  });

  const actions: readonly FooterAction[] = error || notice || saving ? [] : plan.footer.actions.map(part => ({label: part.label, run: () => run(part.command)}));
  const footerView = footerParts(plan.footer.text, actions, width, y, height);
  const hoveredFooter = hitFooter(footerView, pointer);
  useMouse(event => {
    if (sub || saving || event.x < 0 || event.x >= width || event.y < y || event.y >= y + height) return;
    const wheel = event.action === 'wheel_up' ? -1 : event.action === 'wheel_down' ? 1 : 0;
    if (wheel) {if (!view.current.confirming && view.current.editing === undefined) run({kind: 'move', delta: wheel}); return;}
    if (event.action !== 'press' || event.button !== 0) return;
    const clickedFooter = hitFooter(footerView, event);
    if (clickedFooter?.run) {clickedFooter.run(); return;}
    const hit = latest.current.hits.find(candidate => inRegion(event, candidate.region));
    if (view.current.confirming && hit?.command.kind !== 'confirm') return;
    if (hit) run(hit.command);
  });

  if (sub) return <TabbedPage key={sub.id} title={sub.title} tabs={sub.tabs} initialTab={sub.initialTab} width={width} height={height} y={y}
    onClose={onCloseSub} saving={sub.saving ?? false} error={sub.error ?? ''} notice={notice}
    {...(sub.confirm ? {confirm: sub.confirm} : {})} {...(onSubSave ? {onSave: onSubSave} : {})} {...(onSubAction ? {onAction: onSubAction} : {})}/>;

  const frame = panelRows(height);
  return <PanelFrame title="Settings" width={width} height={height} footer={plan.footer.text} parts={footerView} hovered={hoveredFooter} hoverColor={hoverColor} bleed
    header={<Text wrap="truncate">{plan.header.map((seg, index) => <Text key={index} color={seg.color} bold={seg.bold === true}>{seg.text}</Text>)}</Text>}>
    <Box flexDirection="column" height={frame.bodyHeight} flexShrink={0} overflow="hidden">
      {plan.rows.map((segs, index) => <Line key={index} segs={segs}/>)}
    </Box>
  </PanelFrame>;
}
