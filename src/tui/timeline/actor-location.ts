/** Locate the latest actor card without coupling status widgets to scene construction. */
export function findLatestActorRowIndex(rows: readonly any[], actorId: string): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (!row) continue;
    if (row.actorId === actorId) return i;
    if (row.action?.foldId && typeof row.action.foldId === 'string' && row.action.foldId.includes(actorId)) return i;
    if (row.messageId && typeof row.messageId === 'string' && row.messageId.includes(actorId)) return i;
  }
  return -1;
}
