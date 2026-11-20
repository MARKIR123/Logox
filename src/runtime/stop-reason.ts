/**
 * The one outcome vocabulary of delegated work. Activities, task checkpoints, Automa jobs, Director reports, failure notices, the delegation record and the
 * headless report all say how work ended with one of these values, and every other vocabulary (the stop cause the runtime tracks while a task runs, a Finish
 * `failed`, an Automa stall, a provider refusal, a length stop) is mapped to it here and nowhere else. Older ledgers hold the cause words (`user`,
 * `director_cancel`) in the same field: `normalizeStopReason()` reads them.
 */
import {z} from 'zod';

export const STOP_REASONS = ['completed', 'cancelled_by_user', 'cancelled_by_director', 'interrupted', 'shutdown', 'error', 'max_tokens', 'refusal', 'stalled', 'dependency_unmet'] as const;
export const stopReasonSchema = z.enum(STOP_REASONS);
export type StopReasonCode = z.infer<typeof stopReasonSchema>;
/** The cause words older sessions stored in `stopReason` and the runtime still tracks while a task runs. */
export const legacyStopSchema = z.enum(['user', 'shutdown', 'interrupted', 'director_cancel']);
export type StopCause = z.infer<typeof legacyStopSchema>;
/** What a stored `stopReason` may hold: the outcome vocabulary, or an older cause word. */
export const storedStopSchema = z.union([stopReasonSchema, legacyStopSchema]);
export type StoredStop = z.infer<typeof storedStopSchema>;

const LEGACY: Readonly<Record<StopCause, StopReasonCode>> = {user: 'cancelled_by_user', director_cancel: 'cancelled_by_director', shutdown: 'shutdown', interrupted: 'interrupted'};
/** A stored value, new or old, as an outcome; undefined when there is none. */
export function normalizeStopReason(value: string | undefined): StopReasonCode | undefined {
  if (!value) return undefined;
  if ((STOP_REASONS as readonly string[]).includes(value)) return value as StopReasonCode;
  return LEGACY[value as StopCause];
}

/** True for the outcomes in which someone or something deliberately ended the work (as against a failure). */
export const isDeliberateStop = (reason: StopReasonCode | undefined): boolean => reason === 'cancelled_by_user' || reason === 'cancelled_by_director' || reason === 'shutdown' || reason === 'interrupted';

/** `kind` of an execution-recovery error, read without importing the kernel. */
function executionKind(error: unknown): string | undefined {
  return error instanceof Error && error.name === 'ExecutionRecoveryError' ? (error as Error & {kind?: string}).kind : undefined;
}
/** A provider's refusal, as adapters report it (a diagnostic `code` such as `refusal` or `content_filter`). */
function refused(error: unknown): boolean {
  const code = (error as {diagnostic?: {code?: unknown}} | undefined)?.diagnostic?.code;
  return typeof code === 'string' && /^(?:refusal|content_filter|content_policy_violation)$/i.test(code);
}

export interface StopInput {
  /** The activity's final status: `completed`, `failed` or `cancelled`; `skipped` is an Automa job that never started because a job it follows did not end done. */
  readonly status: 'completed' | 'failed' | 'cancelled' | 'skipped';
  /** The stop cause the runtime tracked while the task ran (`user`, `director_cancel`, `shutdown`, `interrupted`); a new outcome value is accepted too. */
  readonly cause?: string | undefined;
  /** What ended a failed task. */
  readonly error?: unknown;
  /** A model turn that ended on the output limit. */
  readonly length?: boolean;
  /** An Automa worker (or any loop) that gave up after turns without a tool call. */
  readonly stalled?: boolean;
}
/** Maps how work ended, in every vocabulary the runtime has, to the one outcome. This is the only place that does it. */
export function stopReasonFor(input: StopInput): StopReasonCode {
  if (input.status === 'completed') return 'completed';
  if (input.status === 'skipped') return 'dependency_unmet';
  if (input.status === 'cancelled') return normalizeStopReason(input.cause) ?? 'interrupted';
  if (input.stalled) return 'stalled';
  if (input.length) return 'max_tokens';
  const kind = executionKind(input.error);
  if (kind === 'truncated_text' || kind === 'truncated_tools') return 'max_tokens';
  if (kind === 'no_delivery') return 'stalled';
  if (refused(input.error)) return 'refusal';
  return 'error';
}

/** Words that look like a secret are removed before a failure text is kept. */
const SECRET = /(?:\b(?:sk|pk|rk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{8,}|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\b(?:api[-_ ]?key|token|secret|password|authorization)\s*[:=]\s*\S+|\b[A-Za-z0-9]{32,}\b)/gi;
export const DIAGNOSTIC_LIMIT = 300;
/** A short, one-line, secret-free text for what went wrong; undefined when it was not an error. */
export function diagnosticOf(reason: StopReasonCode | undefined, error: unknown): string | undefined {
  if (reason === undefined || reason === 'completed' || isDeliberateStop(reason) || error === undefined) return undefined;
  const raw = error instanceof Error ? error.message : String(error);
  const line = raw.split('\n').map(part => part.trim()).find(part => part && !/^(?:Failure reason|Runtime termination cause):?$/.test(part)) ?? '';
  const clean = line.replace(SECRET, '[redacted]').replace(/\s+/g, ' ').trim();
  if (!clean) return undefined;
  return clean.length > DIAGNOSTIC_LIMIT ? clean.slice(0, DIAGNOSTIC_LIMIT - 1).trimEnd() + '…' : clean;
}
