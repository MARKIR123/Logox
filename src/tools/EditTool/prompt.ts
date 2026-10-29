export const EDIT_TOOL_NAME = 'Edit';

export const EDIT_DESCRIPTION =
  'Replace an exact string in an existing UTF-8 file. Read the current contents first and omit Read line-number prefixes from old_string and new_string. The match must be unique unless replace_all is true; include enough surrounding text to disambiguate. Missing or ambiguous matches fail without modifying the file. Unchanged content, UTF-8 BOM and existing line-ending style are preserved; files and resulting content are limited to 32 MiB.';
