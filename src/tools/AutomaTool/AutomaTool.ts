import {resolve} from 'node:path';
import {appendFile, mkdir, realpath} from 'node:fs/promises';
import {z} from 'zod';
import type {ToolResult} from '../types.js';
import type {ToolCall, ToolDefinition, ModelMessage} from '../../runtime/messages.js';
import {canonicalToolName} from '../types.js';
import {executeRead, readSchema} from '../ReadTool/ReadTool.js';
import {READ_DESCRIPTION} from '../ReadTool/prompt.js';
import {executeGlob, globSchema} from '../GlobTool/GlobTool.js';
import {GLOB_DESCRIPTION} from '../GlobTool/prompt.js';
import {executeGrep, grepSchema} from '../GrepTool/GrepTool.js';
import {GREP_DESCRIPTION} from '../GrepTool/prompt.js';
import {executeWebFetch, webFetchSchema} from '../WebFetchTool/WebFetchTool.js';
import {WEB_FETCH_DESCRIPTION} from '../WebFetchTool/prompt.js';

export const automaArgs = z.strictObject({
  prompt: z.string().min(1).describe('The search, indexing, or data extraction task for Automa to perform'),
  description: z.string().min(1).max(120).describe('A short 3-5 word label for the activity or status bar (e.g. "search legacy components")'),
  paths: z.array(z.string()).optional().describe('Optional list of file or directory paths to limit the search/extraction scope to'),
});

export type AutomaArgs = z.infer<typeof automaArgs>;
export const automaSchema = automaArgs;

export const AUTOMA_SYSTEM_PROMPT = `You are Automa, a stateless mechanical indexing and data extraction unit in LOGOX.
You have no personality, no opinions, and zero conversation.
Your sole function is to execute the given search or data collection task using your read-only tools and output ONLY the raw data, matching snippets, or exact file:line coordinates requested.
Never prepend greetings or explanations ("Certainly", "Here are the files:").
Never append polite concluding remarks.
If paths are specified in the prompt or arguments, limit your inspection to those paths.
If nothing matches, output strictly: NO_MATCHES.`;

export const automaToolDefinitions: readonly ToolDefinition[] = [
  {name: 'Read', description: READ_DESCRIPTION, parameters: z.toJSONSchema(readSchema)},
  {name: 'Glob', description: GLOB_DESCRIPTION, parameters: z.toJSONSchema(globSchema)},
  {name: 'Grep', description: GREP_DESCRIPTION, parameters: z.toJSONSchema(grepSchema)},
  {name: 'WebFetch', description: WEB_FETCH_DESCRIPTION, parameters: z.toJSONSchema(webFetchSchema)},
];

export interface AutomaOptions {
  readonly cwd: string;
  readonly sessionId?: string;
  readonly journalPath?: string;
  readonly provider?: {
    respond(
      params: {
        system: string;
        messages: readonly ModelMessage[];
        tools: readonly ToolDefinition[];
        thinking?: boolean | string | false;
      },
      onDelta?: (chunk: any) => void,
      signal?: AbortSignal
    ): Promise<{
      message: Extract<ModelMessage, {role: 'assistant'}>;
      stop: string;
      usage?: {input: number; output: number};
    }>;
  };
  readonly onStep?: (step: {tool: string; args: string}) => void;
}

export async function runAutomaReadOnlyTool(
  call: ToolCall,
  cwd: string,
  signal: AbortSignal
): Promise<ToolResult> {
  const name = canonicalToolName(call.name);
  if (!name || !['Read', 'Glob', 'Grep', 'WebFetch'].includes(name)) {
    return {
      text: `Tool \`${call.name}\` is not permitted in Automa read-only sandbox. Automa only supports Read, Glob, Grep, WebFetch.`,
      isError: true,
    };
  }

  let args: any;
  try {
    args = JSON.parse(call.arguments);
  } catch (err) {
    return {text: `Invalid JSON arguments for tool ${call.name}: ${err instanceof Error ? err.message : String(err)}`, isError: true};
  }

  try {
    if (name === 'Read') {
      const parsed = readSchema.parse(args);
      const original = resolve(cwd, parsed.file_path);
      const target = await realpath(original).catch(() => original);
      return await executeRead(parsed, target);
    }
    if (name === 'Glob') {
      const parsed = globSchema.parse(args);
      const original = parsed.path ? resolve(cwd, parsed.path) : cwd;
      const targetDir = await realpath(original).catch(() => original);
      return await executeGlob(parsed, targetDir, original, signal);
    }
    if (name === 'Grep') {
      const parsed = grepSchema.parse(args);
      const original = parsed.path ? resolve(cwd, parsed.path) : cwd;
      const target = await realpath(original).catch(() => original);
      return await executeGrep(parsed, target, original, cwd, signal);
    }
    if (name === 'WebFetch') {
      const parsed = webFetchSchema.parse(args);
      return await executeWebFetch(parsed, signal, {cwd});
    }
  } catch (error) {
    return {text: `Error executing ${name}: ${error instanceof Error ? error.message : String(error)}`, isError: true};
  }

  return {text: 'Unsupported tool', isError: true};
}

export async function executeAutoma(
  args: AutomaArgs,
  signal: AbortSignal,
  options: AutomaOptions
): Promise<ToolResult> {
  const provider = options.provider;
  if (!provider) {
    return {text: 'Automa requires a valid LLM provider instance to execute search.', isError: true};
  }

  const pathsConstraint = args.paths && args.paths.length > 0
    ? `\nTarget search scope restricted to:\n${args.paths.map(p => `  • ${p}`).join('\n')}`
    : '';

  const messages: ModelMessage[] = [
    {role: 'user', text: `${args.prompt}${pathsConstraint}`}
  ];

  let toolCallCount = 0;
  let resultText = '';
  const startTime = Date.now();

  while (!signal.aborted) {
    const turn = await provider.respond({
      system: AUTOMA_SYSTEM_PROMPT,
      messages,
      tools: automaToolDefinitions,
      thinking: false,
    }, undefined, signal);

    const assistantMsg = turn.message;
    messages.push(assistantMsg);

    const toolCalls = assistantMsg.toolCalls ?? [];
    if (toolCalls.length === 0) {
      resultText = assistantMsg.text.trim();
      break;
    }

    toolCallCount += toolCalls.length;
    for (const call of toolCalls) {
      signal.throwIfAborted();
      options.onStep?.({tool: call.name, args: call.arguments});
      const toolRes = await runAutomaReadOnlyTool(call, options.cwd, signal);
      messages.push({
        role: 'tool',
        name: call.name,
        callId: call.id,
        text: toolRes.text,
        isError: Boolean(toolRes.isError),
      });
    }
  }

  // Append-only audit record to subagents/automa.jsonl if journalPath is provided
  if (options.journalPath) {
    try {
      const record = {
        time: Date.now(),
        description: args.description,
        prompt: args.prompt,
        paths: args.paths ?? null,
        toolCalls: toolCallCount,
        elapsedMs: Date.now() - startTime,
        resultLength: resultText.length,
        resultExcerpt: resultText.slice(0, 300),
      };
      await mkdir(resolve(options.journalPath, '..'), {recursive: true});
      await appendFile(options.journalPath, JSON.stringify(record) + '\n');
    } catch {}
  }

  return {
    text: resultText || 'NO_MATCHES',
    isError: false,
  };
}
