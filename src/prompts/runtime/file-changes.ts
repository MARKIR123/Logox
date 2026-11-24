/** Opens the model-only note that reports files an actor had seen and someone else changed (`src/tools/file-views.ts:FileViews.collect`). */
export const FILE_CHANGES_HEADER = 'Files you had read or written changed since you last saw them. Hunks shown here count as seen; for lines that are not shown, Read just those lines before editing them. Line numbers are those of the current file.';

/** Start of the Read result that repeats a read whose identical result is still earlier in the conversation (`src/kernel/read-reuse.ts`). */
export const READ_UNCHANGED_STUB = 'Unchanged since your last read of this range; the content is earlier in this conversation (tool call ';
/** The whole stub; `digest` fingerprints the earlier result so a request can tell whether it is still there word for word. */
export function readUnchangedStub(callId: string, digest: string): string {return READ_UNCHANGED_STUB + callId + ', result ' + digest + ').';}
/** Request-only replacement for a stub whose earlier result is gone and whose file could not be read again. */
export const READ_STUB_UNAVAILABLE = 'The earlier result of this read is no longer in the conversation; Read the range again.';

function listing(ranges: string, more: boolean): string {return ranges + (more ? ', and more' : '');}

/** The first line of one file's section. `by` is empty when the writer is unknown. */
export function fileChangedLine(label: string, by: string, lineCount: number, changed: string, moreChanged: boolean): string {
  return label + ' changed' + (by ? ' by ' + by : '') + ' (' + lineCount + ' lines now; changed ' + listing(changed, moreChanged) + ').';
}
export function fileDeletedLine(label: string, by: string): string {return label + ' was deleted' + (by ? ' by ' + by : '') + '.';}
export function fileTooLargeLine(label: string, by: string): string {
  return label + ' changed' + (by ? ' by ' + by : '') + ' (too large to diff); Read the parts you need again.';
}
export function fileNotShownLine(ranges: string, more: boolean): string {return 'Not shown here; Read these lines before editing them: ' + listing(ranges, more) + '.';}
export function fileOwedLine(label: string, by: string, ranges: string): string {
  return label + ' was changed by ' + by + ' before your last edit of it, at lines ' + ranges + '; Read those lines before editing them.';
}
export const FILE_CHANGE_OUTSIDE = 'something outside the actors';

/** One changed region: the removed lines, then the added lines with their current line numbers. */
export function fileHunkLines(header: string, removed: readonly string[], added: readonly string[], firstAdded: number): string[] {
  return [header, ...removed.map(line => '- ' + line), ...added.map((line, index) => '+ ' + (firstAdded + index) + ': ' + line)];
}
export function fileHunkHeader(from: number, to: number, deleted: boolean): string {
  return deleted ? '@@ removed after line ' + (from === to ? from : from) + ' @@' : '@@ lines ' + (from === to ? from : from + '-' + to) + ' @@';
}

/** Edit refused: the match lies in lines that changed after the actor saw them and were not shown to it. */
export function editUnseenError(file: string, ranges: string): string {
  return 'Not edited: lines ' + ranges + ' of ' + file + ' changed since you last saw them and were not shown to you. Read just those lines, then repeat the edit.';
}
/** The tail of a no-match Edit error when the lines that changed are known. */
export function editNoMatchRanges(ranges: string): string {return ' (changed lines: ' + ranges + ')';}
