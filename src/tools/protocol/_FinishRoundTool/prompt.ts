export const FINISH_ROUND_FOLLOW_UP = `# Round closure
Your answer is delivered but the round is not closed. Reply with one _FinishRound call (title and summary) and nothing else: do not repeat the answer or call other tools.`;
/** Result for a call that arrived in the single closing follow-up and was therefore not executed. */
export const FINISH_ROUND_CLOSING_TOOL_RESULT = 'The round is closing, so this call was not executed.';

export const FINISH_ROUND_DESCRIPTION = 'Call it in the same reply as your final answer or assigned task report: the text is the delivery, and this call records compact round-memory metadata and ends the round. This internal tool has no user-facing result. Do not print its arguments in your reply. It is the only tool call in that reply, made once all business tools have finished; it does not verify work or declare Director acceptance. Arguments: title (a short name for the round) and summary (what was concluded or changed, the files involved, what was verified, and what remains).';
