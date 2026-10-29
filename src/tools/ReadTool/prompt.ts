export const READ_TOOL_NAME = 'Read';

export const READ_DESCRIPTION =
  'Read a local file at its absolute path. Text must be UTF-8 and is returned with 1-based line numbers, starting at offset 1 and reading at most 2000 lines by default. Use offset and limit for a specific line range; selected lines are returned without per-line clipping. Text output above 256 KiB fails explicitly rather than returning a partial line; request fewer lines or use a bounded extraction for a single oversized line. Files above 32 MiB are rejected. PNG, JPG, JPEG, GIF and WebP images up to 10 MiB are presented visually, not as OCR text. Directories, PDFs and notebook-specific rendering are not supported.';
