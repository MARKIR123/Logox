export const AUTOMA_TOOL_NAME = 'Automa';

export const AUTOMA_DESCRIPTION = `Run stateless workers in parallel. Each job sees only its brief and returns a short receipt (Verdict, Evidence, Not verified); its raw output never enters your context. You own the decomposition and the acceptance.

Use it for independent investigations or edits that run side by side: "where is X used", "does this hold in each module", "apply this change to these files", a long test or build you only need judged. Not for one quick command or a question one or two calls answer.

Minimal call: {"jobs":[{"brief":"List every caller of parseConfig under src/ as path:line, and say which pass a second argument."}]}

- \`brief\` (required) stands alone: goal, scope, what not to touch, what to report. \`title\` is optional.
- \`writes\` is optional: workspace paths or globs the job may edit, disjoint across jobs, never the whole workspace. Leave it out for read-only work: reading, searching, commands and scratch scripts in your scratchpad need no grant.
- Workers read whatever you can read and run commands. Every call is judged by your permission rules in your current mode and can never exceed them; what a job could not do is listed under Not verified.
- \`changed\` in the receipt is measured from real writes (not files changed by shell commands): review it before accepting.
- \`keep: true\` keeps a worker's context for a follow-up (\`continue: "<id from the receipt>"\`; at most two, ended by \`release\` or your task).

Unknown fields are ignored with a note; a refused call states its exact fix.`;

export const AUTOMA_ANIMATION_FRAMES = ['◜', '◠', '◝', '◞', '◡', '◟'] as const;

export const AUTOMA_COLOR_TOKEN = 'automa' as const;
