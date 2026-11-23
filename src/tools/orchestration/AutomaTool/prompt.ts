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
- \`fork: true\` runs the job as a copy of yourself that starts with your full context instead of a brief: use it for a part that needs your understanding, not for searches or mechanical edits. It costs far more than a worker; at most a few run at once.
- \`vision: true\` when the job must look at images (screenshots, mockups, image files); the job then runs on a model that can see images.
- Workers read whatever you can read and run commands; every call is judged by your permission rules and can never exceed them.
- Every finished worker can be continued with \`continue: "<id from the result>"\` and a new \`brief\`; it keeps its context. \`release\` ends workers you no longer need; all of them end with your task.
- \`name\` is an optional short handle for a worker you may continue or refer to later: lowercase kebab-case, at most 24 characters (\`scout\`, \`api-tests\`), unique among your workers. Wherever an id is accepted (\`continue\`, \`after\`, \`wait\`, \`release\`) its name works too; ids still work.

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
export const backgroundReceiptLine = (id: string, title: string, state: 'running' | 'queued' | 'waiting', after: readonly string[], name?: string): string =>
  `${id}${name ? ` (${name})` : ''} ${title.replace(/\s+/g, ' ').trim()} · ${state === 'waiting' ? 'waiting on ' + after.join(', ') : state}`;
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

/** The tool result of the dispatching call in every fork's first request; identical for every fork of a dispatch so the prefix is shared. */
export const FORK_RESULT_TEXT = 'Forked. Your part follows.';
/** The result stored for another call of the same assistant message (it stays paired, and is identical for every fork). */
export const FORK_SIBLING_RESULT_TEXT = 'Handled by your original.';
/** The user message that opens a fork, before the job's own fields. */
export const FORK_DIRECTIVE = `You are a fork of yourself, running one part of the work in parallel while your original continues. You know everything your original knew up to this point. Do only the part below; leave everything else to your original.
- You cannot dispatch, fork, message teammates or change the plan; those calls are refused. Work with the files and commands you need for your part.
- End by calling Finish exactly once with what you did and the evidence. Your original reads only that.`;
/** A fork called an orchestration tool. */
export const FORK_REFUSAL = 'Forks cannot dispatch, fork, message teammates or change the plan. Do your part with your other tools.';
/** `fork: true` outside an actor's own call. */
export const FORK_NOT_HERE = '`fork: true` is only available to an actor, not inside a worker or fork. Fix: do the part yourself, or give a worker a short brief without `fork`.';
/** `fork: true` where no request of the dispatcher is known (no kernel turn behind the call). */
export const FORK_NO_CONTEXT = '`fork: true` needs the request that produced this call, and none is available here. Fix: omit `fork` and give a worker a brief.';
/** A provider that caches no prefix: forks are still allowed. */
export const forksUncachedLine = (provider: string): string => `Forks on ${provider} are not cached; each costs a full read of your context. Prefer workers with a brief.`;
/** One line per dispatch: forks waited for a place because a dispatcher runs a limited number of them at once (`[automa] max_forks_running`). */
export const queuedForksLine = (queued: number, total: number, maxForks: number): string =>
  `Queued ${queued} of ${total} forks: you run at most ${maxForks} forks at once.`;
/** The result's note for a fork whose prefix was mostly not read from cache. */
export const forkCacheNote = (percent: number): string =>
  `this fork's prefix was not served from cache (${percent}%); a fresh worker with a short brief is cheaper.`;
/** The result's note for a fork that ended with a plain reply (the provider did not accept or the model did not emit Finish). */
export const FORK_PLAIN_END_NOTE = 'this fork ended with a plain reply instead of Finish; its last text is the summary.';
/** The fork's tools that are refused at execution: its tool list stays identical to the dispatcher's, so the prefix does not change. */
export const FORK_REFUSED_TOOLS = ['Actor', 'Automa', 'SendMessage', 'Plan', 'CraftActor', 'CancelActor', 'AskUserQuestion', 'ReadActor'] as const;
/** The marker beside a fork's row, owner or kind: `⑂`. */
export const FORK_MARK = '⑂';

export const AUTOMA_ANIMATION_FRAMES = ['◜', '◠', '◝', '◞', '◡', '◟'] as const;

export const AUTOMA_COLOR_TOKEN = 'automa' as const;
