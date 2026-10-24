import {z} from 'zod';
import {taskOriginSchema} from './contracts.js';
import {inputKindSchema} from './provenance.js';

export const submitDeliverySchema = z.discriminatedUnion('mode', [
  z.strictObject({mode: z.literal('queue')}),
  z.strictObject({mode: z.literal('steer'), activityId: z.string().min(1)}),
]);
export type SubmitDelivery = z.infer<typeof submitDeliverySchema>;

export const deliveryKindSchema = z.enum(['human_steer', 'failure', 'help', 'collaboration', 'report']);
export type DeliveryKind = z.infer<typeof deliveryKindSchema>;
export const deliverySchema = z.strictObject({
  id: z.string().min(1), sessionId: z.string().min(1), ownerId: z.string().min(1),
  source: z.string().min(1), sourceActivityId: z.string().optional(), rootActivityId: z.string().optional(),
  targetActivityId: z.string().optional(), kind: deliveryKindSchema, inputKind: inputKindSchema,
  text: z.string().min(1), time: z.number(), origin: taskOriginSchema.optional(),
  status: z.enum(['pending', 'delivered', 'cancelled']), recipientActivityId: z.string().optional(), deferredUntilHuman: z.boolean().optional(),
  successorId: z.string().optional(), recoveryGrantActivityId: z.string().optional(),
});
export type Delivery = z.infer<typeof deliverySchema>;
export type DeliveryInput = Omit<Delivery, 'sessionId' | 'status' | 'time' | 'id'> & {id?: string; time?: number};
export const deliveryPriority: Record<DeliveryKind, number> = {human_steer: 0, failure: 1, help: 1, collaboration: 2, report: 3};
