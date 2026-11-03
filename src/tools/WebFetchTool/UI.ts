import type {SceneSegment} from '../../tui/timeline/scene.js';
import type {ToolUI} from '../ui-types.js';
import {createToolUI, messageToolCall} from '../../tui/timeline/tool-ui.js';
import {renderToolCard, type ToolLine, type ToolView} from '../../tui/timeline/tool-card.js';
import {markdownLines} from '../../tui/timeline/tool-code.js';
import {faintColor} from '../../tui/appearance/colors.js';
import {palette} from '../../tui/appearance/theme.js';
import {callArgs, formatByteSize} from '../ui-format.js';

const EXCERPT_CHARS = 6000;

function parseUrl(value: string): URL | undefined {
  try {return new URL(value);} catch {return undefined;}
}

/** The full URL in the link color, underlined, with the domain bold. */
export function urlSegments(value: string): SceneSegment[] {
  const url = parseUrl(value);
  const host = url?.host ?? '';
  const at = host ? value.indexOf(host) : -1;
  const link = {color: palette.link, underline: true} as const;
  if (at < 0) return [{text: value, ...link}];
  return [{text: value.slice(0, at), ...link}, {text: host, ...link, bold: true}, ...(value.length > at + host.length ? [{text: value.slice(at + host.length), ...link}] : [])];
}

/** Anything that still looks like markup is reduced to its text: the card never shows raw HTML. */
function plainText(text: string): string {
  if (!/<\/?(?:html|head|body|div|span|p|a|script|style|table|ul|li|h[1-6])\b|<!doctype/i.test(text)) return text;
  return text.replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n');
}

/** WebFetch card view: URL, `page title · status · size`, then a rendered excerpt of the page. */
export function webFetchView(url: string, result: string): ToolView {
  const persisted = /Output too large \(([\d.]+)\s*KB\)/.exec(result);
  const preview = persisted ? result.slice(result.indexOf('Preview (first 2KB):') + 'Preview (first 2KB):'.length) : result;
  const header = /^\s*\[Fetched from: ([^\s|\]]+)((?:\s*\|[^\]]*)?)\]\s*/.exec(preview);
  const meta = header?.[2] ?? '';
  const status = /\|\s*HTTP (\d{3})/.exec(meta)?.[1];
  const headerTitle = /\|\s*Title:\s*(.*?)(?=\s*\|\s*Context goal:|$)/.exec(meta)?.[1]?.trim();
  const text = (header ? preview.slice(header[0].length) : preview).replace(/\.\.\.\s*<\/persisted-output>\s*$/, '').trim();
  const emptyPage = /^\[Fetched .*Document body is empty\]$/.test(text) || !text;
  const body = emptyPage ? '' : plainText(text).trim();
  const heading = /^#{1,3}\s+(.+)$/m.exec(body)?.[1]?.trim();
  const title = headerTitle || heading || '';
  const size = persisted ? formatByteSize(Math.round(Number(persisted[1]) * 1024)) : body ? formatByteSize(Buffer.byteLength(body)) : '';
  const faint = faintColor();
  const facts = [status, size].filter(Boolean).join(' · ');
  const head: ToolLine[] = [
    {segments: urlSegments(header?.[1] ?? url)},
    ...(title || facts ? [{segments: [
      ...(title ? [{text: title, color: palette.fg, bold: true}] : []),
      ...(facts ? [{text: (title ? ' · ' : '') + facts, color: faint}] : [])]}] : []),
  ];
  // The page title is already in the head; its repeated first heading would only waste a row.
  const first = body.split('\n', 1)[0] ?? '';
  const excerpt = (heading && title === heading && /^#{1,3}\s/.test(first) ? body.slice(first.length) : body).trim().slice(0, EXCERPT_CHARS);
  return {body: {head, lines: excerpt ? width => markdownLines(excerpt, width) : [], empty: 'Empty page'}};
}

const domainOf = (url: string) => parseUrl(url)?.host ?? url;

export const UI: ToolUI = {
  ...createToolUI(['url']),
  render(context) {
    const call = context.call ?? messageToolCall(context.message);
    if (!call) return;
    const url = String(callArgs(call).url ?? '');
    renderToolCard(context, {title: `WebFetch(${domainOf(url)})`, view: result => webFetchView(url, result)});
  },
};
