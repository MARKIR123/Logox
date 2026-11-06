import React, {type ReactElement} from 'react';
import {Box, Text} from 'ink';
import stringWidth from 'string-width';
import {stepIcon} from '../appearance/animation.js';
import {palette} from '../appearance/theme.js';
import {mixHex} from '../appearance/colors.js';
import {type ActorStyles} from '../appearance/actor-style.js';

export const PL_LEFT_ROUND = '';
export const PL_RIGHT_ROUND = '';
export const PL_LEFT_ARROW = '';

/** Every non-idle actor state a pill can show; idle actors have no pill. */
export type PillState = 'running' | 'question' | 'approval' | 'queued' | 'paused' | 'failed';
/** Distinct static glyphs (`running` animates through the actor's own frames). */
export const PILL_GLYPHS: Readonly<Record<Exclude<PillState, 'running'>, string>> = {question: '?', approval: '!', queued: '◷', paused: '‖', failed: '✗'};
const PILL_LABELS: Readonly<Record<PillState, string>> = {running: '', question: 'answer', approval: 'approval', queued: 'queued', paused: 'paused', failed: 'failed'};
/** How long a failed actor keeps its pill after it was first seen failing. */
export const FAILED_PILL_MS = 8000;

export interface ActivePillItem {
  readonly id: string;
  readonly ownerId: string;
  readonly name: string;
  readonly icon: string;
  readonly state: PillState;
  readonly bg: string;
  readonly fg: string;
  readonly width: number;
  readonly startX: number;
  readonly endX: number;
  readonly frames?: readonly string[] | undefined;
  /** The label is dropped (glyph only) when the pills would not fit beside the status line. */
  readonly compact: boolean;
}
export interface PillOptions {
  /** Owners with a pending interaction: a waiting actor shows `?` (question) or `!` (approval). */
  readonly asking?: ReadonlyMap<string, 'question' | 'permission'>;
  /** Activity id -> time it was first seen failed; failed pills disappear `FAILED_PILL_MS` later. */
  readonly failedSince?: ReadonlyMap<string, number>;
  /** Cells the pills may use; defaults to the container width. Overflow compacts, then drops the oldest. */
  readonly maxWidth?: number;
}
const rank: Readonly<Record<PillState, number>> = {question: 0, approval: 0, running: 1, paused: 2, queued: 3, failed: 4};

function pillState(activity: any, options: PillOptions, now: number): PillState | undefined {
  if (activity.status === 'running') return 'running';
  if (activity.status === 'waiting_input') return options.asking?.get(activity.ownerId) === 'permission' ? 'approval' : 'question';
  if (activity.status === 'paused') return 'paused';
  if (activity.status === 'queued') return 'queued';
  if (activity.status === 'failed') {
    const seen = options.failedSince?.get(activity.activityId);
    return seen !== undefined && now - seen < FAILED_PILL_MS ? 'failed' : undefined;
  }
}

export function computeActivePills(
  activities: readonly any[],
  sessionId: string,
  roles: ActorStyles = {},
  now: number = Date.now(),
  containerWidth: number = 80,
  activationOrder: readonly string[] = [],
  options: PillOptions = {},
): ActivePillItem[] {
  // The failed hold is measured on the wall clock; callers animate with a synthetic `now`, so they pass failedSince in the same clock.
  const clock = options.failedSince ? Date.now() : now;
  // One pill per actor: its most urgent state wins (asking, running, paused, queued, recently failed).
  const owners = new Map<string, {activity: any; state: PillState}>();
  for (const activity of activities) {
    if (activity.sessionId !== sessionId || !activity.ownerId || activity.ownerId === 'logox' || activity.kind === 'anamnesis') continue;
    const state = pillState(activity, options, clock);
    if (!state) continue;
    const known = owners.get(activity.ownerId);
    if (!known || rank[state] < rank[known.state]) owners.set(activity.ownerId, {activity, state});
  }
  if (owners.size === 0) return [];

  // Sort by activation order: earlier actors appear first, newer actors appear later (docked to the right)
  const sorted = [...owners.entries()].sort(([ownerA], [ownerB]) => {
    const idxA = activationOrder.indexOf(ownerA);
    const idxB = activationOrder.indexOf(ownerB);
    if (idxA >= 0 && idxB >= 0) return idxA - idxB;
    if (idxA >= 0) return -1;
    if (idxB >= 0) return 1;
    return 0;
  });

  const build = (compact: boolean) => sorted.map(([ownerId, {activity, state}]) => {
    const role = roles[ownerId];
    const frames = role?.thinkingAnimation;
    const icon = state === 'running' ? stepIcon({state: 'running'} as any, now, true, frames) : PILL_GLYPHS[state];
    const name = (role?.name ?? ownerId).toLowerCase();
    const label = PILL_LABELS[state];
    const text = ' ' + icon + (compact ? ' ' : ' ' + name + (label ? ' ' + label : '') + ' ');
    // Pills wear the actor's identity: a faint tint of its colour behind a lightened copy of it; alarms borrow the semantic colour.
    const tone = state === 'approval' || state === 'question' ? palette.warning : state === 'failed' ? palette.error : role?.color;
    const bg = tone ? mixHex(tone, palette.bg, 0.26) : palette.actorPillBg;
    const fg = tone ? mixHex(tone, palette.strong, 0.85) : palette.actorPillFg;
    return {id: activity.activityId as string, ownerId, name, icon, state, bg, fg, width: stringWidth(text), frames, compact, startX: 0, endX: 0};
  });
  // Starship bar total width: left cap + widths + one arrow between pills + right cap.
  const widthOf = (items: readonly {width: number}[]) => items.length ? 2 + items.reduce((sum, p, i) => sum + p.width + (i > 0 ? 1 : 0), 0) : 0;
  const limit = Math.max(0, Math.min(options.maxWidth ?? containerWidth, containerWidth));
  let raw = build(false);
  if (widthOf(raw) > limit) raw = build(true);
  // Still too wide: the newest actors matter most, so the oldest pills give way first.
  while (raw.length > 0 && widthOf(raw) > limit) raw = raw.slice(1);
  if (raw.length === 0) return [];

  let currentX = Math.max(0, containerWidth - widthOf(raw));
  return raw.map((pill, i) => {
    const startX = currentX;
    const endX = currentX + 1 + pill.width + (i === raw.length - 1 ? 1 : 0);
    currentX = endX;
    return {...pill, startX, endX};
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
  const animated = pills.some(pill => pill.state === 'running');

  React.useEffect(() => {
    if (!animated || process.execArgv.some(arg => arg.startsWith('--test'))) return;
    const timer = setInterval(() => {
      setClock(Date.now());
    }, 200);
    return () => clearInterval(timer);
  }, [pills.length, animated]);

  const n = pills.length;
  const segments: ReactElement[] = [];

  for (let i = 0; i < n; i++) {
    const pill = pills[i]!;
    const isHover = hoveredOwnerId === pill.ownerId;
    const segBg = isHover ? pill.fg : pill.bg;
    const segFg = isHover ? palette.bg : pill.fg;
    const currentIcon = pill.state === 'running' && pill.frames ? stepIcon({state: 'running'} as any, clock, true, pill.frames) : pill.icon;
    const label = PILL_LABELS[pill.state];

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
        {' ' + currentIcon + (pill.compact ? ' ' : ' ' + pill.name + (label ? ' ' + label : '') + ' ')}
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
