import {stat} from 'node:fs/promises';
import {z} from 'zod';
import {pathArg, type ToolResult} from '../types.js';
import {bytesOrMissing, type Snapshots} from '../snapshots.js';

export const editSchema = z.strictObject({
  path: pathArg,
  old_text: z.string().min(1),
  new_text: z.string(),
  replace_all: z.boolean().default(false),
});

export type EditArgs = z.infer<typeof editSchema>;

function decode(bytes: Buffer): {text: string; bom: boolean} {
  if (bytes.includes(0)) throw new Error('Binary or UTF-16 files are not supported yet');
  const bom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
  try {
    return {text: new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bom ? bytes.subarray(3) : bytes), bom};
  } catch {
    throw new Error('File is not valid UTF-8, no changes applied');
  }
}

export async function executeEdit(
  args: EditArgs,
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
  if (!before) throw new Error('File not found: ' + canonicalPath);
  if (before.length > 32 * 1024 * 1024) throw new Error('File exceeds 32 MiB');

  const decoded = decode(before);
  const newline = decoded.text.includes('\r\n') ? '\r\n' : '\n';
  const old = args.old_text.replace(/\r?\n/g, newline);
  const replacement = args.new_text.replace(/\r?\n/g, newline);
  const count = decoded.text.split(old).length - 1;

  if (!count) throw new Error('No match found for old_text; please re-read file');
  if (count > 1 && !args.replace_all) throw new Error('Multiple matches found; provide more context or set replace_all: true');

  const after = Buffer.from(
    (decoded.bom ? '﻿' : '') +
      (args.replace_all ? decoded.text.split(old).join(replacement) : decoded.text.replace(old, () => replacement))
  );

  if (after.length > 32 * 1024 * 1024) throw new Error('Content exceeds 32 MiB');

  await snapshots.apply(canonicalPath, before, after, activityId, signal);
  return {
    text: 'Updated ' + canonicalPath + '; use /undo to revert file changes from this round.',
    isError: false,
  };
}
