import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import type {SceneSegment} from '../tui/timeline/scene.js';
import {linkSegments, textLines, type ToolLine, type ToolView} from '../tui/timeline/tool-card.js';
import {palette} from '../tui/appearance/theme.js';
import {clipLine} from '../tui/terminal/text.js';
import {imageSize} from '../tools/ReadTool/image-size.js';
import {relativeToCwd, truncateDisplayPath} from '../tools/ui-format.js';

/**
 * Plain-language rows for browser (Playwright) actions. One action is one row: a verb phrase, the object it acted on and,
 * when the result is worth reading, a body (console messages, an evaluated value, a snapshot excerpt).
 */
export interface BrowserRow {
  readonly segments: readonly SceneSegment[];
  /** Plain text of the row (title fallback and tests). */
  readonly title: string;
  readonly view: ToolView;
}

const sensitive = /password|passwd|secret|token|api[_-]?key|credential|otp/i;
const text = (value: unknown): string => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const quote = (value: string, max = 40): string => `"${clipLine(value, max)}${value.length > max ? '…' : ''}"`;
const oneLine = (value: string, max: number): string => {const line = value.replace(/\s+/g, ' ').trim(); return line.length > max ? line.slice(0, max - 1) + '…' : line;};

/** Splits Playwright's `### Name` result sections; text before the first heading is stored under `''`. */
export function resultSections(result: string): Map<string, string> {
  const sections = new Map<string, string>();
  let name = '', lines: string[] = [];
  const close = () => {if (lines.length || name) sections.set(name, lines.join('\n').trim()); lines = [];};
  for (const line of result.split(/\r?\n/)) {
    const heading = /^###\s+(.+?)\s*$/.exec(line);
    if (heading) {close(); name = heading[1]!; continue;}
    lines.push(line);
  }
  close();
  return sections;
}
const unfence = (value: string): string => value.replace(/^```[\w-]*\r?\n/, '').replace(/\r?\n```\s*$/, '').trim();
/** The value part of a result (the `Result` section, else the text before the first heading, else everything). */
function resultValue(result: string): string {
  const sections = resultSections(result);
  return unfence(sections.get('Result') ?? (sections.get('') || (sections.size > 1 ? '' : result.trim())));
}
function page(result: string): {url?: string; title?: string} {
  const url = /Page URL:\s*(\S+)/.exec(result)?.[1], title = /Page Title:\s*(.*)/.exec(result)?.[1]?.trim();
  return {...(url ? {url} : {}), ...(title ? {title} : {})};
}

function codeRows(value: string): ToolLine[] {
  return value ? value.split(/\r?\n/).map(line => ({segments: [{text: line.replaceAll('\t', '  '), color: palette.muted}]})) : [];
}
const valueView = (value: string, empty: string): ToolView => ({body: {lines: width => value ? textLines(value, width, palette.fg) : [], empty}});

/** Console view: error lines red, the rest muted, with the error count and the first error. */
function consoleView(result: string): {view: ToolView; errors: number} {
  const rows = resultValue(result).split(/\r?\n/).map(line => line.trim()).filter(line => line && !/^Total messages:/i.test(line));
  const isError = (line: string) => /^(?:[-*]\s*)?\[(?:error|pageerror)\]/i.test(line);
  const errorRows = rows.filter(isError);
  const counted = /Errors:\s*(\d+)/i.exec(result)?.[1];
  const errors = counted !== undefined ? Number(counted) : errorRows.length;
  const lines: ToolLine[] = rows.map(row => ({prose: row, color: isError(row) ? palette.error : palette.muted}));
  const first = errorRows[0]?.replace(/^(?:[-*]\s*)?\[\w+\]\s*/, '') ?? '';
  return {errors, view: {...(errors ? {markColor: palette.error} : {}),
    ...(first ? {summary: [{text: oneLine(first, 60), color: palette.muted}]} : {}), body: {lines, empty: 'No console messages'}}};
}

/** The row for one browser action. `action` is the tool name without `browser_`; `result` is empty while the call runs. */
export function browserRow(action: string, args: Record<string, unknown>, result: string, base: string): BrowserRow {
  const verb = (word: string): SceneSegment => ({text: word, color: base});
  const object = (value: string): SceneSegment => ({text: value, color: palette.fg});
  const row = (segments: SceneSegment[], view: ToolView = {fixed: true}): BrowserRow => ({segments, title: segments.map(s => s.text).join(''), view});
  const sep: SceneSegment = {text: ' · ', color: palette.muted, separator: true};
  const element = text(args.element) || text(args.target) || text(args.ref);
  const on = element ? [verb(' '), object(quote(element))] : [];
  switch (action) {
    case 'navigate': {
      const url = text(args.url);
      return row([verb('Opened '), ...(url ? linkSegments(url) : [object('page')])]);
    }
    case 'navigate_back': return row([verb('Went back')]);
    case 'click': return row([verb(args.doubleClick === true ? 'Double-clicked' : 'Clicked'), ...on]);
    case 'hover': return row([verb('Hovered'), ...on]);
    case 'type': {
      const value = text(args.text);
      const secret = sensitive.test(text(args.element));
      return row([verb('Typed '), object(secret ? '••••••' : quote(value)), ...(element ? [verb(' into '), object(element.length > 40 ? clipLine(element, 39) + '…' : element)] : []),
        ...(args.submit === true ? [verb(' and submitted')] : [])]);
    }
    case 'fill_form': {
      const fields = Array.isArray(args.fields) ? args.fields.length : 0;
      return row([verb('Filled '), object(fields ? `${fields} ${fields === 1 ? 'field' : 'fields'}` : 'the form')]);
    }
    case 'press_key': return row([verb('Pressed '), object(text(args.key) || 'a key')]);
    case 'select_option': {
      const values = Array.isArray(args.values) ? args.values.map(text).filter(Boolean).join(', ') : '';
      return row([verb('Selected '), object(quote(values || 'an option')), ...(element ? [verb(' in '), object(element)] : [])]);
    }
    case 'drag': return row([verb('Dragged '), object(text(args.startElement) || 'an element'), verb(' to '), object(text(args.endElement) || 'another')]);
    case 'file_upload': {
      const files = Array.isArray(args.paths) ? args.paths.length : 1;
      return row([verb('Uploaded '), object(`${files} ${files === 1 ? 'file' : 'files'}`)]);
    }
    case 'handle_dialog': return row([verb(args.accept === false ? 'Dismissed dialog' : 'Accepted dialog')]);
    case 'resize': return row([verb('Resized to '), object(`${String(args.width ?? '?')} × ${String(args.height ?? '?')}`)]);
    case 'close': return row([verb('Closed browser')]);
    case 'wait_for': {
      if (typeof args.time === 'number') return row([verb('Waited '), object(`${args.time}s`)]);
      if (text(args.textGone)) return row([verb('Waited for '), object(quote(text(args.textGone))), verb(' to disappear')]);
      return row([verb('Waited for '), object(text(args.text) ? quote(text(args.text)) : 'the page')]);
    }
    case 'take_screenshot': {
      const found = /\]\(([^)]+\.(?:png|jpe?g|webp))\)/i.exec(result)?.[1] ?? /((?:[A-Za-z]:)?[^\s"'()[\]]+\.(?:png|jpe?g|webp))/i.exec(result)?.[1] ?? text(args.filename);
      const path = found ?? '';
      const full = path ? resolve(process.cwd(), path) : '';
      const size = full ? imageSize(full) : undefined;
      return row([verb('Screenshot'), ...(element ? [verb(' of '), object(quote(element))] : []), ...(size ? [verb(' '), object(`${size.width} × ${size.height}`)] : []),
        ...(path ? [verb(' → '), {text: truncateDisplayPath(existsSync(full) ? relativeToCwd(full) : path, 56), color: palette.path}] : [])]);
    }
    case 'snapshot': {
      const info = page(result);
      const tree = unfence(resultSections(result).get('Snapshot') ?? '');
      const label = info.title || info.url;
      return row([verb('Snapshot of '), ...(label ? (info.title ? [object(info.title)] : linkSegments(label)) : [object('the page')])],
        tree ? {body: {lines: codeRows(tree), empty: 'Empty snapshot'}} : {fixed: true});
    }
    case 'console_messages': {
      const {view, errors} = consoleView(result);
      return row([verb('Console'), sep,
        {text: errors ? `${errors} error${errors === 1 ? '' : 's'}` : result ? 'no errors' : '…', color: errors ? palette.error : base}], view);
    }
    case 'evaluate': {
      const code = oneLine(text(args.function) || text(args.expression), 48);
      return row([verb('Evaluated '), object(code || 'script')], valueView(resultValue(result), 'No result'));
    }
    case 'run_code_unsafe': return row([verb('Ran script')], valueView(resultValue(result), 'No result'));
    case 'tabs': return row([verb('Tabs'), ...(text(args.action) ? [sep, verb(text(args.action))] : [])], valueView(resultValue(result), 'No tabs'));
    case 'list': return row([verb('Listed browser tools')]);
    default: {
      const label = action.replace(/_/g, ' ');
      return row([verb(label.charAt(0).toUpperCase() + label.slice(1)), ...on], valueView(resultValue(result), 'No output'));
    }
  }
}
