/** Find a case-insensitive prefix at the name, last word, or final path component. */
export function splitQueryMatch(name: string, query: string): {before: string; match: string; after: string} | null {
  const needle = query.trim();
  if (!needle) return null;
  const candidates = [0, name.startsWith('/') ? 1 : 0, name.lastIndexOf(' ') + 1, Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1];
  const lowered = needle.toLocaleLowerCase();
  for (const start of new Set(candidates)) {
    if (name.slice(start, start + needle.length).toLocaleLowerCase() === lowered) {
      return {before: name.slice(0, start), match: name.slice(start, start + needle.length), after: name.slice(start + needle.length)};
    }
  }
  // Completion hosts may pass a whole command draft; its final token is the active query.
  const tail = needle.slice(needle.lastIndexOf(' ') + 1);
  return tail !== needle ? splitQueryMatch(name, tail) : null;
}
