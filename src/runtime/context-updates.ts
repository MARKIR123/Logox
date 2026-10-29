import {z} from 'zod';

export const executionEnvironmentSchema = z.strictObject({
  model: z.string(), effort: z.string(), permission: z.string(), directory: z.string(),
  scratchpad: z.string(), rules: z.string(), services: z.array(z.string()).readonly(),
});
export type ExecutionEnvironment = z.infer<typeof executionEnvironmentSchema>;
export const runtimeContextMessageSchema = z.strictObject({
  role: z.literal('context'),
  kind: z.enum(['environment-baseline', 'environment-change', 'capability-change', 'task-state', 'recovery', 'finalizer', 'ledger']),
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
export function createRuntimeContextMessage(kind: RuntimeContextMessage['kind'], text: string, data?: Record<string, unknown>): RuntimeContextMessage {
  return runtimeContextMessageSchema.parse({role: 'context', kind, text, ...(data ? {data} : {})});
}

export function runtimeContextText(message: RuntimeContextMessage): string {
  return '[Application context: ' + message.kind + '; not a human request or new authorization]\n' + message.text;
}
