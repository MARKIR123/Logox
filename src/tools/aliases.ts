/**
 * Legacy argument aliases are normalized before strict validation.
 *
 * Model-facing schemas expose Claude Code parameter names; the alias map keeps
 * historical sessions and third-party callers working during the migration
 * window. Canonical keys always win when both are present.
 */
export function normalizeAliases(value: unknown, aliases: Readonly<Record<string, string>>): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const result: Record<string, unknown> = {...(value as Record<string, unknown>)};
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (canonical in result) {
      delete result[alias];
      continue;
    }
    if (alias in result) {
      result[canonical] = result[alias];
      delete result[alias];
    }
  }
  return result;
}

/** Reads the canonical file path from an already-normalized tool argument object. */
export function filePathOf(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.file_path === 'string') return record.file_path;
  if (typeof record.path === 'string') return record.path;
  return undefined;
}
