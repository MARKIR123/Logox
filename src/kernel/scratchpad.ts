import {join, posix, win32} from 'node:path';
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {createHash, randomUUID} from 'node:crypto';
import {mkdir, rm, writeFile} from 'node:fs/promises';
import type {ImageBlock} from '../runtime/messages.js';

/**
 * Returns the scratchpad directory path for the current session.
 * Path format: <tmpdir>/logox-scratchpad/<cwd-hash>/<sessionId>/
 * This isolates temporary files completely from the user's project directory.
 * It is the session tree: permissions auto-approve all of it and actors may read each other's files.
 */
export function getScratchpadDir(cwd: string, sessionId: string): string {
  const cwdHash = createHash('sha256').update(cwd).digest('hex').slice(0, 12);
  return join(tmpdir(), 'logox-scratchpad', cwdHash, sessionId);
}

/**
 * Returns one actor's private working directory inside the session scratchpad: <session tree>/<actorId>/.
 * Actors write here so concurrent scripts never collide on a file name.
 */
export function getActorScratchpadDir(cwd: string, sessionId: string, actorId: string): string {
  return join(getScratchpadDir(cwd, sessionId), actorId.replace(/[^\w.-]/g, '_') || 'actor');
}

/**
 * Ensures the scratchpad directory exists on disk.
 */
export async function ensureScratchpadDir(cwd: string, sessionId: string): Promise<string> {
  const dir = getScratchpadDir(cwd, sessionId);
  await mkdir(dir, {recursive: true});
  return dir;
}

export async function ensureActorScratchpadDir(cwd: string, sessionId: string, actorId: string): Promise<string> {
  const dir = getActorScratchpadDir(cwd, sessionId, actorId);
  await mkdir(dir, {recursive: true});
  return dir;
}

export type PathResolver = (path: string) => string;

/**
 * Canonical form of a path for comparison: the deepest existing ancestor is resolved through the filesystem (8.3 short names such as
 * `ADMINI~1`, symlinks, drive-letter case) and the not-yet-existing remainder is appended. Forward slashes; lowercased on Windows.
 */
export function canonicalPath(path: string, resolve: PathResolver = realpathSync.native, windows = process.platform === 'win32'): string {
  const finish = (value: string) => {const slashed = value.replaceAll('\\', '/'); return windows ? slashed.toLowerCase() : slashed;};
  let head = path, tail = '';
  for (;;) {
    try {return finish(tail ? (windows ? win32 : posix).join(resolve(head), tail) : resolve(head));}
    catch {
      const parent = (windows ? win32 : posix).dirname(head);
      if (parent === head) return finish(path);
      const name = head.slice(Math.max(head.lastIndexOf('/'), head.lastIndexOf('\\')) + 1);
      tail = tail ? name + '/' + tail : name;
      head = parent;
    }
  }
}

/**
 * Checks if a path is inside the scratchpad directory. Both sides are canonicalized first, so a Windows short-name alias
 * (`C:\Users\ADMINI~1\...` for `C:\Users\Administrator\...`) or a symlink cannot defeat or fake the match.
 */
export function isScratchpadPath(path: string, scratchpadDir: string, resolve: PathResolver = realpathSync.native, windows = process.platform === 'win32'): boolean {
  const normalized = canonicalPath(path, resolve, windows);
  const target = canonicalPath(scratchpadDir, resolve, windows);
  return normalized === target || normalized.startsWith(target.endsWith('/') ? target : target + '/');
}

/**
 * Cleans up scratchpad directory.
 */
export async function cleanScratchpadDir(cwd: string, sessionId: string): Promise<void> {
  const dir = getScratchpadDir(cwd, sessionId);
  await rm(dir, {recursive: true, force: true}).catch(() => {});
}

/** A single tool result longer than this many characters is offloaded to `tool-results/`. */
export const TOOL_OUTPUT_LIMIT = 32768;
/** The tool results of one assistant turn (parallel calls) may total at most this many characters; the largest are offloaded until they fit. */
export const TURN_TOOL_RESULTS_LIMIT = 200_000;

/** The call an offloaded result came from: the tool name and its raw JSON arguments, named in the index so the model knows what the file holds. */
export interface OutputSource {tool: string; arguments?: string | undefined}
const INDEX_HEAD_CHARS = 1536;
const INDEX_TAIL_CHARS = 512;
const INDEX_SUMMARY_CHARS = 120;

/** One line naming what a call was about (command, path, URL, pattern), at most about 120 characters; empty when the arguments say nothing readable. */
export function summarizeArguments(raw: string | undefined): string {
  if (!raw) return '';
  let text: string | undefined;
  try {
    const args: unknown = JSON.parse(raw);
    if (args && typeof args === 'object') {
      const record = args as Record<string, unknown>, pick = (key: string) => typeof record[key] === 'string' && record[key] ? record[key] as string : undefined;
      const pattern = pick('pattern'), where = pick('path') ?? pick('file_path');
      text = pick('command') ?? (pattern && where ? pattern + ' in ' + where : undefined) ?? pick('file_path') ?? pick('path') ?? pick('url') ?? pattern ??
        Object.values(record).find((value): value is string => typeof value === 'string' && value.length > 0);
    } else if (typeof args === 'string') text = args;
  } catch {text = raw;}
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > INDEX_SUMMARY_CHARS ? flat.slice(0, INDEX_SUMMARY_CHARS - 1) + '…' : flat;
}

/**
 * The text that replaces an offloaded result: what it was, how big, where the full text is, and a few lines from each end cut at line
 * boundaries (a line longer than its share is cut with `…`). The line numbers are those of the saved file.
 */
export function persistedIndex(text: string, file: string, source?: OutputSource): string {
  const lines = text.split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  const total = lines.length;
  let size = 0, head = 0;
  while (head < total && size + lines[head]!.length + (head ? 1 : 0) <= INDEX_HEAD_CHARS) {size += lines[head]!.length + (head ? 1 : 0); head++;}
  let first = lines.slice(0, head).join('\n');
  if (head === 0) {head = 1; first = lines[0]!.slice(0, INDEX_HEAD_CHARS) + '…';}
  let last = '', tailStart = total + 1;
  if (head < total) {
    let index = total - 1;
    size = 0;
    while (index >= head && size + lines[index]!.length + (index < total - 1 ? 1 : 0) <= INDEX_TAIL_CHARS) {size += lines[index]!.length + (index < total - 1 ? 1 : 0); index--;}
    if (index === total - 1) {tailStart = total; last = '…' + lines[total - 1]!.slice(-INDEX_TAIL_CHARS);}
    else {tailStart = index + 2; last = lines.slice(index + 1).join('\n');}
  }
  const summary = summarizeArguments(source?.arguments);
  return ['<persisted-output>',
    ...(source ? ['Tool: ' + source.tool + (summary ? ' ' + summary : '')] : []),
    `Size: ${(text.length / 1024).toFixed(1)} KB, ${total} line${total === 1 ? '' : 's'}. Full output: ${file}`,
    'Read it with Read (offset/limit by line) or search it with Grep; do not re-run the tool to see it again.',
    `First lines (1-${head}):`, first, '...',
    ...(tailStart <= total ? [`Last lines (${tailStart}-${total}):`, last] : []),
    '</persisted-output>'].join('\n');
}

/**
 * Persists large tool results (> `limit`, default 32KB) to disk and returns an index in their place (see `persistedIndex`).
 * Text that already is such an index is returned unchanged.
 */
export async function maybePersistLargeOutput(text: string, cwd: string, callId: string, sessionId?: string, ownerId?: string, limit = TOOL_OUTPUT_LIMIT, source?: OutputSource): Promise<string> {
  if (text.length <= limit || text.includes('<persisted-output>')) return text;
  try {
    const dir = sessionId ? join(ownerId ? getActorScratchpadDir(cwd, sessionId, ownerId) : getScratchpadDir(cwd, sessionId), 'tool-results') : join(cwd, '.logox', 'tool-results');
    await mkdir(dir, {recursive: true});
    const file = join(dir, `${callId || randomUUID()}.txt`);
    await writeFile(file, text, 'utf8');
    return persistedIndex(text, file, source);
  } catch {
    return text;
  }
}

const IMAGE_EXTENSIONS: Record<string, string> = {'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif'};

/**
 * Gives every image of one tool result a file on disk, decided once when the result is created. An image that already names its
 * source file keeps that path; any other is written to the calling actor's `images/` directory. The text gains one `[image: <path>]`
 * line per image whose path it does not already contain, so the path is visible to the model for the life of the history.
 */
export async function saveToolImages(text: string, images: readonly ImageBlock[] | undefined, cwd: string, callId: string, sessionId?: string, ownerId?: string):
  Promise<{text: string; images?: ImageBlock[]}> {
  if (!images?.length) return {text};
  const dir = sessionId ? join(ownerId ? getActorScratchpadDir(cwd, sessionId, ownerId) : getScratchpadDir(cwd, sessionId), 'images') : join(cwd, '.logox', 'images');
  const saved: ImageBlock[] = [];
  const notes: string[] = [];
  for (const [index, image] of images.entries()) {
    let path = image.path;
    if (!path) {
      try {
        await mkdir(dir, {recursive: true});
        path = join(dir, `${(callId || randomUUID()).replace(/[^\w.-]/g, '_')}-${index + 1}.${IMAGE_EXTENSIONS[image.mimeType] ?? 'img'}`);
        await writeFile(path, Buffer.from(image.data, 'base64'));
      } catch {path = undefined;}
    }
    saved.push(path ? {...image, path} : image);
    if (path && !text.includes(path)) notes.push(`[image: ${path}]`);
  }
  return {text: notes.length ? text + '\n' + notes.join('\n') : text, images: saved};
}

/**
 * Settles the results of one assistant turn at creation: images get their files, each result over the per-tool limit is offloaded,
 * and when the turn's results still total more than `TURN_TOOL_RESULTS_LIMIT` the largest remaining ones are offloaded as well.
 * The outcome is stored with the result and never recomputed, so history bytes stay fixed.
 */
export async function settleToolResults(items: readonly {callId: string; text: string; images?: readonly ImageBlock[] | undefined; tool?: string | undefined; arguments?: string | undefined}[],
  cwd: string, sessionId?: string, ownerId?: string, turnLimit = TURN_TOOL_RESULTS_LIMIT): Promise<{text: string; images?: ImageBlock[]}[]> {
  const bodies: string[] = [], notes: string[] = [], images: (ImageBlock[] | undefined)[] = [];
  const sourceOf = (item: (typeof items)[number]): OutputSource | undefined => item.tool ? {tool: item.tool, arguments: item.arguments} : undefined;
  for (const item of items) {
    const body = await maybePersistLargeOutput(item.text, cwd, item.callId, sessionId, ownerId, TOOL_OUTPUT_LIMIT, sourceOf(item));
    const withImages = await saveToolImages(body, item.images, cwd, item.callId, sessionId, ownerId);
    bodies.push(body); notes.push(withImages.text.slice(body.length)); images.push(withImages.images);
  }
  const size = (index: number) => bodies[index]!.length + notes[index]!.length;
  let total = bodies.reduce((sum, _, index) => sum + size(index), 0);
  while (total > turnLimit) {
    let largest = -1;
    for (let index = 0; index < bodies.length; index++) {
      if (bodies[index]!.includes('<persisted-output>')) continue;
      if (largest < 0 || bodies[index]!.length > bodies[largest]!.length) largest = index;
    }
    if (largest < 0) break;
    const before = size(largest);
    bodies[largest] = await maybePersistLargeOutput(bodies[largest]!, cwd, items[largest]!.callId, sessionId, ownerId, 0, sourceOf(items[largest]!));
    if (!bodies[largest]!.includes('<persisted-output>')) break;
    total += size(largest) - before;
  }
  return bodies.map((body, index) => ({text: body + notes[index]!, ...(images[index] ? {images: images[index]!} : {})}));
}

export {getScratchpadPromptSection} from '../prompts/runtime/scratchpad.js';
