export const AUTOMA_TOOL_NAME = 'Automa';

export const AUTOMA_DESCRIPTION = `Dispatch stateless parallel workers for mechanical work. Each job runs on its own with no memory of you or of other jobs, and returns a receipt; its raw output never enters your context. You own the decomposition and the acceptance: workers report data, not judgment.

Use it by default when any of these holds and you only need the conclusion: answering one question will take three or more reads or searches; the same mechanical edit repeats across files; a check prints long output and you only need pass or fail plus the failures. Do it yourself when it takes one or two calls, or when you must understand the material to act on it next; delegating that only makes you read it twice. Never use it to wait for or watch a companion.

Write each brief so it stands alone: goal, scope, what not to touch, what done looks like, and what to report, including anything found but left unhandled.

Grants only narrow what you already have, and every worker call still passes the permission engine under your name:
- \`read\` limits reading (default: the workspace). Without \`files\` and \`commands\` a job is read-only.
- \`files\` lists the exact paths or globs a job may write, needs a writable \`preset\`, and must be disjoint across jobs. Writes outside it are refused without asking.
- \`commands\` narrows the preset's command prefixes; compound commands never match.
The \`changed\` line of a receipt is measured from real writes, not self-reported; it does not cover files changed by \`commands\`. Review it before you accept the work.

Jobs are single-use by default. Set \`persistence: true\` only when the same worker must run again on this task and each run builds on material it already loaded, so that restating it would cost more than keeping it: a repeat-until-green fix loop over one file set, or follow-up questions on a large body of evidence it just read. The receipt then gives an \`instance\` id; continue with \`instance\` and a brief holding only the next step.
Do not use persistence for one-off work, for parallel jobs that merely resemble each other, for keeping notes or judgment between unrelated tasks (that is your own memory), or to save writing a brief. A kept instance re-sends its whole context on every run.
An instance belongs to you alone and keeps its original grant. Release it with \`release\` as soon as the work is finished. It also ends with your current task, on failure or cancel, on restart, and when its context grows too large. You can keep two at most.`;

export const AUTOMA_ANIMATION_FRAMES = ['◜', '◠', '◝', '◞', '◡', '◟'] as const;

export const AUTOMA_COLOR_TOKEN = 'automa' as const;
