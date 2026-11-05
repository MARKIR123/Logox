import {join} from 'node:path';
import stringWidth from 'string-width';
import {z} from 'zod';
import {StateFile} from './model-preferences.js';

/** Maximum width of the preferred name in terminal display cells. */
export const USER_NAME_MAX_CELLS = 32;
/** Label used for the human when no preferred name is stored. */
export const DEFAULT_USER_LABEL = 'You';

const segmenter = new Intl.Segmenter(undefined, {granularity: 'grapheme'});

/** Strips control characters, collapses whitespace, trims and caps the width; empty result means "no name". */
export function sanitizeUserName(raw: string): string {
  const clean = raw.replace(/[\u0000-\u001f\u007f-\u009f ​-‏‪-‮⁦-⁩﻿]/g, ' ').replace(/\s+/g, ' ').trim();
  let result = '', width = 0;
  for (const {segment} of segmenter.segment(clean)) {
    const cells = stringWidth(segment);
    if (width + cells > USER_NAME_MAX_CELLS) break;
    result += segment; width += cells;
  }
  return result.trim();
}

export const userProfileSchema = z.strictObject({version: z.literal(1), name: z.string().max(256).optional()});
export type UserProfile = z.infer<typeof userProfileSchema>;

export function userProfileFile(homeDir: string): StateFile<UserProfile> {
  return new StateFile(join(homeDir, '.logox', 'user-profile.json'), userProfileSchema);
}

/** Reads the stored preferred name; a missing, unreadable or invalid file means no name. */
export async function loadUserName(homeDir: string): Promise<string | undefined> {
  try {
    const stored = (await userProfileFile(homeDir).read())?.name;
    return stored ? sanitizeUserName(stored) || undefined : undefined;
  } catch {return undefined;}
}

/** Persists the sanitised name atomically; an empty or undefined name clears it. Returns the stored name. */
export async function saveUserName(homeDir: string, raw: string | undefined): Promise<string | undefined> {
  const name = raw === undefined ? '' : sanitizeUserName(raw);
  await userProfileFile(homeDir).update(() => ({version: 1, ...(name ? {name} : {})}));
  return name || undefined;
}

let displayName: string | undefined;
let revision = 0;
/** Live label the timeline uses for the human speaker; renderers read it, the application owns it. */
export function userLabel(): string {return displayName ?? DEFAULT_USER_LABEL;}
export function userLabelRevision(): number {return revision;}
export function setUserLabel(name: string | undefined): void {
  if (displayName === name) return;
  displayName = name; revision++;
}
