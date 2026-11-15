export const AUTOMA_TOOL_NAME = 'Automa';
export const FINISH_TOOL_NAME = 'Finish';

export const AUTOMA_DESCRIPTION = `Run stateless workers in parallel. Each worker starts from your brief, the project rules and the shared context; it never sees your conversation. Its raw output never enters your context: you get one result per job. You own the decomposition and the acceptance.

Use it for independent slices that each take more than a few calls: searches across many files, the same change applied to several files, a long test or build you only need judged. Do one slice yourself instead: a single worker is a lossy handoff, not parallelism. Dispatch all independent slices in one call, keep working while they run, and read the results when they arrive.

Minimal call: {"jobs":[{"brief":"List every caller of parseConfig under src/ as path:line, and say which pass a second argument.","scope":"exact"}]}

- \`context\` is written once for all jobs: the goal, conventions, interfaces and what is out of scope. Put shared facts here, not in every brief.
- \`brief\` stands alone: what to do, where, and what to report. \`acceptance\` lists the checks that define done; the worker is told to meet them and the result shows them beside its claims.
- \`scope\` says how open the problem is, not how much work it is: \`exact\` (the change or answer is fully specified), \`bounded\` (a known goal with room for judgment), \`open\` (the cause or approach is unknown). Never mention other jobs or coordination in it.
- \`writes\` lists workspace paths or globs the job may edit, disjoint across jobs. Leave it out for read-only work: reading, searching, commands and scratch scripts in your scratchpad need no grant.
- \`vision: true\` when the job must look at images (screenshots, mockups, image files); the job then runs on a model that can see images.
- Workers read whatever you can read and run commands; every call is judged by your permission rules and can never exceed them.
- \`keep: true\` keeps a worker's context for a follow-up (\`continue: "<id from the result>"\`; at most two, ended by \`release\` or your task).

Unknown fields are ignored with a note; a refused call states its exact fix.`;

export const FINISH_DESCRIPTION = `Hand your result back to your dispatcher and end the job. Call it exactly once, as your last action.

- \`status\`: \`done\` when the brief is fulfilled; \`blocked\` when a missing fact or decision stops you (put the one question in \`question\`; your dispatcher can answer and let you continue); \`failed\` when the job cannot be done, with the reason in \`summary\`.
- \`summary\`: the answer or what you did, in one or two sentences. It must follow from your evidence.
- \`evidence\`: one item per fact: \`path:line\`, or a command you ran with its key output.
- \`notVerified\`: what you did not check, could not do, or left outside your brief. Empty when nothing.`;

/** A worker turn that called no tool: a transient reminder, never a failure by itself. */
export const AUTOMA_NO_TOOL_REMINDER = 'Your last turn called no tool, so your job is still open. Continue the work, or call Finish with status done, blocked or failed. Do not invent a reason for stopping.';
/** The stall rule's verdict: three turns in a row without a tool call. */
export const AUTOMA_STALLED_SUMMARY = 'The worker stopped without calling Finish.';
/** Finish arrived together with other calls: those ran, this one is answered with the fix. */
export const AUTOMA_FINISH_ALONE = 'Finish was not accepted: it came in the same batch as other calls, whose results you have not seen yet. Call Finish alone, after reading those results.';
/** The answer to an accepted Finish; the worker never needs it except when a kept worker is continued. */
export const AUTOMA_FINISH_ACCEPTED = 'Result delivered to your dispatcher.';

export const AUTOMA_ANIMATION_FRAMES = ['◜', '◠', '◝', '◞', '◡', '◟'] as const;

export const AUTOMA_COLOR_TOKEN = 'automa' as const;
