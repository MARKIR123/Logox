export const SKILL_TOOL_NAME = 'Skill';

export const SKILL_DESCRIPTION =
  'Skills are instruction files on disk that carry proven methods for a kind of work. Use action "search" with a few topic words to find the skills visible to you (name, category, how often they were used, description, path); use action "load" with an exact skill name to read its instructions. Reading a skill\'s path with Read works as well. Skills grant no tool permissions.';

export const SKILL_NO_LIBRARY = 'Skills are not available in this session.';
export const SKILL_SEARCH_NEEDS_QUERY = 'action "search" needs a non-empty `query`.';
export const SKILL_LOAD_NEEDS_NAME = 'action "load" needs the exact skill `name`.';
export const skillSearchEmpty = (query: string) => `No skill matches "${query}". Try fewer or broader words, or a single topic word.`;
export const skillLoadUnknown = (name: string, close: readonly string[]) =>
  `No skill named "${name}" is visible to you.` + (close.length ? ` Closest names: ${close.join(', ')}.` : ' Use action "search" to find one.');
