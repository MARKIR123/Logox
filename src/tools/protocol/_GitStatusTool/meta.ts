import type {ToolMetadata} from '../../metadata.js';

export const meta: ToolMetadata = {
  name: '_GitStatus',
  category: 'protocol',
  roles: 'all',
  promptVisibility: 'explicit',
  terminalVisibility: 'silent',
  description: 'Fetch current Git branch, tracking status, and clean/dirty working tree state on demand.',
};
