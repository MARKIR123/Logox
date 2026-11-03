import {createHash} from 'node:crypto';
import {basename} from 'node:path';

/**
 * What a Write replaced, kept only for the card (the model never sees it): whether the file was new and, for an overwrite, its
 * previous text. Keyed by file name and content hash, bounded, in memory; a resumed session simply has no record.
 */
export interface WriteRecord {readonly existed: boolean; readonly before?: string}
const records = new Map<string, WriteRecord>();
const MAX_RECORDS = 64;
const MAX_BEFORE = 256 * 1024;
const key = (path: string, content: string) => basename(path).toLowerCase() + '\0' + createHash('sha1').update(content).digest('hex');

export function recordWrite(path: string, content: string, before: Buffer | null): void {
  if (records.size >= MAX_RECORDS) records.delete(records.keys().next().value!);
  records.set(key(path, content), before ? {existed: true, ...(before.length <= MAX_BEFORE ? {before: before.toString('utf8')} : {})} : {existed: false});
}
export function lookupWrite(path: string, content: string): WriteRecord | undefined {
  return records.get(key(path, content));
}
