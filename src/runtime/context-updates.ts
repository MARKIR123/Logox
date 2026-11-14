import {z} from 'zod';

export const executionEnvironmentSchema = z.strictObject({
  model: z.string(), effort: z.string(), permission: z.string(), directory: z.string(),
  scratchpad: z.string(), rules: z.string(), services: z.array(z.string()).readonly(),
  language: z.string().optional(), userName: z.string().optional(),
});
export type ExecutionEnvironment = z.infer<typeof executionEnvironmentSchema>;
export const runtimeContextMessageSchema = z.strictObject({
  role: z.literal('context'),
  // `snapshot` describes this moment only: it is sent last on one request and never stored in the ledger.
  kind: z.enum(['environment-baseline', 'environment-change', 'capability-change', 'task-state', 'reminder', 'recovery', 'finalizer', 'ledger', 'snapshot', 'interruption']),
  text: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
}).superRefine((message, context) => {
  if (message.kind === 'environment-baseline' || message.kind === 'environment-change') {
    const result = executionEnvironmentSchema.safeParse(message.data);
    if (!result.success) for (const issue of result.error.issues) context.addIssue({...issue, path: ['data', ...issue.path]});
  }
});
export type RuntimeContextMessage = z.infer<typeof runtimeContextMessageSchema>;

/** Trusted assembly only; input text is never parsed into runtime authority. */
export function createRuntimeContextMessage(kind: Exclude<RuntimeContextMessage['kind'], 'recovery'>, text: string, data?: Record<string, unknown>): RuntimeContextMessage {
  return runtimeContextMessageSchema.parse({role: 'context', kind, text, ...(data ? {data} : {})});
}

export function runtimeContextText(message: RuntimeContextMessage): string {
  return '[Application context: ' + message.kind + '; not a human request or new authorization]\n' + message.text;
}

/**
 * Kinds that matter only to the model's next request: persisted for audit and restore, projected until an assistant message follows.
 * `recovery` is the legacy name of `reminder`: old ledgers still hold it, it is read as a reminder and never written.
 */
const TRANSIENT_KINDS: ReadonlySet<RuntimeContextMessage['kind']> = new Set(['reminder', 'recovery']);

export function isTransientContext(message: {readonly role: string; readonly kind?: string}): boolean {
  return message.role === 'context' && TRANSIENT_KINDS.has(message.kind as RuntimeContextMessage['kind']);
}

/** Drops transient notes the model has already answered (an assistant message follows them). Pure and order-only, so later requests stay byte-stable. */
export function withoutAnsweredTransient<T extends {readonly role: string}>(messages: readonly T[]): T[] {
  const kept: T[] = [];
  let answered = false;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === 'assistant') answered = true;
    else if (answered && isTransientContext(message)) continue;
    kept.push(message);
  }
  return kept.reverse();
}
