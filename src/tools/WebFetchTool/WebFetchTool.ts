import {z} from 'zod';
import type {ToolResult} from '../types.js';
import {maybePersistLargeOutput} from '../../kernel/scratchpad.js';
import {htmlToMarkdown} from './utils.js';

export {htmlToMarkdown};

export const webFetchSchema = z.strictObject({
  url: z.string().url(),
  prompt: z.string().optional(),
});

export type WebFetchArgs = z.infer<typeof webFetchSchema>;

export interface WebFetchOptions {
  cwd?: string;
  sessionId?: string;
  callId?: string;
}

export async function executeWebFetch(
  args: WebFetchArgs,
  signal?: AbortSignal,
  options: WebFetchOptions = {}
): Promise<ToolResult> {
  const parsedUrl = new URL(args.url);
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error(`Only HTTP and HTTPS protocols are supported, received: ${parsedUrl.protocol}`);
  }

  const timeoutSignal = AbortSignal.timeout(15_000);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  const response = await fetch(parsedUrl.href, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) LOGOX-Agent/1.0 (compatible)',
      'Accept': 'text/html,application/xhtml+xml,text/plain,text/markdown;q=0.9,*/*;q=0.8',
    },
    signal: combinedSignal,
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${args.url}: HTTP ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  const rawText = await response.text();

  let markdown = '';
  if (contentType.includes('text/html') || contentType.includes('application/xhtml+xml') || /<html|<!doctype/i.test(rawText.slice(0, 500))) {
    markdown = htmlToMarkdown(rawText);
  } else {
    markdown = rawText.trim();
  }

  if (!markdown) {
    return {
      text: `[Fetched ${args.url}: Document body is empty]`,
      isError: false,
    };
  }

  const header = `[Fetched from: ${args.url}${args.prompt ? ` | Context goal: ${args.prompt}` : ''}]\n\n`;
  let result = header + markdown;

  if (options.cwd) {
    result = await maybePersistLargeOutput(result, options.cwd, options.callId ?? 'web-fetch', options.sessionId);
  }

  return {
    text: result,
    isError: false,
  };
}
