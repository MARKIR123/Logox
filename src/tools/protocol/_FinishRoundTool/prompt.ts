export const FINISH_ROUND_FOLLOW_UP = `# Round closure
Your answer is delivered but the round is not closed. Reply with one _FinishRound call (title and summary) and nothing else: do not repeat the answer or call other tools.`;
/** Result for a call that arrived in the single closing follow-up and was therefore not executed. */
export const FINISH_ROUND_CLOSING_TOOL_RESULT = 'The round is closing, so this call was not executed.';

/*
 * Bad cases this description is written against, and what the runtime does with each (`src/kernel/reply.ts:settleReply()`):
 *
 * A. `_FinishRound` called with no visible text (a reply whose text is only the `⏵` status line counts: the line is stripped).
 *    A1. The report was written into `summary` instead of the text channel. Seen 2026-11-24 with gemini-4-neon-high (Techne,
 *        pelican-ride): 38 of 40 replies were tool-only, the closing reply put an 800-character report into `summary` and ignored
 *        the nudge. Handling: tool result `FINISH_ROUND_NO_TEXT_RESULT` plus one `FINISH_ROUND_NO_TEXT_NUDGE`; if the next reply is
 *        again textless and the summary is substantive, the runtime delivers `title + summary` as written (never the token-capped
 *        memory form, `round-memory.ts:readFinishRound()`), marked `synthesizedReport`.
 *    A2. No report at all, only a short memory line. Same nudge; a summary under `SUBSTANTIVE_SUMMARY` characters is no report, so
 *        the run ends in `ExecutionRecoveryError('no_delivery')` (a companion hands the failure to the Director).
 *    A variant the runtime cannot see: a placeholder text (a stage line) with the conclusions only in `summary` (evals t3,
 *    2026-11-17). The text is non-empty, so it stands as the answer; only this description prevents it.
 * B. Visible text with no `_FinishRound` call.
 *    B1. The text is the compressed summary rather than the full answer. The runtime cannot tell a short answer from a shrunk one:
 *        the text stands as the delivery and the closing follow-up asks for the call. Only this description prevents it.
 *    B2. The round-memory requirement was ignored. One closing follow-up (`FINISH_ROUND_FOLLOW_UP`); if that reply still has no
 *        call, the runtime writes the record from recorded facts (`[reply]` marker) and the round ends normally.
 */
export const FINISH_ROUND_DESCRIPTION = 'Records internal round memory and ends the round. TITLE AND SUMMARY ARE NEVER SHOWN TO THE USER OR THE DIRECTOR AND NEVER REPLACE YOUR ANSWER. In the same reply, write the full final answer or assigned task report as visible text (a status line alone is not one), then make this call as the only tool call, once all business tools have finished. The summary is a short index of that text, not a shrunk copy of it; do not print the arguments in your reply. It does not verify work or declare Director acceptance. Arguments: title (a short name for the round) and summary (what was concluded or changed, the files involved, what was verified, and what remains).';
