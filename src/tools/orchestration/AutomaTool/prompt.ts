export const AUTOMA_TOOL_NAME = 'Automa';

export const AUTOMA_DESCRIPTION = `Run stateless parallel workers for mechanical work. Each job has no memory of you or of other jobs, and returns a receipt (summary, evidence, notes); its raw output never enters your context. You own the decomposition and the acceptance.

Use it when you only need the conclusion: a question that takes three or more reads or searches, the same edit repeated across files, a check with long output. Do it yourself when it takes one or two calls or you must understand the material to act on it. Never use it to wait for a companion.

Example: {"jobs": [{"brief": "List every caller of parseConfig under src/ as path:line, and say which pass a second argument. Edit nothing."}, {"brief": "Rename Foo to Bar in src/a.ts and src/b.ts; report each changed line.", "files": ["src/a.ts", "src/b.ts"]}]}

Only \`brief\` is required: goal, scope, what not to touch, what to report. It must stand alone. Every other field is optional and must be left out, not filled with a placeholder such as "n/a" or "none".
- Jobs are read-only unless you list \`files\` (paths or globs they may write; disjoint across jobs, not the whole workspace). Add \`commands\` (prefixes such as "npm test") only if a job must run them. The preset is chosen for you.
- Grants only narrow what you already have; every worker call still passes the permission engine under your name, and an out-of-grant call is refused. The \`changed\` line of a receipt is measured from real writes (not files changed by commands): review it before accepting.
- Jobs are single-use. \`persistence\`, \`instance\` and \`release\` are for the rare case where one worker must run again on material it already loaded: set \`persistence: true\`, then continue with the \`instance\` id from its receipt and release it when done (at most two kept).`;

export const AUTOMA_ANIMATION_FRAMES = ['◜', '◠', '◝', '◞', '◡', '◟'] as const;

export const AUTOMA_COLOR_TOKEN = 'automa' as const;
