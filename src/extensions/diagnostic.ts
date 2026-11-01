/**
 * Diagnostic handler for MCP calls: the generic `mcp` tool (`server`/`action`/`tool`/`arguments`)
 * and direct `mcp__<server>__<tool>` names, for which `diagnoseToolError` supplies `__server`/`__tool`.
 */
const FILE_PROTOCOL = /protocol is blocked|"file:"[^\n]*blocked|blocked[^\n]*"file:"/i;
const SCHEMA_ERROR = /do not satisfy the full schema|additionalProperties|must have required property/i;

function schemaProblems(rawError: string): {unexpected: string[]; missing: string[]} {
  const unexpected = new Set<string>(), missing = new Set<string>();
  for (const match of rawError.matchAll(/"additionalProperty"\s*:\s*"([^"]+)"/g)) unexpected.add(match[1]!);
  for (const match of rawError.matchAll(/"missingProperty"\s*:\s*"([^"]+)"/g)) missing.add(match[1]!);
  return {unexpected: [...unexpected], missing: [...missing]};
}

export function diagnoseMcp(args: Record<string, unknown>, rawError: string): string | undefined {
  const tool = String(args.tool ?? args.__tool ?? '');
  const server = String(args.server ?? args.__server ?? '');
  const base = rawError.trim().replace(/\.+$/, '');

  if (FILE_PROTOCOL.test(rawError)) {
    return `${base}. Serve the folder over HTTP first (e.g. \`npx -y serve -l <free-port> <dir>\` or \`python -m http.server <free-port>\`), confirm the port is listening, then navigate to \`http://127.0.0.1:<port>/<file>\`.`;
  }

  if (tool === 'browser_close' || /no open tabs/i.test(rawError)) {
    return `${base}. The browser is already closed; do not retry close.`;
  }

  if (SCHEMA_ERROR.test(rawError)) {
    const {unexpected, missing} = schemaProblems(rawError);
    const named = [
      unexpected.length ? `unexpected properties: ${unexpected.join(', ')}` : '',
      missing.length ? `missing required properties: ${missing.join(', ')}` : '',
    ].filter(Boolean).join('; ');
    const listing = `mcp({"server":"${server || '<server>'}","action":"list"})`;
    return `${tool ? `Arguments for MCP tool "${tool}" are invalid` : 'MCP arguments are invalid'}${named ? ` (${named})` : ''}. Run ${listing} to read the tool's exact parameter schema, then retry with only the listed properties.`;
  }

  return undefined;
}
