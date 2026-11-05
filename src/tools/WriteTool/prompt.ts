export const WRITE_TOOL_NAME = 'Write';

export const WRITE_DESCRIPTION =
  'Create a UTF-8 file or overwrite an existing file with the complete supplied content; this is not an append operation. Read an existing file before replacing it so unrelated content is preserved; use Edit for a targeted change. Parent directories are created when needed. Existing files and new content are limited to 32 MiB. Successful writes are recorded for round-scoped /undo. Replacing an existing file larger than 20 KB or 400 lines is refused: change it with Edit, or pass overwrite: true when a complete replacement is truly intended.';

/** Existing files above either bound must be changed with Edit unless the caller opts in with overwrite. */
export const WRITE_LARGE_FILE_BYTES = 20 * 1024;
export const WRITE_LARGE_FILE_LINES = 400;
export const WRITE_OVERWRITE_DESCRIPTION = 'Set true only to replace an existing file larger than 20 KB or 400 lines in full; otherwise change large files with Edit.';
export const WRITE_LARGE_FILE_NOTICE = 'Not written: this file already exists and is large (over 20 KB or 400 lines). Change it with Edit instead of rewriting it wholesale. If a complete replacement is truly intended, call Write again with overwrite: true.';
