/**
 * The fixed fake data behind the /theme sample. Everything the sample shows comes from here, so a theme is judged on the same
 * conversation every time and the text markers the tests look for live in one place.
 */
export const SAMPLE_SESSION = 'theme-sample';

export const sample = {
  user: 'Fix the failing login test and tell me what changed.',
  /** The first line is the Director's `⏵` status; the rest is the reply (Markdown). */
  reply: '⏵ Checking the login test\nThe retry loop never resets `attempts`, so the **second login** fails. Patch is in `src/sample/login.ts`.',
  glob: {pattern: 'src/sample/**/*.ts', result: 'src/sample/login.ts\nsrc/sample/session.ts\nsrc/sample/retry.ts'},
  grep: {
    args: {pattern: 'attempts', path: 'src/sample', output_mode: 'content'},
    result: 'src/sample/login.ts:12: let attempts = 0;\nsrc/sample/login.ts-13- while (!ok) {\nsrc/sample/login.ts:14:   attempts += 1;',
  },
  edit: {
    file_path: 'src/sample/login.ts',
    old_string: '  let attempts = 0;\n  while (!ok) {\n    attempts += 1;\n    ok = await tryLogin(user);\n  }',
    new_string: '  let attempts = 0;\n  while (!ok && attempts < MAX_ATTEMPTS) {\n    attempts += 1;\n    ok = await tryLogin(user);\n  }\n  attempts = 0;',
    result: 'Edited src/sample/login.ts',
  },
  fetch: {url: 'https://example.com/docs/retry', result: '[Fetched from: https://example.com/docs/retry | HTTP 200 | Title: Retry policy]\n# Retry policy\nBack off between attempts.'},
  companion: {
    owner: 'techne', task: 'Fix retry loop', narration: 'Patching the retry loop',
    tool: {name: 'Edit', args: {file_path: 'src/sample/retry.ts', old_string: 'a', new_string: 'b'}},
    /** Seconds the running tool has been on the clock. */
    seconds: 14,
  },
  dream: {stage: 'Recapping the session', detail: 'Reviewed 12 messages and kept 3 notes for the next session.'},
  /** The labelled words drawn straight from the palette. */
  efforts: ['off', 'low', 'medium', 'high', 'max', 'auto'] as const,
  modes: ['default', 'auto', 'creative'] as const,
  marks: {success: '✓ Tests passed', warning: '▲ One test skipped', error: '✗ Build failed'},
  selection: 'selected',
  prompt: 'Which branch should I use?',
  composer: 'Ask Logox to continue…',
} as const;
