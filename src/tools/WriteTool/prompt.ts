export const WRITE_TOOL_NAME = 'Write';

export const WRITE_DESCRIPTION =
  'Create a UTF-8 file or overwrite an existing file with the complete supplied content; this is not an append operation. Read an existing file before replacing it so unrelated content is preserved; use Edit for a targeted change. Parent directories are created when needed. Existing files and new content are limited to 32 MiB. Successful writes are recorded for round-scoped /undo.';
