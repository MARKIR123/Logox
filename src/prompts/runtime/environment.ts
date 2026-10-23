export function workingDirectory(cwd: string): string {
  return 'Working directory: ' + cwd;
}

export const REQUEST_ENVIRONMENT_HEADER = 'Current execution environment (authoritative for this request):';
export const REVOCATION_RESTRICTION = 'This task has been remedied twice for the same failure. This turn only explains the cause, existing progress, and next steps; do not execute tools or dispatch again. Tool capability remains available.';
export const PENDING_HANDOFF_HEADER = 'Pending role handoff (new user instructions take precedence):';
