import {structuredPatch} from 'diff';
import type {ToolCall} from '../runtime/messages.js';

export function formatToolTitle(call: ToolCall, keys: readonly string[]): string {
  try {
    const args: unknown = JSON.parse(call.arguments);
    if (!args || typeof args !== 'object') return call.name;
    const description = Reflect.get(args, 'description') ?? Reflect.get(args, 'summary');
    const intent = typeof description === 'string' ? description.trim() : '';
    for (const key of keys) {
      const value: unknown = Reflect.get(args, key);
      if (typeof value !== 'string') continue;
      const detail = value.replace(/\s+/g, ' ').slice(0, 90);
      return intent ? `${call.name} · ${intent} (${detail})` : `${call.name} ${detail}`;
    }
    return intent ? `${call.name} · ${intent}` : call.name;
  } catch {return call.name;}
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const IMAGE_EXT_REGEX = /\.(png|jpe?g|gif|webp)$/i;

export function isImageFile(path: string, text?: string): boolean {
  if (IMAGE_EXT_REGEX.test(path)) return true;
  if (text && (text.startsWith('[Image file:') || text.includes('format: image/'))) return true;
  return false;
}

export function parseImageMetadata(text: string, path: string): {sizeStr: string; formatStr: string} | undefined {
  const sizeMatch = /size:\s*(\d+)\s*bytes/i.exec(text);
  const formatMatch = /format:\s*image\/(\w+)/i.exec(text);
  const ext = path.slice(path.lastIndexOf('.') + 1).toUpperCase();
  if (sizeMatch) {
    const bytes = Number(sizeMatch[1]);
    const sizeStr = formatByteSize(bytes);
    const formatStr = formatMatch ? formatMatch[1]!.toUpperCase() : ext || 'IMAGE';
    return {sizeStr, formatStr};
  }
  if (IMAGE_EXT_REGEX.test(path)) {
    return {sizeStr: 'Image', formatStr: ext || 'IMAGE'};
  }
  return undefined;
}

export function truncateDisplayPath(fullPath: string, maxLength = 45): string {
  if (!fullPath || fullPath.length <= maxLength) return fullPath;
  const isBackslash = fullPath.includes('\\');
  const sep = isBackslash ? '\\' : '/';
  const parts = fullPath.split(/[\\\/]/).filter(Boolean);
  if (parts.length === 0) return fullPath;
  if (parts.length === 1) return '...' + fullPath.slice(-(maxLength - 3));

  const filename = parts[parts.length - 1]!;
  let accumulated = filename;

  for (let i = parts.length - 2; i >= 0; i--) {
    let seg = parts[i]!;
    if (seg.length > 14) {
      seg = seg.slice(0, 8) + '..';
    }
    const next = seg + sep + accumulated;
    if (next.length + 4 <= maxLength) {
      accumulated = next;
    } else {
      break;
    }
  }

  return '...' + sep + accumulated;
}

export function truncateCommand(cmd: string, maxLen = 60): string {
  if (!cmd) return '';
  const commentMatch = /^#\s*([^\r\n]+)/.exec(cmd);
  if (commentMatch) {
    const label = commentMatch[1]!.trim();
    return label.length > maxLen ? label.slice(0, maxLen - 1) + '…' : label;
  }
  const firstLine = cmd.split(/\r?\n/)[0]?.trim().replace(/\s+/g, ' ') ?? '';
  return firstLine.length > maxLen ? firstLine.slice(0, maxLen - 1) + '…' : firstLine;
}

/** Formats rich coordinates and outcome in tool card title (modeled after Claude Code). */
export function formatToolCardTitle(call: ToolCall, resultText?: string, isCompleted?: boolean, fallbackTitle?: string): string {
  let args: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(call.arguments);
    if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>;
  } catch {}

  const name = call.name.toLowerCase();
  const cleanResult = resultText && resultText.startsWith(call.name + '\n')
    ? resultText.slice(call.name.length + 1).trim()
    : (resultText?.trim() ?? '');

  if (name === 'read') {
    let rawPath = String(args.file_path ?? args.path ?? '');
    if (!rawPath && fallbackTitle) {
      const match = /^Read\s+(.+)$/i.exec(fallbackTitle.trim());
      if (match) rawPath = match[1]!;
    }
    const displayPath = truncateDisplayPath(rawPath);
    const desc = typeof args.description === 'string' && args.description.trim() ? args.description.trim() : '';
    const offset = typeof args.offset === 'number' ? args.offset : undefined;
    const limit = typeof args.limit === 'number' ? args.limit : undefined;

    if (isImageFile(rawPath, cleanResult)) {
      const meta = cleanResult ? parseImageMetadata(cleanResult, rawPath) : undefined;
      const sizePart = meta && meta.sizeStr !== 'Image' ? ` · ${meta.sizeStr} ${meta.formatStr}` : ` · ${rawPath.slice(rawPath.lastIndexOf('.') + 1).toUpperCase() || 'PNG'}`;
      if (desc) return `Read · ${desc} (${displayPath})${sizePart}`;
      return `Read(${displayPath})${sizePart}`;
    }

    if (offset !== undefined) {
      const end = limit !== undefined ? offset + limit - 1 : offset;
      if (desc) return `Read · ${desc} (${displayPath}, lines ${offset}-${end})`;
      return `Read(${displayPath}, lines ${offset}-${end})`;
    }

    let linePart = '';
    if (isCompleted && cleanResult) {
      const lineRows = cleanResult.split('\n').filter(l => /^\d+:/.test(l));
      const count = lineRows.length > 0 ? lineRows.length : cleanResult.split('\n').filter(Boolean).length;
      if (count > 0) {
        linePart = ` · ${count} line${count === 1 ? '' : 's'}`;
      }
    }

    if (desc) return `Read · ${desc} (${displayPath})${linePart}`;
    return rawPath ? `Read(${displayPath})${linePart}` : call.name;
  }

  if (name === 'edit') {
    let rawPath = String(args.file_path ?? args.path ?? '');
    if (!rawPath && fallbackTitle) {
      const match = /^Edit\s+(.+)$/i.exec(fallbackTitle.trim());
      if (match) rawPath = match[1]!;
    }
    const displayPath = truncateDisplayPath(rawPath);
    const desc = typeof args.description === 'string' && args.description.trim() ? args.description.trim() : '';
    const oldStr = typeof args.old_string === 'string' ? args.old_string : typeof args.old_text === 'string' ? args.old_text : '';
    const newStr = typeof args.new_string === 'string' ? args.new_string : typeof args.new_text === 'string' ? args.new_text : '';

    const oldCount = isCompleted && oldStr ? oldStr.split('\n').length : 0;
    const newCount = isCompleted && newStr ? newStr.split('\n').length : 0;

    let diffPart = '';
    if (oldCount > 0 && newCount > 0) {
      diffPart = ` · Added ${newCount} line${newCount === 1 ? '' : 's'}, removed ${oldCount} line${oldCount === 1 ? '' : 's'}`;
    } else if (newCount > 0) {
      diffPart = ` · Added ${newCount} line${newCount === 1 ? '' : 's'}`;
    } else if (oldCount > 0) {
      diffPart = ` · Removed ${oldCount} line${oldCount === 1 ? '' : 's'}`;
    }

    if (desc) {
      return `Edit · ${desc} (${displayPath})${diffPart}`;
    }
    return rawPath ? `Edit(${displayPath})${diffPart}` : `Edit${diffPart}`;
  }

  if (name === 'write') {
    let rawPath = String(args.file_path ?? args.path ?? '');
    if (!rawPath && fallbackTitle) {
      const match = /^Write\s+(.+)$/i.exec(fallbackTitle.trim());
      if (match) rawPath = match[1]!;
    }
    const displayPath = truncateDisplayPath(rawPath);
    const desc = typeof args.description === 'string' && args.description.trim() ? args.description.trim() : '';
    const content = typeof args.content === 'string' ? args.content : '';
    const count = content ? content.split('\n').length : 0;
    const linePart = count > 0 ? ` · ${count} line${count === 1 ? '' : 's'}` : '';

    if (desc) {
      return `Write · ${desc} (${displayPath})${linePart}`;
    }
    return rawPath ? `Write(${displayPath})${linePart}` : call.name;
  }

  if (name === 'grep') {
    const pattern = String(args.pattern ?? '');
    const rawPath = args.path ? truncateDisplayPath(String(args.path)) : '';
    const desc = typeof args.description === 'string' && args.description.trim() ? args.description.trim() : '';
    const target = rawPath ? `"${pattern}" in ${rawPath}` : `"${pattern}"`;
    let matchPart = '';
    if (isCompleted && cleanResult) {
      const count = cleanResult.split('\n').filter(l => Boolean(l.trim()) && !l.startsWith('(') && !l.startsWith('No matches')).length;
      matchPart = ` · ${count === 1 ? '1 match' : `${count} matches`}`;
    }
    if (desc) {
      return `Grep · ${desc} (${target})${matchPart}`;
    }
    return `Grep(${target})${matchPart}`;
  }

  if (name === 'glob') {
    const pattern = String(args.pattern ?? '');
    const rawPath = args.path ? truncateDisplayPath(String(args.path)) : '';
    const desc = typeof args.description === 'string' && args.description.trim() ? args.description.trim() : '';
    const target = rawPath ? `${pattern} in ${rawPath}` : pattern;
    let filePart = '';
    if (isCompleted && cleanResult) {
      const count = cleanResult.split('\n').filter(Boolean).filter(l => !l.startsWith('0 files') && !l.startsWith('No ')).length;
      filePart = ` · ${count === 1 ? '1 file' : `${count} files`}`;
    }
    if (desc) {
      return `Glob · ${desc} (${target})${filePart}`;
    }
    return `Glob(${target})${filePart}`;
  }

  if (name === 'shell' || name === 'bash') {
    const cmd = truncateCommand(String(args.command ?? ''));
    const desc = typeof args.description === 'string' && args.description.trim() ? args.description.trim() : '';
    let exitPart = '';
    if (isCompleted && cleanResult) {
      const exitMatch = /Exit code:\s*(\d+)/i.exec(cleanResult);
      if (exitMatch) {
        const code = exitMatch[1]!;
        if (code !== '0') {
          exitPart = ` · Exit ${code}`;
        }
      }
    }
    if (desc) {
      return `Shell · ${desc} (${cmd})${exitPart}`;
    }
    return cmd ? `Shell(${cmd})${exitPart}` : 'Shell';
  }

  if (name === 'sendmessage') {
    const target = String(args.to ?? '').toLowerCase();
    const desc = typeof args.description === 'string' && args.description.trim()
      ? args.description.trim()
      : typeof args.summary === 'string' && args.summary.trim()
        ? args.summary.trim()
        : '';
    const mode = args.mode === 'interrupt' || cleanResult.includes('interrupt') ? 'interrupt' : 'queued';
    const descStr = desc ? ` · ${desc}` : '';
    return `SendMessage to ${target}${descStr} · ${mode}`;
  }

  return fallbackTitle ?? legacyToolTitle(call);
}

/** Formats card body for opened tools: limits long reads to 20 lines, presents image metadata and git diffs. */
export function formatToolCardBody(call: ToolCall, rawText: string, maxLines = 20): string[] {
  if (!rawText) return [];
  const lines = rawText.split(/\r?\n/);
  const bodyLines = lines.length > 1 && lines[0] === call.name ? lines.slice(1) : lines;
  const cleanBody = bodyLines.join('\n').trim();
  if (!cleanBody) return [];

  let args: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(call.arguments);
    if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>;
  } catch {}

  const name = call.name.toLowerCase();
  const rawPath = String(args.file_path ?? args.path ?? '');

  if (name === 'read') {
    if (isImageFile(rawPath, cleanBody)) {
      const meta = parseImageMetadata(cleanBody, rawPath);
      return [
        `[Image file: ${rawPath}]`,
        `Format: ${meta?.formatStr ?? 'Image'} · Size: ${meta?.sizeStr ?? 'Unknown'}`,
        'Multimodal: Attached to conversation context for visual inspection',
      ];
    }
    const contentLines = bodyLines.filter((_, idx) => idx > 0 || bodyLines[0] !== '');
    if (contentLines.length > maxLines) {
      return [
        ...contentLines.slice(0, maxLines),
        `... (${contentLines.length - maxLines} more lines omitted)`,
      ];
    }
    return contentLines;
  }

  if (name === 'edit') {
    const oldStr = typeof args.old_string === 'string' ? args.old_string : typeof args.old_text === 'string' ? args.old_text : '';
    const newStr = typeof args.new_string === 'string' ? args.new_string : typeof args.new_text === 'string' ? args.new_text : '';
    const patch = structuredPatch(rawPath || 'file', rawPath || 'file', oldStr, newStr, '', '', {context: 2});
    const diffLines: string[] = [];
    for (const hunk of patch.hunks) {
      for (const rawLine of hunk.lines) {
        if (rawLine.startsWith('\\')) continue;
        diffLines.push(rawLine);
      }
    }
    if (diffLines.length > maxLines) {
      return [
        ...diffLines.slice(0, maxLines),
        `... (${diffLines.length - maxLines} more diff lines omitted)`,
      ];
    }
    return diffLines.length > 0 ? diffLines : [cleanBody];
  }

  if (bodyLines.length > maxLines) {
    return [
      ...bodyLines.slice(0, maxLines),
      `... (${bodyLines.length - maxLines} more lines omitted)`,
    ];
  }
  return bodyLines;
}

/** Formats a concise, single-line outcome summary for a completed tool (modeled after Claude Code). */
export function formatToolSummary(toolName: string, rawText: string): string | undefined {
  if (!rawText) return undefined;
  const lines = rawText.split(/\r?\n/);
  const body = lines[0] === toolName ? lines.slice(1).join('\n').trim() : rawText.trim();
  if (!body) return undefined;

  const lower = toolName.toLowerCase();
  if (body.startsWith('Error:') || body.includes('failed') || body.includes('Exception') || body.startsWith('Operation denied') || body.startsWith('Tool cancelled')) {
    const firstLine = body.split('\n')[0]?.trim().slice(0, 80);
    return firstLine;
  }

  if (lower === 'read') {
    if (body.startsWith('[Image file:')) {
      const match = /size:\s*(\d+)\s*bytes,\s*format:\s*image\/(\w+)/i.exec(body);
      if (match) return `Image (${(Number(match[1]) / 1024).toFixed(1)} KB ${match[2]!.toUpperCase()})`;
      return 'Image preview';
    }
    const count = body.split('\n').filter(line => /^\d+:/.test(line)).length;
    return count > 0 ? `Read ${count} lines` : undefined;
  }

  if (lower === 'write') {
    return 'Wrote file successfully';
  }

  if (lower === 'edit') {
    return 'Applied 1 replacement';
  }

  if (lower === 'glob') {
    if (body === 'No files found' || body === 'No matching files found' || body.startsWith('0 files')) return 'Found 0 files';
    const count = body.split('\n').filter(Boolean).length;
    return `Found ${count} file${count === 1 ? '' : 's'}`;
  }

  if (lower === 'grep') {
    if (body === 'No matches found.' || body.includes('0 matches')) return 'Found 0 matches';
    const count = body.split('\n').filter(l => Boolean(l.trim()) && !l.startsWith('(')).length;
    return `Found ${count} match${count === 1 ? '' : 'es'}`;
  }

  if (lower === 'shell') {
    const exitMatch = /Exit code:\s*(\d+)/i.exec(body);
    if (exitMatch) {
      const code = Number(exitMatch[1]);
      return code === 0 ? 'Exit code: 0' : `Exit code: ${code}`;
    }
    return undefined;
  }

  if (lower === 'webfetch') {
    const count = body.split('\n').length;
    return `Fetched ${count} lines`;
  }

  if (lower === 'sendmessage') {
    return body.slice(0, 60);
  }

  return undefined;
}

/** Compatibility for callers without a tool-specific UI adapter. */
export const legacyToolTitle = (call: ToolCall): string => formatToolTitle(call, ['file_path', 'path', 'command', 'tool', 'to', 'actor', 'ownerId', 'name', 'url']);
