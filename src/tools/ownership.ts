import {isAbsolute, relative, resolve} from 'node:path';
import type {Activity} from '../runtime/contracts.js';

/** Statuses during which an assignment still owns its files; terminal states release them. */
const ACTIVE = new Set<string>(['queued', 'running', 'waiting_input', 'paused']);

type OwnedActivity = Pick<Activity, 'activityId' | 'ownerId' | 'status' | 'title' | 'taskTitle' | 'ownedFiles'>;

function normalize(value: string, cwd: string): string {
  let text = value.trim().replaceAll('\\', '/');
  if (isAbsolute(text)) text = relative(cwd, resolve(text)).replaceAll('\\', '/');
  text = text.replace(/^(?:\.\/)+/, '');
  return process.platform === 'win32' ? text.toLowerCase() : text;
}

function globRegex(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') {i++; out += '(?:.*/)?';} else out += '.*';
      } else out += '[^/]*';
    } else if (char === '?') out += '[^/]';
    else out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + out + '$');
}

/** True when `target` (absolute or cwd-relative) falls under one of the owned paths or globs. */
export function ownsPath(patterns: readonly string[], target: string, cwd: string): boolean {
  const path = normalize(target, cwd);
  if (!path || path.startsWith('../')) return false;
  const base = path.slice(path.lastIndexOf('/') + 1);
  return patterns.some(raw => {
    const pattern = normalize(raw, cwd).replace(/\/+$/, '');
    if (!pattern) return false;
    if (!/[*?]/.test(pattern)) return path === pattern || path.startsWith(pattern + '/');
    const re = globRegex(pattern);
    return re.test(path) || (!pattern.includes('/') && re.test(base));
  });
}

/** The active assignment of ANOTHER actor that owns `target`, if any. Pure over the activity list. */
export function overreach(activities: readonly OwnedActivity[], editorOwnerId: string, target: string, cwd: string): OwnedActivity | undefined {
  return activities.find(activity => activity.ownerId !== editorOwnerId && ACTIVE.has(activity.status) &&
    activity.ownedFiles?.length && ownsPath(activity.ownedFiles, target, cwd));
}

export function overreachNote(file: string, activity: OwnedActivity, actorName: string): string {
  const title = (activity.taskTitle ?? activity.title).replace(/\s+/g, ' ').trim();
  return `Note: ${file} belongs to ${actorName}'s active assignment "${title}". Coordinate with SendMessage, or say you agreed, before further edits.`;
}
