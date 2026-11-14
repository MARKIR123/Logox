// Footer strings derived from state: the left status text (a notice, the statusbar, or the demo/plain fallback), the key-hint
// label, and the notification row (held notice, else hover detail of the widget or pill, else key hints). Pure functions of
// their arguments; `App` supplies the values and decides what the footer shows.
import type {Interaction, Activity, RuntimeSnapshot} from '../../runtime/contracts.js';
import type {StageStatus} from '../../runtime/stage-status.js';
import type {PortfolioActivities} from '../../demo/portfolio.js';
import {demoRoles, type DemoSceneState} from '../../demo/scene.js';
import type {StatusbarId, StatusbarSnapshot} from '../../config/statusbar-preferences.js';
import {uiSettings} from '../../config/ui-settings.js';
import {ownerHeader, type ActorStyles} from '../appearance/actor-style.js';
import {liveStatus, liveStatusLine} from '../timeline/live-status.js';
import {statusbarText, usedPercent} from './statusbar.js';
import type {ActivePillItem} from './actor-pills.js';
import {footerHints, notificationSegments, pillDetail, widgetDetail, type NoteSegment, type Notice, type NoticeTone} from './notification-line.js';

export function statusLeftText({notice, cachedStageStatus, width, layout, demoScene, own, currentView, roles, request, scenario, pending, activities, scene}: {
  notice: string; cachedStageStatus: StageStatus | undefined; width: number; layout: StatusbarSnapshot | null | undefined; demoScene: boolean; own: boolean;
  currentView: string; roles: ActorStyles; request: Interaction | undefined; scenario: PortfolioActivities | undefined; pending: readonly Interaction[];
  activities: readonly Activity[]; scene: DemoSceneState;
}): string {
  const statusLeft = notice
    ? notice
    : cachedStageStatus ? statusbarText(cachedStageStatus, width, layout?.modules, layout ?? undefined)
    : demoScene
      ? own
        ? `${demoRoles[currentView as 'aletheia' | 'techne' | 'kalon'].symbol} ${demoRoles[currentView as 'aletheia' | 'techne' | 'kalon'].name} · ${demoRoles[currentView as 'aletheia' | 'techne' | 'kalon'].role} · Own thread`
        : request?.activityId === scenario?.techne && request
          ? '◈ Logox · Techne awaiting approval'
          : request?.activityId === scenario?.kalon && request
            ? '◈ Logox · Kalon awaiting answer'
            : pending.length ? '◈ Logox · ' + pending.length + ' pending'
              : activities.some(item => item.kind !== 'anamnesis' && ['queued', 'running'].includes(item.status)) ? '◈ Logox · Working'
                : scene.style && scene.runtime?.kalon === 'completed' ? '◈ Logox · Round complete · Anamnesis sorting candidates' : '◈ Logox · Stage ready'
      : `${own ? `${ownerHeader(currentView, roles)} · Own thread` : '◈ Logox'} · ${pending.length ? pending.length + ' pending' : 'Stage ready'}`;
  return statusLeft;
}

export function footerKeyLabel({own, closing, width}: {own: boolean; closing: boolean; width: number}): string {
  const backLabel = own ? 'Esc Back to Logox  ' : '';
  const keysLabel = closing
    ? 'Closing…'
    : own
      ? 'Enter Send'
      : 'Enter Send · Shift+Enter Newline · @role Dispatch';
  const footerKeys = width < 32
    ? own ? 'Esc Back · Enter Send' : 'Enter Send · ^J Newline'
    : width < 60
      ? own ? 'Esc Back to Logox · Enter Send' : 'Enter Send · Shift+Enter Newline'
      : backLabel + keysLabel;
  return footerKeys;
}

export function footerNoteSegments({hoveredPill, activePills, snapshot, getStatus, roles, notice, noticeInline, noticeTone, hoveredWidget, footerStatus, windowColor,
  width, footerHeight, own, queuedHere, menuHeight, closing}: {
  hoveredPill: string | null; activePills: readonly ActivePillItem[]; snapshot: RuntimeSnapshot; getStatus: ((ownerId: string) => StageStatus) | undefined;
  roles: ActorStyles; notice: string; noticeInline: boolean; noticeTone: NoticeTone; hoveredWidget: StatusbarId | null; footerStatus: StageStatus | undefined;
  windowColor: string; width: number; footerHeight: number; own: boolean; queuedHere: number; menuHeight: number; closing: boolean;
}): NoteSegment[] {
  /** Row 2: a held notice, else the detail of the hovered widget or pill, else faint key hints. */
  const pillHoverDetail = (): NoteSegment[] | undefined => {
    const pill = hoveredPill ? activePills.find(item => item.ownerId === hoveredPill) : undefined;
    if (!pill) return undefined;
    const activity = snapshot.activities.find(item => item.activityId === pill.id);
    const own = snapshot.messages.filter(message => message.activityId === pill.id);
    const stage = pill.state === 'question' ? 'Awaiting your answer' : pill.state === 'approval' ? 'Awaiting approval' : pill.state === 'paused' ? 'Paused'
      : pill.state === 'queued' ? (activity?.stage.startsWith('Waiting on ') ? activity.stage : 'Queued')
      : pill.state === 'failed' ? (activity?.detail.split('\n')[0]?.replace(/^Failure reason: /, '').trim() || 'Failed')
      : liveStatusLine(liveStatus(own)) ?? activity?.stage ?? 'Working';
    const first = own.find(message => message.time !== undefined)?.time;
    const reading = getStatus?.(pill.ownerId), percent = reading ? usedPercent(reading) : undefined;
    return pillDetail({symbol: roles[pill.ownerId]?.symbol ?? '◈', name: roles[pill.ownerId]?.name ?? pill.ownerId, color: roles[pill.ownerId]?.color,
      title: activity?.taskTitle ?? activity?.title, stage, ...(first !== undefined ? {elapsedMs: Date.now() - first} : {}), ...(percent !== undefined ? {contextPercent: percent} : {})});
  };
  const noteNotice: Notice | undefined = notice && !noticeInline ? {text: notice, tone: noticeTone} : undefined;
  const hoverDetail = hoveredPill ? pillHoverDetail() : hoveredWidget && footerStatus ? widgetDetail(hoveredWidget, footerStatus, windowColor, width) : undefined;
  const footerNote = footerHeight > 1 ? notificationSegments({notice: noteNotice, detail: hoverDetail,
    hints: footerHints({own, queued: queuedHere, menu: Boolean(menuHeight), closing, width, newlineEnter: uiSettings().enterKey === 'newline'})}, width) : [];
  return footerNote;
}
