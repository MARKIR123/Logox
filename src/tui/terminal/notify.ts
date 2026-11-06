import type {RuntimeSnapshot} from '../../runtime/contracts.js';
import type {UiSettings} from '../../config/ui-settings.js';

/** A round has to run at least this long before `Notify when done` speaks up. */
export const NOTIFY_AFTER_MS = 30_000;
const OSC9_TERMINALS = new Set(['iTerm.app', 'WezTerm', 'ghostty', 'Ghostty', 'rio']);
/** OSC 9 desktop notification where the terminal is known to support it, the plain bell everywhere else. */
export function notificationSequence(message: string, env: NodeJS.ProcessEnv = process.env): string {
  const clean = message.replace(/[\x00-\x1f\x7f]/g, ' ');
  return OSC9_TERMINALS.has(env.TERM_PROGRAM ?? '') ? '\x1b]9;' + clean + '\x07' : '\x07';
}
const busy = new Set(['queued', 'running', 'waiting_input']);

/**
 * Watches the runtime for the end of a stretch of work: it starts when any activity of the session becomes busy and ends when none is.
 * A stretch of at least `NOTIFY_AFTER_MS` that ends while the terminal is unfocused (or always, by setting) writes one notification.
 */
export class RoundNotifier {
  private startedAt: number | undefined;
  constructor(private readonly options: {
    sessionId: string; mode(): UiSettings['notify']; focused(): boolean | undefined; write(data: string): void;
    now?(): number; threshold?: number; env?: NodeJS.ProcessEnv;
  }) {}
  observe(snapshot: RuntimeSnapshot): boolean {
    const now = this.options.now?.() ?? Date.now();
    const active = snapshot.activities.some(activity => activity.sessionId === this.options.sessionId && busy.has(activity.status));
    if (active) {this.startedAt ??= now; return false;}
    if (this.startedAt === undefined) return false;
    const elapsed = now - this.startedAt;
    this.startedAt = undefined;
    const mode = this.options.mode();
    if (mode === 'off' || elapsed < (this.options.threshold ?? NOTIFY_AFTER_MS)) return false;
    // Without focus reporting the terminal never says it is focused, so it counts as unfocused.
    if (mode === 'unfocused' && this.options.focused() === true) return false;
    this.options.write(notificationSequence('Logox: round finished after ' + Math.round(elapsed / 1000) + 's', this.options.env));
    return true;
  }
}
