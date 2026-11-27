// Persistent notices: what the footer's notification line keeps showing under the transient flashes. Two kinds. A `pending` notice is
// derived from the runtime snapshot (an open approval or question, an error that needs the person) and never stored: it disappears
// when the interaction is answered or the condition clears, and cannot be dismissed. A `read` notice is posted by the application, kept
// with the session (`notices.json`, see `src/app/notices.ts`) and stays until the person dismisses it. Clickable parts carry a small
// serialisable action; the terminal runs it (`src/tui/status/notice-actions.ts`). Nothing here knows about React or the terminal.
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Interaction, RuntimeSnapshot} from './contracts.js';

export type NoticeTone = 'success' | 'warning' | 'error' | 'info';
export const noticeToneSchema = z.enum(['success', 'warning', 'error', 'info']);

/**
 * What a click on a part does. `jump-request` focuses an open approval or question (pending notices), `jump-activity` scrolls the Director
 * timeline to an activity's card, `open-page` opens a read-only Markdown page (a list of changes), `command` runs a slash command line
 * (`/anamnesis`, `/compact`) as the person would.
 */
export type NoticeAction =
  | {readonly kind: 'jump-request'; readonly requestId: string; readonly ownerId: string}
  | {readonly kind: 'jump-activity'; readonly activityId: string}
  | {readonly kind: 'open-page'; readonly title: string; readonly text: string; readonly markdown?: boolean | undefined}
  | {readonly kind: 'command'; readonly name: string; readonly args?: string | undefined};
export const noticeActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({kind: z.literal('jump-request'), requestId: z.string().min(1), ownerId: z.string().min(1)}),
  z.strictObject({kind: z.literal('jump-activity'), activityId: z.string().min(1)}),
  z.strictObject({kind: z.literal('open-page'), title: z.string().min(1).max(200), text: z.string().max(200_000), markdown: z.boolean().optional()}),
  z.strictObject({kind: z.literal('command'), name: z.string().regex(/^[a-z][a-z0-9-]*$/), args: z.string().max(500).optional()}),
]);

/** One run of a notice. A part with an `action` is clickable; a `button` part is drawn as a bracketed control after the line, not joined with ` · `. */
export interface NoticePart {readonly text: string; readonly action?: NoticeAction | undefined; readonly button?: boolean | undefined}
export const noticePartSchema = z.strictObject({text: z.string().min(1).max(500), action: noticeActionSchema.optional(), button: z.boolean().optional()});

export interface ReadNotice {
  readonly id: string; readonly kind: 'read'; readonly sessionId: string; readonly at: number;
  readonly tone: NoticeTone; readonly parts: readonly NoticePart[];
}
export interface PendingNotice {
  readonly id: string; readonly kind: 'pending'; readonly at: number;
  readonly tone: NoticeTone; readonly parts: readonly NoticePart[];
}
export type PersistentNotice = ReadNotice | PendingNotice;
export const readNoticeSchema = z.strictObject({
  id: z.string().min(1), kind: z.literal('read'), sessionId: z.string(), at: z.number(), tone: noticeToneSchema,
  parts: z.array(noticePartSchema).min(1).max(12),
});

/** What the application passes to `postNotice`; `id` makes a post replace the notice with the same id (one notice per round, say). */
export interface NoticeInput {readonly kind: 'read'; readonly tone?: NoticeTone; readonly parts: readonly NoticePart[]; readonly id?: string}

const MAX_READ = 50;

/** The stored (read) notices of one session: newest first, saved through `onChange` after every change, with the usual external-store contract. */
export class NoticeBoard {
  private items: readonly ReadNotice[] = [];
  private readonly listeners = new Set<() => void>();
  constructor(readonly sessionId: string, private readonly onChange?: (items: readonly ReadNotice[]) => void, private readonly clock: () => number = Date.now) {}
  readonly getSnapshot = (): readonly ReadNotice[] => this.items;
  readonly subscribe = (listener: () => void): (() => void) => {this.listeners.add(listener); return () => {this.listeners.delete(listener);};};
  private set(items: readonly ReadNotice[]): void {
    this.items = items;
    this.onChange?.(items);
    for (const listener of this.listeners) listener();
  }
  /** Puts saved notices back (a resumed session); nothing is written. */
  restore(items: readonly ReadNotice[]): void {
    this.items = [...items].sort((a, b) => b.at - a.at).slice(0, MAX_READ);
    for (const listener of this.listeners) listener();
  }
  /** Posts a read notice; it stays until dismissed. An input with an existing `id` replaces that notice (and moves to the top). */
  postNotice(input: NoticeInput): string {
    const parts = z.array(noticePartSchema).min(1).max(12).parse(input.parts) as readonly NoticePart[];
    const id = input.id ?? randomUUID();
    const newest = Math.max(this.clock(), (this.items[0]?.at ?? 0) + 1);
    const notice: ReadNotice = {id, kind: 'read', sessionId: this.sessionId, at: newest, tone: input.tone ?? 'info', parts};
    this.set([notice, ...this.items.filter(item => item.id !== id)].slice(0, MAX_READ));
    return id;
  }
  /** Removes one notice; false when it is not there. */
  dismiss(id: string): boolean {
    if (!this.items.some(item => item.id === id)) return false;
    this.set(this.items.filter(item => item.id !== id));
    return true;
  }
  /** Removes every read notice and returns how many there were. */
  dismissAll(): number {
    const count = this.items.length;
    if (count) this.set([]);
    return count;
  }
}

const INTERACTION_TITLE_MAX = 60;
const clip = (text: string, max: number) => text.length > max ? text.slice(0, max - 1) + '…' : text;
/** The open interactions of the session, newest first, as pending notices (`nameOf` turns an owner id into a display name). */
function interactionNotices(interactions: readonly Interaction[], sessionId: string, nameOf: (ownerId: string) => string): PendingNotice[] {
  const out: PendingNotice[] = [];
  interactions.forEach((request, index) => {
    if (request.sessionId !== sessionId || request.status !== 'pending') return;
    const action: NoticeAction = {kind: 'jump-request', requestId: request.requestId, ownerId: request.ownerId};
    const name = nameOf(request.ownerId);
    out.push(request.kind === 'permission'
      ? {id: 'pending:' + request.requestId, kind: 'pending', at: index, tone: 'warning', parts: [{text: name + ' awaits approval', action}, {text: request.tool}]}
      : {id: 'pending:' + request.requestId, kind: 'pending', at: index, tone: 'warning', parts: [{text: name + ' asks you', action}, {text: clip(request.title, INTERACTION_TITLE_MAX)}]});
  });
  return out.reverse();
}
const NO_MODEL = /Anamnesis has no usable model \([^)]*\)/;
/** Errors that stay until the condition clears: today, an Anamnesis run that failed because its model cannot be used (the next run that starts removes the failed card). */
function errorNotices(snapshot: RuntimeSnapshot, sessionId: string): PendingNotice[] {
  const failed = snapshot.activities.findLast(activity => activity.sessionId === sessionId && activity.kind === 'anamnesis' && activity.status === 'failed' && NO_MODEL.test(activity.detail));
  const text = failed ? NO_MODEL.exec(failed.detail)?.[0] : undefined;
  return failed && text ? [{id: 'pending:model:' + failed.activityId, kind: 'pending', at: failed.createdAt ?? 0, tone: 'error',
    parts: [{text, action: {kind: 'command', name: 'anamnesis'}}, {text: 'choose one with /anamnesis'}]}] : [];
}
/** Pending notices derived from the snapshot: open approvals and questions of every actor (newest first), then errors that need the person. Never stored. */
export function pendingNotices(snapshot: RuntimeSnapshot, sessionId: string, nameOf: (ownerId: string) => string = id => id): readonly PendingNotice[] {
  return [...interactionNotices(snapshot.interactions, sessionId, nameOf), ...errorNotices(snapshot, sessionId)];
}
/** Every persistent notice in display order: pending first, then read, each newest first. */
export function persistentNotices(read: readonly ReadNotice[], snapshot: RuntimeSnapshot, sessionId: string, nameOf?: (ownerId: string) => string): readonly PersistentNotice[] {
  return [...pendingNotices(snapshot, sessionId, nameOf), ...read];
}
/** The action a click on the notice (or Enter on its row) runs: that of its first clickable part. */
export function mainAction(notice: PersistentNotice): NoticeAction | undefined {
  return notice.parts.find(part => part.action && !part.button)?.action ?? notice.parts.find(part => part.action)?.action;
}
