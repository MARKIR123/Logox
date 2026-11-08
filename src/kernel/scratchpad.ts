import {join} from 'node:path';
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

/**
 * Checks if a path is inside the scratchpad directory.
 */
export function isScratchpadPath(path: string, scratchpadDir: string): boolean {
  const normalized = path.replaceAll('\\', '/').toLowerCase();
  const target = scratchpadDir.replaceAll('\\', '/').toLowerCase();
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

/**
 * Persists large tool results (> `limit`, default 32KB) to disk, matching Claude Code's <persisted-output> mechanism.
 */
export async function maybePersistLargeOutput(text: string, cwd: string, callId: string, sessionId?: string, ownerId?: string, limit = TOOL_OUTPUT_LIMIT): Promise<string> {
  if (text.length <= limit || text.includes('<persisted-output>')) return text;
  try {
    const dir = sessionId ? join(ownerId ? getActorScratchpadDir(cwd, sessionId, ownerId) : getScratchpadDir(cwd, sessionId), 'tool-results') : join(cwd, '.logox', 'tool-results');
    await mkdir(dir, {recursive: true});
    const file = join(dir, `${callId || randomUUID()}.txt`);
    await writeFile(file, text, 'utf8');
    const preview = text.slice(0, 2048);
    const sizeKb = (text.length / 1024).toFixed(1);
    return `<persisted-output>\nOutput too large (${sizeKb}KB). Full output saved to: ${file}\n\nPreview (first 2KB):\n${preview}\n...\n</persisted-output>`;
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
export async function settleToolResults(items: readonly {callId: string; text: string; images?: readonly ImageBlock[] | undefined}[],
  cwd: string, sessionId?: string, ownerId?: string, turnLimit = TURN_TOOL_RESULTS_LIMIT): Promise<{text: string; images?: ImageBlock[]}[]> {
  const bodies: string[] = [], notes: string[] = [], images: (ImageBlock[] | undefined)[] = [];
  for (const item of items) {
    const body = await maybePersistLargeOutput(item.text, cwd, item.callId, sessionId, ownerId);
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
    bodies[largest] = await maybePersistLargeOutput(bodies[largest]!, cwd, items[largest]!.callId, sessionId, ownerId, 0);
    if (!bodies[largest]!.includes('<persisted-output>')) break;
    total += size(largest) - before;
  }
  return bodies.map((body, index) => ({text: body + notes[index]!, ...(images[index] ? {images: images[index]!} : {})}));
}

export {getScratchpadPromptSection} from '../prompts/runtime/scratchpad.js';
