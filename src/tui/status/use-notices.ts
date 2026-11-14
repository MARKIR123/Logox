// The footer notice: a held one-line message with a tone, `flash` to show one for a while, and the observer that turns new
// system status messages of the current window into notices. Every record present at mount or session change is baselined,
// so replays and window switches never re-toast history.
import {useEffect, useRef, useState} from 'react';
import {isDirector} from '../../runtime/director-id.js';
import type {RuntimeSnapshot} from '../../runtime/contracts.js';
import type {RuntimeStore} from '../../runtime/store.js';
import {safeText} from '../terminal/text.js';
import type {NoticeTone} from './notification-line.js';

export function useNotices({store, sessionId, currentView, snapshot}: {store: RuntimeStore; sessionId: string; currentView: string; snapshot: RuntimeSnapshot}) {
  const [notice, setNoticeText] = useState('');
  const [noticeTone, setNoticeTone] = useState<NoticeTone>('info');
  const setNotice = (text: string, tone: NoticeTone = 'info') => {setNoticeText(text); setNoticeTone(tone);};
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flash = (text: string, duration = 3500, tone: NoticeTone = 'info') => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(text, tone); noticeTimer.current = setTimeout(() => setNotice(''), duration);
  };
  useEffect(() => () => {if (noticeTimer.current) clearTimeout(noticeTimer.current);}, []);
  // Baseline every record already present at mount or session change. Replays and window switches never re-toast history.
  const observedSystems = useRef({store, sessionId, view: currentView, ids: new Set(snapshot.messages.map(message => message.id))});
  useEffect(() => {
    const previous = observedSystems.current;
    if (previous.store !== store || previous.sessionId !== sessionId) {
      observedSystems.current = {store, sessionId, view: currentView, ids: new Set(snapshot.messages.map(message => message.id))};
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
      setNotice('');
      return;
    }
    if (previous.view !== currentView) {
      previous.view = currentView;
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
      setNotice('');
    }
    let latest = '', latestTone: NoticeTone = 'info';
    for (const message of snapshot.messages) {
      if (previous.ids.has(message.id)) continue;
      previous.ids.add(message.id);
      if (message.role === 'system' && message.systemPresentation === 'status' && !message.systemReplay &&
          message.sessionId === sessionId && (isDirector(currentView) || message.ownerId === currentView)) {
        latest = message.text;
        latestTone = message.systemEventKind === 'command_error' || message.systemEventKind === 'model_error' ? 'error' : message.systemEventKind === 'command_result' ? 'success' : 'info';
      }
    }
    if (latest) flash(safeText(latest).replace(/\n/g, ' '), 3500, latestTone);
  }, [store, sessionId, currentView, snapshot.messages]);
  return {notice, noticeTone, setNotice, flash};
}
