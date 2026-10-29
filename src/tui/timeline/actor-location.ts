/** Locate the latest actor card without coupling status widgets to scene construction. */
export function findLatestActorRowIndex(rows: readonly any[], actorId: string): number {
  const target = actorId.toLowerCase();
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (!row) continue;
    if (row.actorId && String(row.actorId).toLowerCase() === target) return i;
    if (row.ownerId && String(row.ownerId).toLowerCase() === target) return i;
    if (row.action && typeof row.action === 'object') {
      if (row.action.owner && String(row.action.owner).toLowerCase() === target) return i;
      if (typeof row.action.foldId === 'string' && row.action.foldId.toLowerCase().includes(target)) return i;
    }
    if (row.hits && Array.isArray(row.hits)) {
      if (row.hits.some((h: any) => h.action?.owner && String(h.action.owner).toLowerCase() === target)) return i;
    }
    if (row.messageId && typeof row.messageId === 'string' && row.messageId.toLowerCase().includes(target)) return i;
  }
  return -1;
}
