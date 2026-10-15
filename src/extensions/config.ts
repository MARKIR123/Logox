import {z} from 'zod';

export const mcpServerSchema = z.strictObject({
  transport: z.enum(['stdio', 'http']).default('stdio'),
  command: z.string().min(1), args: z.array(z.string()).max(128).default([]),
  env: z.record(z.string(), z.string()).default({}),
  enabled: z.boolean().default(true), description: z.string().max(500).default(''),
  timeout: z.number().positive().max(600).default(30),
  startup_timeout_s: z.number().positive().max(60).default(10),
});
export type McpServerConfig = z.infer<typeof mcpServerSchema>;
export const hookEvents = ['session_start', 'post_tool_use', 'pre_compact', 'notification', 'stop'] as const;
export type HookEvent = typeof hookEvents[number];
export const hooksSchema = z.strictObject({
  enabled: z.boolean().default(false), timeout_s: z.number().positive().max(30).default(5),
  entries: z.array(z.strictObject({event: z.enum(hookEvents), command: z.string().min(1),
    args: z.array(z.string()).max(128).default([]), tool: z.string().optional()})).max(64).default([]),
});
export type HooksConfig = z.infer<typeof hooksSchema>;
