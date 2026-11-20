export const AUTOMA_TOOL_NAME = 'Automa';
export const FINISH_TOOL_NAME = 'Finish';

export const AUTOMA_DESCRIPTION = `Run stateless workers in parallel. Each worker starts from your brief, the project rules and the shared context; it never sees your conversation. Its raw output never enters your context: you get one result per job. You own the decomposition and the acceptance.

Use it for independent slices that each take more than a few calls: searches across many files, the same change applied to several files, a long test or build you only need judged. Do one slice yourself instead: a single worker is a lossy handoff, not parallelism. Dispatch all independent slices in one call, keep working while they run, and read the results when they arrive.

Minimal call: {"jobs":[{"brief":"List every caller of parseConfig under src/ as path:line, and say which pass a second argument.","scope":"exact"}]}

- \`context\` is written once for all jobs: the goal, conventions, interfaces and what is out of scope. Put shared facts here, not in every brief.
- \`brief\` stands alone: what to do, where, and what to report. \`acceptance\` lists the checks that define done; the worker is told to meet them and the result shows them beside its claims.
- \`scope\` says how open the problem is, not how much work it is: \`exact\` (the change or answer is fully specified), \`bounded\` (a known goal with room for judgment), \`open\` (the cause or approach is unknown). Never mention other jobs or coordination in it.
- \`writes\` lists workspace paths or globs the job may edit, disjoint across jobs. Leave it out for read-only work: reading, searching, commands and scratch scripts in your scratchpad need no grant.
- Jobs without \`writes\` run on a fast read model; jobs with \`writes\` run on a stronger code model. Give a read-only job \`writes\` only if it must edit.
- \`after\` orders jobs: a job starts when the jobs it names (by id \`T1\`…, \`#n\` or title) are done, and receives their results. Jobs without \`after\` run in parallel; a job whose prerequisite does not finish is skipped. Ordered jobs may write the same files.
- \`mode: "background"\` returns at once and delivers each result as a message when it is ready, so you can act on the first findings while the rest run. Use it when early results let you move on; use the default when you need all results together. \`{"wait": ["T3"]}\` waits for specific background jobs.
- \`vision: true\` when the job must look at images (screenshots, mockups, image files); the job then runs on a model that can see images.
- Workers read whatever you can read and run commands; every call is judged by your permission rules and can never exceed them.
- Every finished worker can be continued with \`continue: "<id from the result>"\` and a new \`brief\`; it keeps its context. \`release\` ends workers you no longer need; all of them end with your task.

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
/** The answer to an accepted Finish; the worker sees it again when it is continued. */
export const AUTOMA_FINISH_ACCEPTED = 'Result delivered to your dispatcher.';

/** One line per dispatch: some of its jobs waited for a running slot because the session runs a limited number of workers at once (`[automa] max_running`). */
export const queuedJobsLine = (queued: number, total: number, maxRunning: number): string =>
  `Queued ${queued} of ${total} jobs: the session runs at most ${maxRunning} workers at once.`;

/** The last line of a background dispatch's receipt. */
export const BACKGROUND_RECEIPT_SENTENCE = 'Results arrive as messages while you keep working; you do not need to wait for them.';
/** One receipt line per job of a background dispatch. */
export const backgroundReceiptLine = (id: string, title: string, state: 'running' | 'queued' | 'waiting', after: readonly string[]): string =>
  `${id} ${title.replace(/\s+/g, ' ').trim()} · ${state === 'waiting' ? 'waiting on ' + after.join(', ') : state}`;
/** `Automa` called with `wait` together with other fields. */
export const WAIT_ALONE = 'Send `wait` alone. Fix: {"wait":["T3"]}, ids of your own background jobs; dispatch more jobs in a separate call.';
/** `wait` named ids that are not background jobs of this task. */
export const waitUnknown = (unknown: readonly string[], known: readonly string[]): string =>
  `Unknown background job${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}. ` + (known.length ? `Your background jobs are ${known.join(', ')}.` : 'You have no background jobs right now.') +
  ' Fix: wait only for ids a background receipt listed.';
/** Background mode needs somewhere to deliver results. */
export const BACKGROUND_UNAVAILABLE = 'Background mode is not available here. Fix: omit `mode`, or use `"mode":"wait"`.';
/** The summary line of a delivery of results (shown beside the message header). */
export const backgroundDeliverySummary = (ids: readonly string[]): string => 'Automa results ' + ids.join(', ');

export const AUTOMA_ANIMATION_FRAMES = ['◜', '◠', '◝', '◞', '◡', '◟'] as const;

export const AUTOMA_COLOR_TOKEN = 'automa' as const;
