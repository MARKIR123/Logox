import {stat} from 'node:fs/promises';
import {z} from 'zod';
import {pathArg, type ToolResult} from '../types.js';
import {bytesOrMissing, type Snapshots} from '../snapshots.js';

export const writeSchema = z.strictObject({
  path: pathArg,
  content: z.string(),
});

export type WriteArgs = z.infer<typeof writeSchema>;

export async function executeWrite(
  args: WriteArgs,
  canonicalPath: string,
  snapshots: Snapshots,
  activityId = 'task',
  signal: AbortSignal = new AbortController().signal
): Promise<ToolResult> {
  const size = await stat(canonicalPath).then(info => info.size).catch(error => {
    if (error.code === 'ENOENT') return 0;
    throw error;
  });
  if (size > 32 * 1024 * 1024) throw new Error('File exceeds 32 MiB, use search to narrow scope');

  const before = await bytesOrMissing(canonicalPath);
  if (before && before.length > 32 * 1024 * 1024) throw new Error('File exceeds 32 MiB');

  const after = Buffer.from(args.content);
  if (after.length > 32 * 1024 * 1024) throw new Error('Content exceeds 32 MiB');

  await snapshots.apply(canonicalPath, before, after, activityId, signal);
  return {
    text: 'Updated ' + canonicalPath + '; use /undo to revert file changes from this round.',
    isError: false,
  };
}
