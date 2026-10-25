export const AUTOMA_TOOL_NAME = 'Automa';

export const AUTOMA_DESCRIPTION =
  'Run a stateless, read-only mechanical worker to search, index, or extract data across files or web pages without polluting your context with raw file dumps. Automa executes in an isolated ephemeral loop using read-only tools (Read, Glob, Grep, WebFetch) and returns only the concise conclusion, coordinates (file:line), or extracted data. Use this whenever answering requires scanning multiple files, reading large logs, or mechanical extraction where you only need the result.';

export const AUTOMA_ANIMATION_FRAMES = ['◜', '◠', '◝', '◞', '◡', '◟'] as const;

export const AUTOMA_THEME_COLOR = '#8a95a0';
