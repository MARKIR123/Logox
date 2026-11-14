// The full-screen takeovers that replace the whole layout: the expanded composer and the result, settings, ensemble and
// tabbed-page surfaces. Returns null when none applies. It is a plain function (not a component) so the tree `App` returns,
// including its `MouseHost` root, is exactly what the inline branches used to return.
import type {ReactElement} from 'react';
import {FullscreenEditor} from '../input/fullscreen-editor.js';
import type {ShellContext} from '../input/shell-context.js';
import {MouseHost} from '../terminal/mouse.js';
import {osc52Clipboard} from '../terminal/clipboard.js';
import {CommandResultPanel} from './command-result.js';
import {EnsemblePage} from './ensemble-page.js';
import {SettingsPage} from './settings-page.js';
import {TabbedPage} from './tabbed-page.js';

export function overlayPage(ctx: ShellContext): ReactElement | null {
  const {close, closing, composerExpanded, composerMode, currentView, draft, exitDeadline, flash, interrupt, notice, onDraft, roles, screenRows,
      sendSceneInput, setComposerMode, setCursorPosition, setDraft, setNotice, stdout, steerInput, subscribeMouse, surface, surfaces,
      width, windowColor} = ctx;
  if (composerExpanded) return <MouseHost subscribe={subscribeMouse} color={windowColor}>
    <FullscreenEditor draft={draft} width={width} height={screenRows} disabled={closing} title={'Compose · ' + (roles[currentView]?.name ?? currentView)} notice={notice}
      onEdit={update => {setDraft(update); onDraft?.(); exitDeadline.current = 0; if (notice) setNotice('');}}
      onCollapse={() => {setComposerMode(null); exitDeadline.current = 0;}}
      onSubmit={() => sendSceneInput()} onSteer={steerInput}
      onCopy={text => {stdout?.write(osc52Clipboard(text)); exitDeadline.current = 0;}}
      onInterrupt={interrupt} onClose={close} onCursor={setCursorPosition}
      scrollOffset={composerMode?.scrollOffset ?? null}
      onScroll={scrollOffset => setComposerMode(previous => previous && previous.scrollOffset !== scrollOffset ? {...previous, scrollOffset} : previous)}/>
  </MouseHost>;
  if (surface?.kind === 'result' && surfaces) return <MouseHost subscribe={subscribeMouse} color={windowColor}>
    <CommandResultPanel key={surface.id} title={surface.title} text={surface.text} styled={surface.lines} width={width} height={screenRows}
      onClose={() => surfaces.cancel()} onCopy={text => {stdout?.write(osc52Clipboard(text)); exitDeadline.current = 0;}}/>
  </MouseHost>;
  if (surface?.kind === 'settings' && surfaces) return <MouseHost subscribe={subscribeMouse} color={windowColor}><SettingsPage key={surface.id} items={surface.items} pages={surface.pages}
    width={width} height={screenRows} saving={surface.saving ?? false} error={surface.error ?? ''} notice={notice} sub={surface.sub}
    onSave={changes => {void surfaces.saveSettings(surface.id, changes);}} onPreview={(key, value) => surfaces.previewSetting(surface.id, key, value)}
    onDiscard={() => surfaces.cancel()} onOpenPage={id => surfaces.openSettingsPage(surface.id, id)} onCloseSub={() => surfaces.closeSettingsPage(surface.id)}
    onSubSave={(tabId, items, appearance) => surfaces.saveToggles(surface.id, tabId, items, appearance)}
    onSubAction={(tabId, action) => {void surfaces.triggerTabAction(surface.id, tabId, action);}}/></MouseHost>;
  if (surface?.kind === 'ensemble' && surfaces) return <MouseHost subscribe={subscribeMouse} color={windowColor}><EnsemblePage key={surface.id} data={surface.data} width={width} height={screenRows} notice={notice}
    onClose={() => surfaces.cancel()} onModel={actorId => {void surfaces.ensembleModel(surface.id, actorId).catch(error => flash(error instanceof Error ? error.message : String(error), 3500, 'error'));}}
    onNotice={text => flash(text, 3500, 'info')}
    onEdit={path => {void surfaces.ensembleEdit(surface.id, path).then(result => flash(result.message, 5000, result.ok ? 'success' : 'error'));}}/></MouseHost>;
  if (surface?.kind === 'page' && surfaces) return <MouseHost subscribe={subscribeMouse} color={windowColor}><TabbedPage key={surface.id} title={surface.title} tabs={surface.tabs}
    initialTab={surface.initialTab} width={width} height={screenRows} onClose={() => surfaces.cancel()}
    saving={surface.saving ?? false} error={surface.error ?? ''} notice={notice} onSave={(tabId, items, appearance) => surfaces.saveToggles(surface.id, tabId, items, appearance)}
    {...(surface.confirm ? {confirm: surface.confirm} : {})}
    onAction={(tabId, action) => {void surfaces.triggerTabAction(surface.id, tabId, action);}}/></MouseHost>;
  return null;
}
