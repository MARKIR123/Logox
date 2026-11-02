import {isAbsolute, relative, resolve, sep} from 'node:path';
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

export function inside(root: string, path: string): boolean {
  const remainder = relative(root, path);
  return !isAbsolute(remainder) && remainder !== '..' && !remainder.startsWith('..' + sep);
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

/** The fixed directory a pattern is rooted at; a bare glob such as `*.css` matches anywhere, so its base is the workspace. */
export function patternBase(pattern: string, cwd: string): string {
  const segments = normalize(pattern, cwd).replace(/\/+$/, '').split('/');
  const wild = segments.findIndex(segment => /[*?]/.test(segment));
  return (wild < 0 ? segments : segments.slice(0, wild)).join('/');
}

/** Whether two paths or globs could name the same file. Unknown glob pairs count as overlapping: this guards writes, so a false alarm is the safe error. */
export function patternsOverlap(left: string, right: string, cwd: string): boolean {
  const a = normalize(left, cwd).replace(/\/+$/, ''), b = normalize(right, cwd).replace(/\/+$/, '');
  const wild = (pattern: string) => /[*?]/.test(pattern);
  const nested = (x: string, y: string) => !x || !y || x === y || x.startsWith(y + '/') || y.startsWith(x + '/');
  if (!wild(a) && !wild(b)) return nested(a, b);
  if (!wild(a) || !wild(b)) {
    const [path, pattern] = wild(a) ? [b, a] : [a, b];
    return ownsPath([pattern], path, cwd) || patternBase(pattern, cwd).startsWith(path + '/');
  }
  if (!nested(patternBase(a, cwd), patternBase(b, cwd))) return false;
  const suffix = (pattern: string) => pattern.slice(pattern.lastIndexOf('*') + 1);
  const [x, y] = [suffix(a), suffix(b)];
  return !x || !y || /[/?]/.test(x + y) || x.endsWith(y) || y.endsWith(x);
}

/** The active assignment of ANOTHER actor whose owned files could include `pattern`. */
export function patternHolder(activities: readonly OwnedActivity[], editorOwnerId: string, pattern: string, cwd: string): OwnedActivity | undefined {
  return activities.find(activity => activity.ownerId !== editorOwnerId && ACTIVE.has(activity.status) &&
    activity.ownedFiles?.some(owned => patternsOverlap(owned, pattern, cwd)));
}

export function overreachNote(file: string, activity: OwnedActivity, actorName: string): string {
  const title = (activity.taskTitle ?? activity.title).replace(/\s+/g, ' ').trim();
  return `Note: ${file} belongs to ${actorName}'s active assignment "${title}". Coordinate with SendMessage, or say you agreed, before further edits.`;
}
