import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {FILE_CHANGES_HEADER, FILE_CHANGE_OUTSIDE, fileChangedLine, fileDeletedLine, fileHunkHeader, fileHunkLines, fileNotShownLine, fileOwedLine, fileTooLargeLine} from '../prompts/runtime/file-changes.js';

/** A change between two versions of a file, in 0-based line indexes: `al` old lines at `a` became `bl` new lines at `b`. */
export interface Hunk {readonly a: number; readonly al: number; readonly b: number; readonly bl: number}
/** Inclusive 1-based line range of the current file. */
export interface LineRange {readonly from: number; readonly to: number}

/** Files an actor is tracked on; the least recently seen is forgotten first. */
export const VIEW_FILE_LIMIT = 32;
/** Files above this size are tracked by hash only: a change is reported without ranges or hunks. */
export const VIEW_TEXT_LIMIT = 1024 * 1024;
/** Changed lines (removed plus added) whose content one note carries; beyond it a note lists only ranges. */
export const NOTE_LINE_BUDGET = 60;
/** A line this long is never quoted in a note. */
const NOTE_LINE_WIDTH = 400;
/** Ranges one note lists for content it did not show. */
const NOTE_RANGE_LIMIT = 12;
/** Middle section size (old lines times new lines) up to which the diff is exact; above it the whole middle counts as one hunk. */
const DIFF_CELLS = 2_500_000;

export function linesOf(bytes: Uint8Array | string): string[] {
  const text = typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('utf8');
  return text.replace(/^﻿/, '').split(/\r?\n/);
}
function digest(bytes: Uint8Array): string {return createHash('sha256').update(bytes).digest('hex');}

/** Line diff: common head and tail are cut away, the rest is matched by longest common subsequence while it stays small. */
export function lineDiff(oldLines: readonly string[], newLines: readonly string[]): Hunk[] {
  let head = 0;
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) head++;
  let tail = 0;
  while (tail < oldLines.length - head && tail < newLines.length - head && oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]) tail++;
  const n = oldLines.length - head - tail, m = newLines.length - head - tail;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0 || n * m > DIFF_CELLS) return [{a: head, al: n, b: head, bl: m}];
  const width = m + 1, table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    table[i * width + j] = oldLines[head + i] === newLines[head + j] ? table[(i + 1) * width + j + 1]! + 1
      : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
  }
  const hunks: Hunk[] = [];
  let i = 0, j = 0, open: {a: number; b: number} | undefined;
  const close = () => {if (open) {hunks.push({a: head + open.a, al: i - open.a, b: head + open.b, bl: j - open.b}); open = undefined;}};
  while (i < n || j < m) {
    if (i < n && j < m && oldLines[head + i] === newLines[head + j]) {close(); i++; j++; continue;}
    open ??= {a: i, b: j};
    if (j >= m || i < n && table[(i + 1) * width + j]! >= table[i * width + j + 1]!) i++; else j++;
  }
  close();
  return hunks;
}

/** The lines of the new version a hunk touches; a pure deletion names the two lines around the gap. */
export function hunkRange(hunk: Hunk, newLength: number): LineRange {
  return hunk.bl > 0 ? {from: hunk.b + 1, to: hunk.b + hunk.bl} : {from: Math.max(1, hunk.b), to: Math.min(Math.max(1, newLength), hunk.b + 1)};
}

/** Merges overlapping or adjacent ranges. */
export function mergeRanges(ranges: readonly LineRange[]): LineRange[] {
  const sorted = [...ranges].sort((x, y) => x.from - y.from || x.to - y.to), merged: LineRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.from <= last.to + 1) merged[merged.length - 1] = {from: last.from, to: Math.max(last.to, range.to)};
    else merged.push(range);
  }
  return merged;
}

/** Where ranges of the old version lie in the new one; a range a hunk touches grows to cover what replaced it. */
export function remapRanges(ranges: readonly LineRange[], hunks: readonly Hunk[], newLength: number): LineRange[] {
  const position = (line: number): number => {
    let moved = line;
    for (const hunk of hunks) if (hunk.a + hunk.al <= line - 1) moved += hunk.bl - hunk.al;
    return moved;
  };
  return mergeRanges(ranges.map(range => {
    let from = position(range.from), to = position(range.to);
    for (const hunk of hunks) {
      const touches = hunk.al === 0 ? hunk.a >= range.from - 1 && hunk.a <= range.to : hunk.a < range.to && hunk.a + hunk.al > range.from - 1;
      if (!touches) continue;
      const covered = hunkRange(hunk, newLength);
      from = Math.min(from, covered.from); to = Math.max(to, covered.to);
    }
    return {from: Math.max(1, from), to: Math.max(1, Math.min(to, newLength))};
  }));
}

export function formatRanges(ranges: readonly LineRange[]): string {
  return ranges.map(range => range.from === range.to ? String(range.from) : range.from + '-' + range.to).join(', ');
}

interface View {
  /** Content as the actor last saw it, with the hunks of every delivered note applied; undefined above `VIEW_TEXT_LIMIT`. */
  lines: string[] | undefined;
  hash: string;
  /** Lines of `lines` that changed after the actor last saw them and whose content no note showed. */
  unseen: LineRange[];
  /** Write sequence at the time the view was taken: later writes by others are what changed since. */
  seq: number;
  /** Another actor's change that landed before this actor's own write: announced by ranges only, as its hunks were not kept. */
  owed?: {ranges: LineRange[]; by: string[]};
}
interface WriteEntry {readonly seq: number; readonly owner: string; readonly sessionId: string | undefined; readonly hash: string}

/**
 * What each actor has seen of each file: the base of the change notes (`collect`) and of the Edit guard (`unseenIn`). Kept in memory only:
 * a restored session or a folded context starts without views, which means no notes and today's Edit rules.
 */
export class FileViews {
  private readonly views = new Map<string, Map<string, View>>();
  private readonly writes = new Map<string, WriteEntry[]>();
  private seq = 0;

  private owner(ownerId: string, sessionId: string | undefined): Map<string, View> {
    const key = (sessionId ?? '') + '\0' + ownerId;
    let views = this.views.get(key);
    if (!views) {views = new Map(); this.views.set(key, views);}
    return views;
  }
  private put(views: Map<string, View>, path: string, view: View): void {
    views.delete(path); views.set(path, view);
    if (views.size > VIEW_FILE_LIMIT) views.delete(views.keys().next().value!);
  }
  private make(bytes: Uint8Array, unseen: LineRange[] = []): View {
    return {lines: bytes.length > VIEW_TEXT_LIMIT ? undefined : linesOf(bytes), hash: digest(bytes), unseen, seq: this.seq};
  }

  /** The actor read the file (`range` is the part it was shown, or all). Changes it has not been shown stay unseen outside that range. */
  read(path: string, bytes: Uint8Array, ownerId: string, sessionId: string | undefined, range?: LineRange): void {
    const views = this.owner(ownerId, sessionId), previous = views.get(path);
    let unseen: LineRange[] = [];
    if (previous && previous.hash !== digest(bytes)) {
      // Another change landed in between: whatever it touched is unseen unless this read shows it.
      const lines = linesOf(bytes);
      unseen = previous.lines ? remapRanges(previous.unseen, lineDiff(previous.lines, lines), lines.length) : [];
      if (previous.lines) unseen = mergeRanges([...unseen, ...lineDiff(previous.lines, lines).map(hunk => hunkRange(hunk, lines.length))]);
    } else if (previous) unseen = previous.unseen;
    if (range) unseen = unseen.flatMap(item => [
      ...item.from < range.from ? [{from: item.from, to: Math.min(item.to, range.from - 1)}] : [],
      ...item.to > range.to ? [{from: Math.max(item.from, range.to + 1), to: item.to}] : [],
    ]); else unseen = [];
    this.put(views, path, this.make(bytes, unseen));
  }

  /** A write made through `Snapshots.apply`. The writer's own view moves on to the result without swallowing another actor's pending change. */
  wrote(path: string, before: Uint8Array | null, after: Uint8Array, ownerId: string, sessionId: string | undefined): void {
    this.seq++;
    const log = this.writes.get(path) ?? [];
    log.push({seq: this.seq, owner: ownerId, sessionId, hash: digest(after)});
    if (log.length > 16) log.shift();
    this.writes.set(path, log);
    const views = this.owner(ownerId, sessionId), view = views.get(path), next = linesOf(after);
    if (!view || !before) {this.put(views, path, this.make(after)); return;}
    if (!view.lines || view.hash === digest(before)) {this.put(views, path, this.make(after, view.lines ? remapRanges(view.unseen, lineDiff(linesOf(before), next), next.length) : [])); return;}
    // Others changed the file after this actor's view: their ranges stay unseen and are announced (ranges only) with the next note.
    const prior = linesOf(before), pending = lineDiff(view.lines, prior), own = lineDiff(prior, next);
    const ranges = remapRanges([...remapRanges(view.unseen, pending, prior.length), ...pending.map(hunk => hunkRange(hunk, prior.length))], own, next.length);
    const by = [...new Set((this.writes.get(path) ?? []).filter(entry => entry.seq > view.seq && entry.sessionId === sessionId && entry.owner !== ownerId).map(entry => entry.owner))];
    this.put(views, path, {...this.make(after, ranges), owed: {ranges: mergeRanges([...(view.owed?.ranges ?? []), ...ranges]), by: [...new Set([...view.owed?.by ?? [], ...by])]}});
  }

  /** Forgets everything the actor saw (its context was folded or compacted: it no longer remembers any file content). */
  reset(ownerId: string, sessionId: string | undefined): void {
    this.views.delete((sessionId ?? '') + '\0' + ownerId);
  }

  /** Ranges of the current file that changed since the actor saw it and were not shown to it, or none when it has no view. */
  unseenIn(path: string, currentBytes: Uint8Array, ownerId: string, sessionId: string | undefined): LineRange[] {
    const view = this.owner(ownerId, sessionId).get(path);
    if (!view?.lines) return [];
    const lines = linesOf(currentBytes), hunks = lineDiff(view.lines, lines);
    return mergeRanges([...remapRanges(view.unseen, hunks, lines.length), ...hunks.map(hunk => hunkRange(hunk, lines.length))]);
  }

  /** The one note for everything that changed under this actor since its last request; null when nothing did. Delivering it marks the shown hunks as seen. */
  async collect(ownerId: string, sessionId: string | undefined, label: (path: string) => string = path => path): Promise<string | null> {
    const views = this.owner(ownerId, sessionId);
    if (!views.size) return null;
    let budget = NOTE_LINE_BUDGET;
    const sections: string[] = [];
    for (const [path, view] of [...views]) {
      let bytes: Buffer | null;
      try {bytes = await readFile(path);} catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') bytes = null; else continue;
      }
      if (view.owed && bytes && digest(bytes) === view.hash) {
        sections.push(fileOwedLine(label(path), view.owed.by.join(', ') || FILE_CHANGE_OUTSIDE, formatRanges(view.owed.ranges.slice(0, NOTE_RANGE_LIMIT))));
        const {owed: _owed, ...rest} = view; this.put(views, path, rest);
        continue;
      }
      if (bytes && digest(bytes) === view.hash) continue;
      const who = [...new Set((this.writes.get(path) ?? []).filter(entry => entry.seq > view.seq && (entry.sessionId === sessionId) && entry.owner !== ownerId).map(entry => entry.owner))];
      const last = this.writes.get(path)?.at(-1);
      const outside = !bytes || !last || last.hash !== digest(bytes) || last.seq <= view.seq;
      const by = [...who, ...outside ? [FILE_CHANGE_OUTSIDE] : []].join(', ');
      if (!bytes) {views.delete(path); sections.push(fileDeletedLine(label(path), by)); continue;}
      const lines = linesOf(bytes);
      if (!view.lines) {this.put(views, path, this.make(bytes)); sections.push(fileTooLargeLine(label(path), by)); continue;}
      const hunks = lineDiff(view.lines, lines), body: string[] = [], hidden: LineRange[] = [];
      for (const hunk of hunks) {
        const range = hunkRange(hunk, lines.length), cost = hunk.al + hunk.bl;
        const quoted = [...view.lines.slice(hunk.a, hunk.a + hunk.al), ...lines.slice(hunk.b, hunk.b + hunk.bl)];
        if (cost <= budget && quoted.every(line => line.length <= NOTE_LINE_WIDTH)) {
          budget -= cost;
          body.push(...fileHunkLines(fileHunkHeader(range.from, range.to, hunk.bl === 0), view.lines.slice(hunk.a, hunk.a + hunk.al), lines.slice(hunk.b, hunk.b + hunk.bl), hunk.b + 1));
        } else hidden.push(range);
      }
      const unseen = mergeRanges([...remapRanges(view.unseen, hunks, lines.length), ...hidden]);
      const listed = mergeRanges(hunks.map(hunk => hunkRange(hunk, lines.length)));
      const shownRanges = formatRanges(listed.slice(0, NOTE_RANGE_LIMIT)), hiddenMerged = mergeRanges(hidden);
      sections.push([fileChangedLine(label(path), by, lines.length, shownRanges, listed.length > NOTE_RANGE_LIMIT), ...body,
        ...hidden.length ? [fileNotShownLine(formatRanges(hiddenMerged.slice(0, NOTE_RANGE_LIMIT)), hiddenMerged.length > NOTE_RANGE_LIMIT)] : []].join('\n'));
      this.put(views, path, {lines, hash: digest(bytes), unseen, seq: this.seq});
    }
    return sections.length ? FILE_CHANGES_HEADER + '\n' + sections.join('\n\n') : null;
  }
}
