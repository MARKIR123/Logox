import {z} from 'zod';
import {SEND_MESSAGE_DESCRIPTION} from './prompt.js';
import type {ToolDefinition} from '../../../runtime/messages.js';

export const sendMessageSchema = z.strictObject({
  to: z.string().min(1).describe('Recipient actor, logox, or all'),
  message: z.string().trim().min(1).max(4000).describe('Message, blocker report, consultation, or intervention'),
  type: z.enum(['inform', 'ask', 'reply']).optional().describe('inform (default): one way, needs no answer. ask: you need an answer before your task can finish. reply: your final answer to their ask.'),
  mode: z.enum(['queue', 'interrupt']).optional(),
  summary: z.string().max(200).optional().describe('Short communication label'),
  wake: z.boolean().optional().describe('Set true only if an already-completed idle teammate must wake up and start a new turn to act on this message (default false)'),
});
export const sendMessageTool: ToolDefinition = {name: 'SendMessage', description: SEND_MESSAGE_DESCRIPTION, parameters: z.toJSONSchema(sendMessageSchema, {io: 'input'})};

export const metadata: import('../../metadata.js').ToolMetadataInput = {name: 'SendMessage', category: 'coordination', loading: 'eager', roles: 'all', terminalVisibility: 'notice', description: 'Deliver message to director or peer actor'};
