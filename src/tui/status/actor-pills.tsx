import React, {type ReactElement} from 'react';
import {Box, Text} from 'ink';
import stringWidth from 'string-width';
import {stepIcon} from '../appearance/animation.js';
import {palette} from '../appearance/theme.js';
import {type ActorStyles} from '../appearance/actor-style.js';

export const PL_LEFT_ROUND = '\ue0b6';
export const PL_RIGHT_ROUND = '\ue0b4';
export const PL_LEFT_ARROW = '\ue0b2';

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
  readonly frames?: readonly string[] | undefined;
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
    const bg = role?.cardClosed ?? palette.actorPillBg;
    const fg = role?.color ?? palette.actorPillFg;
    return {
      id: act.activityId,
      ownerId,
      name,
      icon,
      bg,
      fg,
      width,
      frames,
      startX: 0,
      endX: 0,
    };
  });

  const n = rawPills.length;
  // Starship bar total width: 1 (left cap \ue0b6) + sum(widths) + (n - 1)*1 (separators \ue0b2) + 1 (right cap \ue0b4)
  const totalWidth = 2 + rawPills.reduce((sum, p, i) => sum + p.width + (i > 0 ? 1 : 0), 0);
  let currentX = Math.max(0, containerWidth - totalWidth);

  return rawPills.map((pill, i) => {
    const startX = currentX;
    const endX = currentX + 1 + pill.width + (i === n - 1 ? 1 : 0);
    currentX = endX;
    return {
      ...pill,
      startX,
      endX,
    };
  });
}

export function calculatePillsWidth(pills: readonly ActivePillItem[]): number {
  if (pills.length === 0) return 0;
  return 2 + pills.reduce((sum, p, i) => sum + p.width + (i > 0 ? 1 : 0), 0);
}

export function ActorPills({
  pills,
  hoveredOwnerId,
}: {
  readonly pills: readonly ActivePillItem[];
  readonly hoveredOwnerId?: string | null;
}): ReactElement | null {
  if (pills.length === 0) return null;
  const [clock, setClock] = React.useState(() => Date.now());

  React.useEffect(() => {
    const timer = setInterval(() => {
      setClock(Date.now());
    }, 200);
    return () => clearInterval(timer);
  }, [pills.length]);

  const n = pills.length;
  const segments: ReactElement[] = [];

  for (let i = 0; i < n; i++) {
    const pill = pills[i]!;
    const isHover = hoveredOwnerId === pill.ownerId;
    const segBg = isHover ? pill.fg : pill.bg;
    const segFg = isHover ? palette.bg : pill.fg;
    const currentIcon = pill.frames ? stepIcon({state: 'running'} as any, clock, true, pill.frames) : pill.icon;

    if (i === 0) {
      segments.push(
        <Text key="left-cap" color={segBg}>
          {PL_LEFT_ROUND}
        </Text>
      );
    } else {
      const prevPill = pills[i - 1]!;
      const prevHover = hoveredOwnerId === prevPill.ownerId;
      const prevBg = prevHover ? prevPill.fg : prevPill.bg;
      segments.push(
        <Text key={`sep-${i}`} color={segBg} backgroundColor={prevBg}>
          {PL_LEFT_ARROW}
        </Text>
      );
    }

    segments.push(
      <Text
        key={pill.ownerId}
        color={segFg}
        backgroundColor={segBg}
        bold={Boolean(isHover)}
      >
        {' ' + currentIcon + ' ' + pill.name + ' '}
      </Text>
    );

    if (i === n - 1) {
      segments.push(
        <Text key="right-cap" color={segBg}>
          {PL_RIGHT_ROUND}
        </Text>
      );
    }
  }

  return (
    <Box flexShrink={0} flexDirection="row">
      {segments}
    </Box>
  );
}

