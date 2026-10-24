import React, {type ReactElement} from 'react';
import {Box, Text} from 'ink';
import stringWidth from 'string-width';
import {stepIcon} from './row-presentation.js';
import {actorCardPalette, type ActorStyles} from './cards.js';

export interface ActivePillItem {
  readonly id: string;
  readonly ownerId: string;
  readonly name: string;
  readonly icon: string;
  readonly bg: string;
  readonly fg: string;
  readonly width: number;
  readonly startX: number;
  readonly endX: number;
}

export function computeActivePills(
  activities: readonly any[],
  sessionId: string,
  roles: ActorStyles = {},
  now: number = Date.now(),
  containerWidth: number = 80,
  activationOrder: readonly string[] = []
): ActivePillItem[] {
  const running = activities.filter(
    a => a.sessionId === sessionId && a.status === 'running' && a.ownerId && a.ownerId !== 'logox'
  );
  if (running.length === 0) return [];

  // Group by ownerId (one pill per active actor)
  const uniqueOwners = new Map<string, any>();
  for (const act of running) {
    if (!uniqueOwners.has(act.ownerId)) {
      uniqueOwners.set(act.ownerId, act);
    }
  }

  // Sort by activation order: earlier actors appear first, newer actors appear later (docked to the right)
  const sortedOwners = [...uniqueOwners.entries()].sort(([ownerA], [ownerB]) => {
    const idxA = activationOrder.indexOf(ownerA);
    const idxB = activationOrder.indexOf(ownerB);
    if (idxA >= 0 && idxB >= 0) return idxA - idxB;
    if (idxA >= 0) return -1;
    if (idxB >= 0) return 1;
    return 0;
  });

  const rawPills = sortedOwners.map(([ownerId, act]) => {
    const role = roles[ownerId];
    const frames = role?.thinkingAnimation;
    const icon = stepIcon({state: 'running'} as any, now, true, frames);
    const name = (role?.name ?? ownerId).toLowerCase();
    const text = ' ' + icon + ' ' + name + ' ';
    const width = stringWidth(text);
    const bg = (role as any)?.cardClosed ?? (actorCardPalette as any)[ownerId]?.closed ?? '#3e4450';
    const fg = role?.color ?? (actorCardPalette as any)[ownerId]?.highlight ?? '#ffffff';
    return {
      id: act.activityId,
      ownerId,
      name,
      icon,
      bg,
      fg,
      width,
      startX: 0,
      endX: 0,
    };
  });

  // Calculate total width with 1 space gap between pills
  const totalWidth = rawPills.reduce((sum, p, i) => sum + p.width + (i > 0 ? 1 : 0), 0);
  let currentX = Math.max(0, containerWidth - totalWidth);

  return rawPills.map((pill, i) => {
    const startX = currentX;
    const endX = currentX + pill.width;
    currentX = endX + 1;
    return {
      ...pill,
      startX,
      endX,
    };
  });
}

export function calculatePillsWidth(pills: readonly ActivePillItem[]): number {
  if (pills.length === 0) return 0;
  return pills.reduce((sum, p, i) => sum + p.width + (i > 0 ? 1 : 0), 0);
}

export function ActorPills({pills}: {readonly pills: readonly ActivePillItem[]}): ReactElement | null {
  if (pills.length === 0) return null;
  return (
    <Box flexShrink={0} flexDirection="row" gap={1}>
      {pills.map(pill => (
        <Text key={pill.ownerId} backgroundColor={pill.bg} color={pill.fg}>
          {' ' + pill.icon + ' ' + pill.name + ' '}
        </Text>
      ))}
    </Box>
  );
}

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

export function extractStatusBarSlice(text: string, colA: number, colB: number): string {
  const start = Math.max(0, Math.min(colA, colB));
  const end = Math.min(text.length, Math.max(colA, colB));
  if (start >= end) return '';
  return text.slice(start, end).trim();
}
