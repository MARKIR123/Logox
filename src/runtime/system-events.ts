import {z} from 'zod';

export const systemPresentationSchema = z.enum(['timeline', 'status', 'panel', 'silent', 'welcome']);
export type SystemPresentation = z.infer<typeof systemPresentationSchema>;

export const systemEventSchema = z.strictObject({version: z.literal(1), id: z.string().uuid(),
  sessionId: z.string().min(1), ownerId: z.string().min(1), time: z.number().finite(),
  kind: z.enum(['command_result', 'command_error', 'model_error', 'environment_change', 'task_notice']),
  text: z.string(), activityId: z.string().optional(),
  presentation: systemPresentationSchema.optional(), title: z.string().optional()});
export type SystemEvent = z.infer<typeof systemEventSchema>;

/** Legacy messages remain visible; only explicitly routed system events leave the timeline. */
export function isTimelineMessage(message: {readonly role: string; readonly systemPresentation?: SystemPresentation | undefined}): boolean {
  return message.role !== 'system' || message.systemPresentation === undefined || message.systemPresentation === 'timeline';
}
