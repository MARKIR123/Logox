import {existsSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {structuredPatch} from 'diff';
import type {ToolCall} from '../../runtime/messages.js';
import type {Message} from '../../runtime/contracts.js';
import type {ToolFrame, ToolRenderContext, ToolUI} from '../../tools/ui-types.js';
import {formatToolTitle, formatToolCardTitle, formatToolCardBody} from '../../tools/ui-format.js';
import {palette} from '../appearance/theme.js';
import {faintColor} from '../appearance/colors.js';
import {cast} from '../../actors/ensemble.js';
import type {createBuilder, SceneSegment} from './scene.js';

export function messageToolCall(message: Message): ToolCall | undefined {
  if (message.step?.call) return message.step.call;
  if (message.kind !== 'tool') return undefined;
  const [name = '', ...body] = message.text.split('\n');
  return {id: message.step?.callId ?? message.id, name: name.trim(), arguments: body.join('\n')};
}

export function renderEditDiff(
  builder: ReturnType<typeof createBuilder>,
  messageId: string,
  railColor: string,
  call: ToolCall,
  frame?: ToolFrame,
  maxLines = 25
): void {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.arguments);
  } catch {}

  const rawPath = String(args.file_path ?? args.path ?? '');
  const oldStr = typeof args.old_string === 'string' ? args.old_string : typeof args.old_text === 'string' ? args.old_text : '';
  const newStr = typeof args.new_string === 'string' ? args.new_string : typeof args.new_text === 'string' ? args.new_text : '';

  const f = frame ?? {leftSegments: [], rightSegments: [], leftCols: 0, rightCols: 0, innerWidth: builder.contentWidth};

  // Attempt to locate real line numbers and surrounding context in the file on disk
  let patch = structuredPatch(rawPath || 'file', rawPath || 'file', oldStr, newStr, '', '', {context: 3});
  let lineOffset = 0;

  const resolvedPath = rawPath ? (existsSync(rawPath) ? rawPath : existsSync(resolve(process.cwd(), rawPath)) ? resolve(process.cwd(), rawPath) : undefined) : undefined;
  if (resolvedPath) {
    try {
      const fileContent = readFileSync(resolvedPath, 'utf8');
      const normFile = fileContent.replace(/\r\n/g, '\n');
      const normNew = newStr.replace(/\r\n/g, '\n');
      const normOld = oldStr.replace(/\r\n/g, '\n');

      let idx = normNew ? normFile.indexOf(normNew) : -1;
      if (idx < 0 && normOld) idx = normFile.indexOf(normOld);

      if (idx >= 0) {
        const beforeText = normFile.slice(0, idx);
        const matchLen = normNew && idx === normFile.indexOf(normNew) ? normNew.length : normOld.length;
        const afterText = normFile.slice(idx + matchLen);

        const beforeLines = beforeText.split('\n');
        // Extract up to 3 context lines before the edit
        const contextBeforeLines = beforeLines.slice(Math.max(0, beforeLines.length - 1 - 3), beforeLines.length - 1);
        const contextBefore = contextBeforeLines.length ? contextBeforeLines.join('\n') + '\n' : '';

        const afterLines = afterText.split('\n');
        // Extract up to 3 context lines after the edit
        const contextAfterLines = afterLines.slice(1, Math.min(afterLines.length, 1 + 3));
        const contextAfter = contextAfterLines.length ? '\n' + contextAfterLines.join('\n') : '';

        const oldWithContext = contextBefore + normOld + contextAfter;
        const newWithContext = contextBefore + normNew + contextAfter;
        lineOffset = Math.max(1, beforeLines.length - contextBeforeLines.length);

        const contextPatch = structuredPatch(rawPath || 'file', rawPath || 'file', oldWithContext, newWithContext, '', '', {context: 3});
        if (contextPatch && contextPatch.hunks.length > 0) {
          patch = contextPatch;
        }
      }
    } catch {}
  }

  const hunks = patch.hunks;
  if (hunks.length === 0) {
    builder.pushFramedLine(messageId + '-diff-none', railColor, [
      {text: 'No changes detected', color: palette.muted, italic: true},
    ], f);
    return;
  }

  let lineCount = 0;
  let hunkIndex = 0;

  for (const hunk of hunks) {
    if (hunkIndex > 0) {
      builder.pushFramedLine(`${messageId}-diff-sep-${hunkIndex}`, railColor, [
        {text: '···', color: palette.muted},
      ], f);
    }
    hunkIndex++;

    let oldLine = (lineOffset > 0 ? lineOffset : hunk.oldStart);
    let newLine = (lineOffset > 0 ? lineOffset : hunk.newStart);

    for (const rawLine of hunk.lines) {
      if (rawLine.startsWith('\\')) continue;
      lineCount++;
      if (lineCount > maxLines) {
        builder.pushFramedLine(`${messageId}-diff-omitted`, railColor, [
          {text: '... (more diff lines omitted)', color: palette.muted, italic: true},
        ], f);
        return;
      }

      const sigil = rawLine[0]!;
      const content = rawLine.slice(1);
      const rowId = `${messageId}-diff-${lineCount}`;

      if (sigil === '-') {
        const lineNumStr = String(oldLine++).padStart(4) + ' ';
        builder.pushFramedLine(rowId, railColor, [
          {text: lineNumStr, color: faintColor()},
          {text: '− ', color: palette.diffRemovedGutter, bold: true},
          {text: content, color: palette.diffRemoved},
        ], f, undefined, palette.diffRemovedBg);
      } else if (sigil === '+') {
        const lineNumStr = String(newLine++).padStart(4) + ' ';
        builder.pushFramedLine(rowId, railColor, [
          {text: lineNumStr, color: faintColor()},
          {text: '+ ', color: palette.diffAddedGutter, bold: true},
          {text: content, color: palette.diffAdded},
        ], f, undefined, palette.diffAddedBg);
      } else {
        oldLine++;
        const lineNumStr = String(newLine++).padStart(4) + '   ';
        builder.pushFramedLine(rowId, railColor, [
          {text: lineNumStr, color: faintColor()},
          {text: content, color: palette.muted},
        ], f);
      }
    }
  }
}

const SHELL_BODY_LINES = 12;
/** Shell body: `$ command`, then the output muted with error lines in the error color; long output shows its head and a faint remainder. */
function renderShellBody(builder: ReturnType<typeof createBuilder>, id: string, accent: string, command: string, output: readonly string[], frame: ToolFrame): void {
  const faint = faintColor();
  command.split(/\r?\n/).filter(line => line.trim()).slice(0, 3).forEach((line, index) =>
    builder.pushFramedLine(`${id}-cmd-${index}`, accent, [{text: index === 0 ? '$ ' : '  ', color: faint}, {text: line, color: palette.fg}], frame));
  const shown = output.slice(0, SHELL_BODY_LINES);
  const failureLine = /(error|failed|failure|exception|fatal|denied)|^\s*[✗×]/i;
  for (const [index, line] of shown.entries()) {
    const color = failureLine.test(line) ? palette.error : palette.muted;
    builder.pushProse(`${id}-out-${index}`, line, accent, 'body', frame, undefined, color);
  }
  if (output.length > shown.length) builder.pushFramedLine(`${id}-more`, accent, [{text: `… ${output.length - shown.length} more lines`, color: faint}], frame);
}

export function renderDefaultTool(context: ToolRenderContext): void {
  const {builder, message, frame, open, accent} = context;
  const call = context.call ?? messageToolCall(message);
  const [, ...bodyLines] = message.text.split('\n');
  const bodyText = bodyLines.join('\n');
  const isCompleted = message.step?.state === 'completed';
  const hasStructuredCall = Boolean(message.step?.call);

  const title = hasStructuredCall && message.step?.call
    ? formatToolCardTitle(message.step.call, bodyText, isCompleted, message.step?.title)
    : message.step?.title ?? (call ? formatToolCardTitle(call, bodyText, isCompleted) : 'Tool');

  const formattedBody = hasStructuredCall && message.step?.call
    ? formatToolCardBody(message.step.call, message.text)
    : [message.text];

  const shell = hasStructuredCall && message.step?.call && ['shell', 'bash'].includes(message.step.call.name.toLowerCase()) ? message.step.call : undefined;
  let command = '';
  try {const parsed: unknown = JSON.parse(shell?.arguments ?? '{}'); if (parsed && typeof parsed === 'object') command = String(Reflect.get(parsed, 'command') ?? '');} catch {}
  const output = bodyLines.join('\n').replace(/\s+$/, '').split('\n');
  builder.pushOrdinaryCard({
    id: message.id,
    ownerId: message.ownerId,
    kind: 'Tool',
    title,
    bodyLines: shell ? [] : formattedBody,
    ...(shell ? {renderBody: (inner: ToolFrame) => renderShellBody(builder, message.id, accent, command, bodyText.trim() ? output : [], inner)} : {}),
    ...(message.step ? {step: message.step} : {}),
    open,
    railColor: accent,
    ...(frame ? {parentFrame: frame} : {}),
  });
}

function contextTitle(context: ToolRenderContext, call: ToolCall): string {
  return context.message.step?.title ?? call.name;
}

export function createToolUI(keys: readonly string[] = []): ToolUI {
  const title = (call: ToolCall) => formatToolTitle(call, keys);
  return {
    visibility: 'visible',
    title,
    render(context) {
      const call = context.call ?? messageToolCall(context.message);
      const message = call && context.message.step?.call
        ? {...context.message, step: {...context.message.step, title: title(call)}}
        : context.message;
      renderDefaultTool({...context, message});
    },
  };
}
