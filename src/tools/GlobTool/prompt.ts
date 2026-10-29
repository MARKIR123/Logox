export const GLOB_TOOL_NAME = 'Glob';

export const GLOB_DESCRIPTION =
  'Find files by a glob pattern relative to the search directory, which defaults to the working directory. The pattern must be relative and cannot contain parent-directory traversal. Returns up to 200 matching paths relative to that directory, sorted lexically; dependency, build, cache and VCS directories are excluded. Results do not contain file contents. Narrow the pattern when the result-limit notice appears.';
