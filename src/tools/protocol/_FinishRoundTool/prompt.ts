export const FINISH_ROUND_REPAIR = `# Round memory correction
This is a metadata-only correction. The final answer or report has already been delivered. Submit only a complete _FinishRound call with title, verification (null when unverified), and carry_forward. Preserve the existing answer and completed effects; no repeated answer, additional business tools, or further work. This is the single correction attempt.`;
export const FINISH_ROUND_MISSING_TEXT = `# Round closure correction
No usable final answer or report was delivered. Provide the final text, then a complete _FinishRound call alone. Business tools are unavailable during this single closure correction.`;

export const FINISH_ROUND_DESCRIPTION = 'After delivering your final answer or assigned task report in the text channel, submit compact English round-memory metadata and end the round. This internal tool has no user-facing result. Do not print its arguments in your reply. Use it alone, after all business tools have finished; it does not verify work or declare Director acceptance.';
