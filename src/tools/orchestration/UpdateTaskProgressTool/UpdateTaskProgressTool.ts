import {z} from 'zod';
import {activityProgressSchema} from '../../../runtime/contracts.js';

export const updateTaskProgressSchema = activityProgressSchema;
export type UpdateTaskProgressArgs = z.infer<typeof updateTaskProgressSchema>;

export const metadata: import('../../metadata.js').ToolMetadataInput = {name: 'UpdateTaskProgress', category: 'orchestration', roles: 'all', terminalVisibility: 'silent', description: 'Update current high-level task progress'};
