import {stat} from 'node:fs/promises';
import {z} from 'zod';
import {pathArg, type ToolResult} from '../types.js';
import {bytesOrMissing, type Snapshots} from '../snapshots.js';
import {normalizeAliases} from '../aliases.js';

const editArgs = z.strictObject({
  file_path: pathArg.describe('The absolute path to the file to modify'),
  old_string: z.string().min(1).describe('The text to replace'),
  new_string: z.string().describe('The text to replace it with (must be different from old_string)'),
  replace_all: z.boolean().optional().describe('Replace all occurrences of old_string (default false)'),
});

/** Deprecated aliases: `path`, `old_text`, `new_text` are accepted during the migration window. */
export const editSchema = z.preprocess(
  value => normalizeAliases(value, {path: 'file_path', old_text: 'old_string', new_text: 'new_string'}),
  editArgs,
);

export type EditArgs = z.infer<typeof editArgs>;

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
  signal: AbortSignal = new AbortController().signal,
  ownerId?: string,
): Promise<ToolResult> {
  return snapshots.withLock(canonicalPath, async () => {
    const size = await stat(canonicalPath).then(info => info.size).catch(error => {
      if (error.code === 'ENOENT') return 0;
      throw error;
    });
    if (size > 32 * 1024 * 1024) throw new Error('File exceeds 32 MiB, use search to narrow scope');

    const before = await bytesOrMissing(canonicalPath);
    if (!before) throw new Error('File not found: ' + canonicalPath);
    if (before.length > 32 * 1024 * 1024) throw new Error('File exceeds 32 MiB');

    const decoded = decode(before);
    const normalized = decoded.text.replace(/\r\n/g, '\n');
    const old = args.old_string.replace(/\r\n/g, '\n');
    const replaceAll = args.replace_all ?? false;
    let index = normalized.indexOf(old);

    if (index < 0) {
      const peer = snapshots.stalePeerWriter(canonicalPath, before, ownerId);
      if (peer) {
        throw new Error(`No match found for old_string; file was updated by ${peer} since your last read — please Read the file again before editing`);
      }
      throw new Error('No match found for old_string; please re-read file');
    }
    if (!replaceAll && normalized.indexOf(old, index + 1) >= 0) {
      throw new Error('Multiple matches found; provide more context or set replace_all: true');
    }

    // Match logical lines, but map offsets back to the original text before writing.
    const crlfs = decoded.text.matchAll(/\r\n/g);
    let nextCrlf = crlfs.next(), skipped = 0;
    const rawOffset = (offset: number): number => {
      while (!nextCrlf.done && nextCrlf.value.index < offset + skipped) {
        skipped++;
        nextCrlf = crlfs.next();
      }
      return offset + skipped;
    };
    const parts: string[] = [];
    let cursor = 0;
    do {
      const start = rawOffset(index), end = rawOffset(index + old.length);
      let replacement = args.new_string;
      if (replacement.includes('\n')) {
        let lineEnd = decoded.text.indexOf('\n', start);
        if (lineEnd < 0) lineEnd = decoded.text.lastIndexOf('\n', start - 1);
        const newline = lineEnd > 0 && decoded.text[lineEnd - 1] === '\r' ? '\r\n' : '\n';
        replacement = replacement.replace(/\r?\n/g, newline);
      }
      parts.push(decoded.text.slice(cursor, start), replacement);
      cursor = end;
      index = replaceAll ? normalized.indexOf(old, index + old.length) : -1;
    } while (index >= 0);
    parts.push(decoded.text.slice(cursor));
    const after = Buffer.from((decoded.bom ? '﻿' : '') + parts.join(''));

    if (after.length > 32 * 1024 * 1024) throw new Error('Content exceeds 32 MiB');

    await snapshots.apply(canonicalPath, before, after, activityId, signal, ownerId);
    return {
      text: 'Updated ' + canonicalPath + '; use /undo to revert file changes from this round.',
      isError: false,
    };
  });
}

export const metadata: import('../metadata.js').ToolMetadataInput = {name: 'Edit', category: 'core', roles: 'all', terminalVisibility: 'card', description: 'Perform exact string replacement in a file'};
