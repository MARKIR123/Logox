/**
 * Shared vocabulary of the application container (`src/application.ts`): the small mutable state record that several
 * service groups read and write, and the notice and receipt signatures they emit through. The record is created once by
 * `createSessionApplication`; every field has exactly one writer family, named on the field. Group-private state (the
 * model selection, the viewed provider, the status revision) lives in the module that owns it, not here.
 */
import type {SystemHistory} from '../store/system-history.js';

export type Notice = (text: string, kind?: Parameters<SystemHistory['emit']>[1], owner?: string, activityId?: string,
  display?: NonNullable<Parameters<SystemHistory['emit']>[5]>) => void;
export type Receipt = (text: string, presentation: 'silent' | 'status' | 'panel', title?: string, owner?: string) => void;

export interface CompactTask {activityId: string; controller: AbortController; done: Promise<void>}

export interface SessionState {
  /** Set by `close()`; read by notices, query results, pending delivery and `submit`. */
  closed: boolean;
  /** The window whose command is running; written by `submit`, read by notices, the provider page and the surface host. */
  commandOwner: string;
  /** The window that opened the login wizard; written by `submit` and `activate`, read by the credential callback. */
  loginOwner: string;
  /** The window whose pages (status, usage, ensemble) are shown; written by `submit`. */
  pageOwner: string;
  /** The slash command of the open tabbed page, for live refresh; written by `submit` and the settings sub-pages, cleared when the surface closes. */
  activeCommandPage: string;
  /** The preferred name; written by `/name`, the settings page and onboarding, read by request assembly. */
  userName: string | undefined;
  /** In-flight `/compact`; written by `submit`, read by `busy` and `cancel`. */
  compactTask: CompactTask | undefined;
  /** In-flight `/reload`; written by `submit`, read by `busy`. */
  reloadTask: Promise<void> | undefined;
  /** In-flight `/permissions` edit; written by `submit`, read by `busy`. */
  permissionTask: Promise<void> | undefined;
}
