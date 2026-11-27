/**
 * The session's read notices: the board the footer shows (`src/runtime/notices.ts:NoticeBoard`) restored from `notices.json` of the session
 * tree at startup and saved after every change, one write at a time. It owns the save chain, which `close()` awaits.
 */
import {NoticeBoard} from '../runtime/notices.js';
import type {Journal} from '../store/journal.js';
import type {Notice} from './state.js';

export interface SessionNotices {
  readonly board: NoticeBoard;
  /** The latest queued save, awaited on close. */
  tail(): Promise<void>;
}

export async function createNotices({session, journal, notice}: {session: string; journal: Journal; notice: Notice}): Promise<SessionNotices> {
  let saving: Promise<void> = Promise.resolve();
  const board = new NoticeBoard(session, items => {
    saving = saving.then(() => journal.saveNotices(session, items)).catch(() => {notice('Notices could not be saved.', 'command_error');});
  });
  board.restore(await journal.loadNotices(session).catch(() => {notice('Notices could not be restored.', 'command_error'); return [];}));
  return {board, tail: () => saving};
}
