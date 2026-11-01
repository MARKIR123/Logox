import {cast} from '../../actors/ensemble.js';
import {deriveActorCardColors} from '../../actors/definitions.js';
import {palette} from './theme.js';

export interface ActivityVerbs {
  readonly search?: readonly string[] | undefined;
  readonly read?: readonly string[] | undefined;
  readonly list?: readonly string[] | undefined;
  readonly browse?: readonly string[] | undefined;
  readonly run?: readonly string[] | undefined;
}
export interface ActorStyle {
  readonly symbol: string;
  readonly name: string;
  readonly title: string;
  readonly color: string;
  readonly cardClosed?: string | undefined;
  readonly cardOpen?: string | undefined;
  readonly thinkingAnimation?: readonly string[] | undefined;
  /** Optional `Gerund/Past` verb pools per tool-group category (see `activity_verbs` in the actor profile). */
  readonly activityVerbs?: ActivityVerbs | undefined;
}
export type ActorStyles = Readonly<Record<string, ActorStyle>>;

/** Read profile-owned identity/surfaces; never overwrite them with system theme data. */
export function ownerSurface(ownerId: string, expanded: boolean, roles: ActorStyles = cast): string | undefined {
  if (ownerId === 'anamnesis') return expanded ? palette.dreamExpanded : palette.dreamCollapsed;
  const role = roles[ownerId];
  if (!role) return undefined;
  const colors = deriveActorCardColors(role.color, role.cardClosed, role.cardOpen);
  return expanded ? colors.open : colors.closed;
}
export function ownerColor(ownerId: string, roles: ActorStyles = cast): string {
  if (ownerId === 'user') return palette.user;
  if (ownerId === 'anamnesis') return palette.anamnesis;
  return roles[ownerId]?.color ?? palette.accent;
}
export function ownerHeader(ownerId: string, roles: ActorStyles = cast): string {
  if (ownerId === 'user') return 'You';
  if (ownerId === 'anamnesis') return 'Anamnesis';
  const actor = roles[ownerId];
  return actor ? `${actor.symbol} ${actor.name}` : ownerId;
}
