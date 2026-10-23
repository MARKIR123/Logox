import {stat} from 'node:fs/promises';
import {z} from 'zod';
import {pathArg, type ToolResult} from '../types.js';
import {bytesOrMissing} from '../snapshots.js';
import {normalizeAliases} from '../aliases.js';

const readArgs = z.strictObject({
  file_path: pathArg.describe('The absolute path to the file to read'),
  offset: z.number().int().positive().optional().describe('The line number to start reading from (1-indexed). Only provide if the file is too large to read at once.'),
  limit: z.number().int().min(1).max(2000).optional().describe('The number of lines to read. Only provide if the file is too large to read at once.'),
});

/** Deprecated alias: `path` is accepted during the migration window. */
export const readSchema = z.preprocess(value => normalizeAliases(value, {path: 'file_path'}), readArgs);

export type ReadArgs = z.infer<typeof readArgs>;

const imageMimes: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

function decode(bytes: Buffer): {text: string; bom: boolean} {
  if (bytes.includes(0)) throw new Error('Binary or UTF-16 files are not supported yet');
  const bom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
  try {
    return {text: new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bom ? bytes.subarray(3) : bytes), bom};
  } catch {
    throw new Error('File is not valid UTF-8, no changes applied');
  }
}

export async function executeRead(args: ReadArgs, canonicalPath: string): Promise<ToolResult> {
  const size = await stat(canonicalPath).then(info => info.size).catch(error => {
    if (error.code === 'ENOENT') return 0;
    throw error;
  });
  if (size > 32 * 1024 * 1024) throw new Error('File exceeds 32 MiB, use search to narrow scope');

  const bytes = await bytesOrMissing(canonicalPath);
  if (!bytes) throw new Error('File not found: ' + args.file_path);
  if (bytes.length > 32 * 1024 * 1024) throw new Error('File exceeds 32 MiB, use search to narrow scope');

  const ext = canonicalPath.slice(canonicalPath.lastIndexOf('.')).toLowerCase();
  const mime = imageMimes[ext];
  if (mime) {
    if (bytes.length > 10 * 1024 * 1024) throw new Error('Image exceeds 10 MiB limit');
    return {
      text: `[Image file: ${args.file_path}, size: ${bytes.length} bytes, format: ${mime}. Visual content presented to model.]`,
      isError: false,
      images: [{data: bytes.toString('base64'), mimeType: mime}],
    };
  }

  const offset = args.offset ?? 1;
  const limit = args.limit ?? 2000;
  const lines = decode(bytes).text.split(/\r?\n/);
  return {
    text: lines.slice(offset - 1, offset - 1 + limit)
      .map((line, index) => (offset + index) + ': ' + line.slice(0, 2000)).join('\n') +
      (lines.length > offset - 1 + limit ? '\n(Remaining lines omitted)' : ''),
    isError: false,
  };}
