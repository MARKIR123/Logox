import {permissionDecisionSchema, permissionScopeSchema, type NewPermissionRule} from './engine.js';
import {shellWords} from './shell.js';

export type RuleInputResult = {ok: true; rule: NewPermissionRule} | {ok: false; error: string};
/** Validates a rule typed into the /permissions form; the engine re-validates on add, so this only has to explain mistakes early. */
export function validateRuleInput(input: {decision: string; tool: string; pattern: string; scope: string}, userScope = true): RuleInputResult {
  const decision = permissionDecisionSchema.safeParse(input.decision), scope = permissionScopeSchema.safeParse(input.scope);
  if (!decision.success) return {ok: false, error: 'Decision must be allow, ask or deny'};
  if (!scope.success) return {ok: false, error: 'Scope must be user, project or session'};
  if (scope.data === 'user' && !userScope) return {ok: false, error: 'The user scope is not available here'};
  const tool = input.tool.trim().toLowerCase(), pattern = input.pattern.trim();
  if (!tool) return {ok: false, error: 'Tool is required (for example shell, write, edit, read or mcp:server:tool)'};
  if (!/^[a-z][a-z0-9_.:-]*$/.test(tool)) return {ok: false, error: 'Tool may contain only letters, digits and _ . : -'};
  if (!pattern) return {ok: false, error: 'Pattern is required (use * to match every call)'};
  if (pattern.length > 2000) return {ok: false, error: 'Pattern is too long (2000 characters at most)'};
  if (tool === 'shell' && pattern !== '*') {
    const parsed = shellWords(pattern);
    if (parsed.compound || parsed.dynamic) return {ok: false, error: 'Shell patterns must be static token prefixes such as "npm run"'};
  }
  return {ok: true, rule: {scope: scope.data, decision: decision.data, tool, pattern}};
}
/** `2m ago` style age for the hit column. */
export function ageLabel(time: number | undefined, now = Date.now()): string {
  if (!time) return 'never';
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + 'm ago';
  const hours = Math.round(minutes / 60);
  if (hours < 48) return hours + 'h ago';
  return Math.round(hours / 24) + 'd ago';
}
