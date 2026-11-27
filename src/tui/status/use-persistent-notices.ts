// The persistent notices of the session as the terminal sees them: the stored (read) notices of the board plus the pending ones derived from the
// current snapshot, in display order. Owned by the session, so a window switch never touches them.
import {useMemo, useSyncExternalStore} from 'react';
import {persistentNotices, type NoticeBoard, type PersistentNotice, type ReadNotice} from '../../runtime/notices.js';
import type {RuntimeSnapshot} from '../../runtime/contracts.js';
import type {ActorStyles} from '../appearance/actor-style.js';

const noRead: readonly ReadNotice[] = [];
const subscribeNone = () => () => {};
const readNone = () => noRead;

export function usePersistentNotices({board, snapshot, sessionId, roles}: {board: NoticeBoard | undefined; snapshot: RuntimeSnapshot; sessionId: string; roles: ActorStyles}): readonly PersistentNotice[] {
  const read = useSyncExternalStore(board?.subscribe ?? subscribeNone, board?.getSnapshot ?? readNone);
  return useMemo(() => persistentNotices(read, snapshot, sessionId, ownerId => roles[ownerId]?.name ?? ownerId),
    [read, snapshot.interactions, snapshot.activities, sessionId, roles]);
}
