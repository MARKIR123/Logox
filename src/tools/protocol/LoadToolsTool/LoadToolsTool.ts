import {z} from 'zod';
import type {ToolMetadataInput} from '../../metadata.js';

export const loadToolsSchema = z.strictObject({names: z.array(z.string().min(1)).min(1).describe('Exact tool names to load together')});
export const metadata: ToolMetadataInput = {name: 'LoadTools', category: 'protocol', roles: 'all', loading: 'eager', terminalVisibility: 'silent',
  description: 'Load full contracts for named tools without executing them'};
