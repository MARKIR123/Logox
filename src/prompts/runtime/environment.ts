export function workingDirectory(cwd: string): string {
  return 'Working directory: ' + cwd;
}

export const REVOCATION_RESTRICTION = 'This task has been remedied twice for the same failure. This turn only explains the cause, existing progress, and next steps; do not execute tools or dispatch again. Tool capability remains available.';
/** Tool result while `REVOCATION_RESTRICTION` applies: the tool list is unchanged for the prompt cache, so calls are refused instead. */
export const TOOLS_RESTRICTED_RESULT = 'This call was not executed: the recovery budget for this failure is spent. Explain the cause, the existing progress and the next steps in text.';
export const PENDING_HANDOFF_HEADER = 'Pending role handoff (new user instructions take precedence):';

export function conversationLanguage(language: string): string {
  return language + ' (reply, brief teammates and hand off in this language)';
}
